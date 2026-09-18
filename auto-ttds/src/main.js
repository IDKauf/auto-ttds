// main.js: boot and the running loops (spec 6). Options come straight from /data/options.json,
// so this container needs no bashio and no run.sh wrapper.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { RingApi } from 'ring-client-api';
import { readOptions, KnobStore } from './config.js';
import { log, setLogLevel } from './log.js';
import { Db, localDayStartIso, localDayKey, localMonthKey } from './db.js';
import { Ha, healthAttributes, healthState } from './ha.js';
import { Rachio, readRachioKey } from './rachio.js';
import { Classifier, framePaths } from './classifier.js';
import { decide, resolveValves, isStale } from './decide.js';
import { RingIngest, eventRow, extractFrames, migrate, framePathFor } from './ring.js';
import { createServer } from './server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/** Poll backoff: 5, 10, 20, 40, 80, then capped at 120 seconds (review item 15). */
export function backoffMs(consecutiveFailures) {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(120000, 5000 * 2 ** (consecutiveFailures - 1));
}

const listKnob = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * framesPatch: the events patch for a clip whose frames have just been extracted (v0.4).
 * Pure, so the rule is testable without ffmpeg.
 *
 * image_source records the image the classifier will actually read, so a clip that lands after a
 * snapshot already decided the event never rewrites how that decision was reached, and a clip that
 * produced no frames claims nothing.
 */
export function framesPatch(event, frameNames, at) {
  const patch = { frames_json: JSON.stringify(frameNames ?? []) };
  if ((frameNames ?? []).length && !event?.image_source && !event?.snapshot_path) {
    patch.image_source = 'clip_frames';
    patch.image_ready_at = at;
  }
  return patch;
}

/**
 * The Anthropic client (fix 1). The SDK defaults are a 600 s timeout and two retries, so a single
 * bad call could hold the classifier for minutes. One bounded attempt per call here; classify()
 * still makes its own single retry, which is the behavior v0.3 shipped.
 */
export const CLASSIFIER_TIMEOUT_MS = 20000;

export function classifierClient(apiKey) {
  return new Anthropic({ apiKey, timeout: CLASSIFIER_TIMEOUT_MS, maxRetries: 0 });
}

/** Ring says human. That is the one label that decides anything, and it costs no classifier call. */
const isHumanLabel = (label) => String(label ?? '').trim().toLowerCase() === 'human';

/**
 * The verdict decide() is handed when Ring itself called the event a person. It is not written to
 * the verdicts table: nothing was classified, and nothing should look as though it was.
 */
const RING_PERSON_VERDICT = { species: 'person', is_person: true, source: 'ring' };

class App {
  constructor(opts) {
    this.opts = opts;
    this.db = new Db(path.join(opts.data_dir, 'auto-ttds.db'));
    this.ha = new Ha({});
    this.knobStore = new KnobStore(this.ha);
    this.healthRef = { value: null };
    this.activeRuns = new Map(); // event_id -> {camera_id, stop, valves:[{runId, valveId}], stopSent:Set}
    this.valves = [];
    this.baseStationId = null;
    this.classifying = new Set();
    // Fix 1: work the poll loop must never wait on. ring.poll() walks a batch of events serially,
    // so anything slow awaited from handleEvent delays every later event in that batch, including
    // a human one that has to stop the water.
    this.detached = new Set();
    // Fix 2: the last time a person was seen on each camera, as epoch ms. A run refuses to start
    // while that is recent, because stopActiveRuns can only stop a run that has already started.
    this.lastHumanAt = new Map();
    this.startedAt = nowIso(); // review item 1: everything older than this is backlog
    this.pollFailures = 0;
    this.pollDelayMs = opts.poll_interval_s * 1000;
    this.shuttingDown = false;
  }

  knobs() { return this.knobStore.get(); }
  greenCameras() { return listKnob(this.knobs().camera_greenlist); }

  /**
   * detach: run a job off the caller's clock (fix 1). Errors are logged, never thrown at the poll
   * loop, and the promise is tracked so shutdown and the tests can wait for it.
   */
  detach(name, fn) {
    const job = Promise.resolve()
      .then(fn)
      .catch((err) => log.error(`${name} failed: ${err.message}`))
      .finally(() => this.detached.delete(job));
    this.detached.add(job);
    return job;
  }

  /** settle: wait for every detached job, including jobs those jobs started. */
  async settle() {
    while (this.detached.size) await Promise.all([...this.detached]);
  }

  /** markHuman: a person was just seen on this camera (fix 2). */
  markHuman(cameraId, at = Date.now()) {
    if (cameraId === null || cameraId === undefined) return;
    this.lastHumanAt.set(String(cameraId), at);
  }

  /**
   * humanSeenRecently: was a person seen on this camera inside the window a run would cover?
   *
   * The stop-on-human path can only stop a run that is already in activeRuns. A human push that
   * lands seconds before an animal classification finishes would otherwise start the water with the
   * person still in frame and nothing left to stop it. The window is run_seconds, the length of the
   * run that would start, so the guard covers exactly the time that water would be on.
   */
  humanSeenRecently(cameraId, runSeconds, now = Date.now()) {
    const at = this.lastHumanAt.get(String(cameraId));
    if (at === undefined) return false;
    const windowMs = Math.max(0, Number(runSeconds) || 60) * 1000;
    return now - at < windowMs;
  }

  // ---- ingest (spec 6.1) ------------------------------------------------
  async handleEvent(camera, e) {
    const id = String(e.event_id);
    const existing = this.db.getEvent(id);

    if (existing) {
      await this.enrich(existing, camera, e);
      return;
    }

    const row = eventRow(camera, e, 'poll', nowIso());
    row.test = this.knobs().test_mode ? 1 : 0;
    this.db.insertEvent(row);
    log.info(`event ${id} ${camera.name} kind=${row.kind} label=${row.ring_label ?? 'none'}`);
    await this.ha.fireEvent('auto_ttds_event', row);

    // A human on a greenlisted camera stops whatever is running, stale or not (spec 6.6).
    await this.stopIfPerson(row);

    // Review item 1: the first poll after a boot returns the whole backlog. Record it, never fire.
    if (isStale(row, { now: Date.now(), processStartedAt: this.startedAt, staleAfterS: this.opts.stale_after_s })) {
      await this.recordSkip(id, 'stale', {
        started_at: this.startedAt, ring_created_at: row.ring_created_at, stale_after_s: this.opts.stale_after_s,
      });
      return;
    }

    await this.triage(row);
  }

  /**
   * triage: what happens to a brand new event, v0.4.
   * Nothing here decides to fire. Only a classification can do that.
   * 1. A camera off the greenlist is decided now and never classified: that is the cost control.
   * 2. Ring calling it human is decided now as skip/person, and costs no classifier call either.
   * 3. Everything else is classified from whatever image exists, and decided when the verdict lands.
   *    On the poll path that classification is detached, see below.
   */
  async triage(row) {
    const id = String(row.event_id);
    if (!this.greenCameras().includes(String(row.camera_id))) {
      await this.runDecision(id, null); // decide() stops at the greenlist before it reads a species
      return;
    }
    if (isHumanLabel(row.ring_label)) {
      await this.runDecision(id, RING_PERSON_VERDICT);
      return;
    }
    // Fix 1: on the poll path the classification runs detached. ring.poll() awaits onEvent for
    // every event in a batch in turn, so a classifier call that sits on its own timeout and retry
    // would hold up every later event in that batch. The one that must never wait is a human
    // event, which has to reach stopIfPerson while the water is on.
    if (String(row.source) === 'poll') {
      this.detach(`classify ${id}`, () => this.classifyEvent(id));
      return;
    }
    // No decision yet. The push snapshot or the clip path (media loop) feeds the classifier, and
    // classifyEvent decides as soon as it has an answer.
    await this.classifyEvent(id);
  }

  /** A decision no knob can change: the event is too old, or nothing could be classified. */
  async recordSkip(eventId, reason, detail = {}) {
    const decision = {
      event_id: eventId, at: nowIso(), action: 'skip', reason, knobs_json: JSON.stringify(detail),
    };
    this.db.upsertDecision(decision);
    await this.ha.fireEvent('auto_ttds_decision', decision);
    log.info(`decision ${eventId} skip/${reason}`);
  }

  /**
   * enrich: the poll pass carries what a push cannot, so the row gains the fields a push never had.
   * Review item 3 keeps the push row's provenance and first_seen_at. Enrichment decides nothing: in
   * v0.3 only a classification does that. A label that turns out to be human still stops a run that
   * is already going, and the poll data is what lets the media loop fetch the clip.
   */
  async enrich(existing, camera, e) {
    const id = String(existing.event_id);
    const fresh = eventRow(camera, e, existing.source, existing.first_seen_at);
    const next = {
      camera_name: fresh.camera_name ?? existing.camera_name,
      ring_created_at: fresh.ring_created_at ?? existing.ring_created_at,
      kind: fresh.kind ?? existing.kind,
      ring_label: fresh.ring_label ?? existing.ring_label,
      ring_labels_json: fresh.ring_labels_json,
      recording_status: fresh.recording_status ?? existing.recording_status,
      raw_json: fresh.raw_json,
    };
    const patch = Object.fromEntries(Object.entries(next).filter(([k, v]) => (v ?? null) !== (existing[k] ?? null)));
    if (Object.keys(patch).length) {
      this.db.updateEvent(id, patch);
      log.info(`event ${id} enriched from the poll pass (${Object.keys(patch).join(', ')})`);
    }

    const before = existing.ring_label ?? null;
    const after = next.ring_label ?? null;
    if (String(before ?? '') !== String(after ?? '') && isHumanLabel(after)) {
      await this.stopIfPerson({ camera_id: existing.camera_id, ring_label: 'human' });
      // A label that turns human before anything was decided is still the free answer, and the
      // event is now out of the classifier queue, so this is the one decision enrichment writes.
      if (!this.db.getDecision(id) && !this.db.getVerdict(id)) {
        await this.runDecision(id, RING_PERSON_VERDICT);
      }
    }
  }

  async handlePush(camera, notification) {
    const ding = notification?.data?.event?.ding ?? {};
    const id = ding.id === undefined || ding.id === null ? null : String(ding.id);
    this.db.insertPush({ received_at: nowIso(), camera_id: String(camera.id), raw_json: JSON.stringify(notification) });
    log.info(`push ${camera.name} category=${notification?.android_config?.category ?? '-'} detection=${ding.detection_type ?? '-'}`);
    const human = isHumanLabel(ding.detection_type);
    // Fix 4: the stop comes before the id guard. A push that carries no ding id still carries the
    // fact that a person is at the camera, and that fact is what closes a valve. Nothing below
    // this point can run without an id, so a person would otherwise be silently dropped.
    if (human) {
      this.markHuman(String(camera.id));
      await this.stopIfPerson({ camera_id: String(camera.id), ring_label: 'human' });
    }
    if (!id) return;
    const existing = this.db.getEvent(id);
    const known = Boolean(existing);
    this.db.upsertEvent({
      event_id: id,
      camera_id: String(camera.id),
      camera_name: camera.name ?? null,
      first_seen_at: known ? undefined : nowIso(),
      source: known ? undefined : 'push',
      // The push enum has no animal value, so it must never overwrite a label the poll already has.
      // Fix 3: human is the exception. A person arriving late is the one signal that must always
      // win, because every downstream guard reads the stored label.
      ring_label: human ? 'human' : (existing?.ring_label ?? ding.detection_type ?? undefined),
      kind: ding.subtype ?? undefined,
      test: this.knobs().test_mode ? 1 : 0,
    });
    if (human) {
      // The decision is only written when nothing has decided this event yet, so a push never
      // rewrites a decision the pipeline already made.
      if (!this.db.getDecision(id)) await this.runDecision(id, RING_PERSON_VERDICT);
      return;
    }
    if (this.db.getDecision(id) || this.db.getVerdict(id)) return; // already handled

    // The push snapshot is the fastest image there is: seconds, against minutes for the clip. It is
    // what makes a classify-first pipeline quick enough to be worth water (spec 3a).
    const uuid = notification?.img?.snapshot_uuid;
    const row = this.db.getEvent(id);
    if (uuid && !row?.snapshot_path && this.greenCameras().includes(String(camera.id))) {
      try {
        const p = await this.ring.saveSnapshot(camera, id, uuid);
        if (p) this.db.updateEvent(id, { snapshot_path: p, image_source: 'push_snapshot', image_ready_at: nowIso() });
      } catch (err) {
        log.debug(`snapshot for ${id} failed: ${err.message}`);
      }
    }
    // A row the poll already inserted has been triaged once, so it only needs the classifier.
    if (known) await this.classifyEvent(id);
    else await this.triage(this.db.getEvent(id) ?? { event_id: id, camera_id: String(camera.id), source: 'push' });
  }

  // ---- decision ---------------------------------------------------------
  /**
   * runDecision(eventId, verdict): the only place a decision row is written by decide().
   *
   * v0.3: the caller brings the verdict, because the classification is what decides. There are
   * three kinds of caller: a camera off the greenlist (verdict null, decide() stops at the
   * greenlist before it reads a species), a Ring human label (RING_PERSON_VERDICT, from the poll or
   * the push), and a finished classification.
   */
  async runDecision(eventId, verdict) {
    // Review item 12: 14 state reads, so the README claim that a knob change needs no restart and
    // takes effect on the next decision is literally true. The 30 s loop still feeds the page.
    await this.knobStore.refresh();
    // The row is read after that await, never before, so a decision is always made on the row as it
    // stands once the knobs are in hand rather than on a copy an enrichment has already replaced.
    // No await stands between this read and upsertDecision on any skip path.
    const event = this.db.getEvent(eventId);
    if (!event) return;
    // Read alongside the row, for the person guard below. A classify() call can be in flight for up
    // to about 70 s (a 20 s request, a 30 s sleep, a second 20 s request), and the label or the
    // decision can change under it in that time.
    const prior = this.db.getDecision(eventId);
    const knobs = this.knobs();
    const valves = resolveValves(event.camera_id, knobs.valve_map, this.valves.map((v) => v.id));
    const state = { ...this.db.decisionState(), now: Date.now(), program_running: false };

    // Review item 9: decide once with no Rachio call. Only a decision that would otherwise fire is
    // worth a getValve, so every skip path costs zero Rachio requests.
    let result = decide(event, verdict, knobs, state);

    // Fix 5: staleness is checked again here, not only at insert. An event can sit in the queue for
    // half an hour waiting for a clip, and firing at an animal that has long gone wastes water and
    // is the opposite of what this add-on is for. Same stale_after_s option, no new knob. Only a
    // fire is converted, so every decide() reason stays exactly as decide() wrote it.
    if (result.action === 'fire' && isStale(event, {
      now: state.now, processStartedAt: this.startedAt, staleAfterS: this.opts.stale_after_s,
    })) {
      const ageS = Math.round((state.now - Date.parse(event.ring_created_at ?? event.first_seen_at)) / 1000);
      log.warning(`refusing to fire ${eventId}: the event is ${ageS} s old, past stale_after_s`);
      result = { ...result, action: 'skip', reason: 'stale' };
    }

    // Blocker fix: the event is a person, whatever this verdict says. A push can start a classify,
    // the poll can then enrich the label to human and write skip/person, and the verdict can land
    // a minute later. Without this the decision would flip to fire and open a valve on a person.
    // lastHumanAt cannot cover it: that window is run_seconds, shorter than the classifier's worst
    // case. This reads the row and the decision as they stand now, which is the durable record.
    if (result.action === 'fire' && (isHumanLabel(event.ring_label) || prior?.reason === 'person')) {
      log.warning(`refusing to fire ${eventId}: it is recorded as a person, so this verdict is stale`);
      result = { ...result, action: 'skip', reason: 'person' };
    }

    // Fix 2: a person seen on this camera within the run that is about to start. stopActiveRuns
    // cannot reach a run that has not started, so this is the only place that sequence is caught.
    if (result.action === 'fire' && this.humanSeenRecently(event.camera_id, knobs.run_seconds, state.now)) {
      log.warning(`refusing to fire ${eventId}: a person was seen on camera ${event.camera_id} moments ago`);
      result = { ...result, action: 'skip', reason: 'person' };
    }

    if (result.action === 'fire' && knobs.skip_when_program_running !== false && valves.length) {
      if (await this.programRunning(valves)) {
        result = decide(event, verdict, knobs, { ...state, program_running: true });
      }
    }
    for (const w of result.warnings) log.warning(w); // spec 7.10

    const decision = {
      event_id: eventId,
      at: nowIso(),
      action: result.action,
      reason: result.reason,
      knobs_json: JSON.stringify({
        ...knobs,
        dry_run: result.dryRun,
        test: result.test,
        valves,
        species: verdict?.species ?? null,
        verdict_source: verdict?.source ?? (verdict ? 'classifier' : null),
      }),
    };
    this.db.upsertDecision(decision);
    if (result.test) this.db.updateEvent(eventId, { test: 1 });
    await this.ha.fireEvent('auto_ttds_decision', decision);
    log.info(`decision ${eventId} ${result.action}/${result.reason}${result.dryRun ? ' (dry run)' : ''}`);

    if (result.action !== 'fire') return;
    if (!valves.length) { log.warning(`no valves mapped for camera ${event.camera_id}; nothing to run`); return; }
    if (this.db.runsForEvent(eventId).length) return; // never run an event twice
    // Review item 2: fire and forget. Awaiting it here would block the poll loop for the whole run,
    // which is exactly when a human event needs to get through and stop the water.
    this.fire(event, valves, knobs, result).catch((err) => log.error(`run for ${eventId} failed: ${err.message}`));
  }

  async programRunning(valveIds) {
    if (!this.rachio || !valveIds.length) return false;
    try { return await this.rachio.programRunning(valveIds); } catch { return false; }
  }

  // ---- run (spec 6.6) ---------------------------------------------------
  async fire(event, valveIds, knobs, result) {
    const seconds = Math.round(Number(knobs.run_seconds) || 60);
    const tracker = { camera_id: event.camera_id, stop: false, valves: [], stopSent: new Set() };
    this.activeRuns.set(event.event_id, tracker);

    // v0.4 spec D.2: the one number that says whether this is fast enough. It is measured at the
    // moment the first real startWatering leaves this process, so it holds everything the add-on
    // controls and none of the eight seconds the valve hardware takes to acknowledge. A dry run
    // issues no call, so it records nothing.
    const markTriggered = () => {
      const created = Date.parse(event.ring_created_at ?? event.first_seen_at);
      if (!Number.isFinite(created)) return;
      const ms = Date.now() - created;
      if (ms >= 0) this.db.setTriggerLatency(event.event_id, ms);
    };

    const jobs = valveIds.map(async (valveId) => {
      const valveName = this.valves.find((v) => v.id === valveId)?.name ?? null;
      const base = {
        event_id: event.event_id, valve_id: valveId, valve_name: valveName, requested_s: seconds,
        called_at: nowIso(), dry_run: result.dryRun ? 1 : 0,
      };
      if (result.dryRun) { // spec 6.6: dry run writes the row and makes no HTTP call
        const runId = this.db.insertRun(base);
        await this.ha.fireEvent('auto_ttds_run', this.db.getRun(runId));
        return;
      }
      const runId = this.db.insertRun(base);
      tracker.valves.push({ runId, valveId });
      markTriggered(); // setTriggerLatency only writes once, so the first valve is the one timed
      try {
        await this.rachio.startAndConfirm(valveId, seconds, {
          onCalled: (patch) => this.db.updateRun(runId, patch),
          onConfirmed: (patch) => this.db.updateRun(runId, patch),
          onCleared: (patch) => this.db.updateRun(runId, patch),
          onError: (message) => this.db.updateRun(runId, { error: message }),
          shouldStop: () => tracker.stop,
        });
      } catch (err) {
        this.db.updateRun(runId, { error: err.message, cleared_at: nowIso() });
      }
      await this.ha.fireEvent('auto_ttds_run', this.db.getRun(runId));
    });

    await this.ha.setState('binary_sensor.auto_ttds_run_active', 'on', { event_id: event.event_id });
    try {
      await Promise.all(jobs);
    } finally {
      this.activeRuns.delete(event.event_id);
      if (!this.activeRuns.size) await this.ha.setState('binary_sensor.auto_ttds_run_active', 'off', {});
    }
  }

  /** One stopWatering per valve per run, whoever asks for it first (review item 2). */
  async sendStop(tracker, valveId) {
    if (tracker.stopSent.has(valveId)) return;
    tracker.stopSent.add(valveId);
    if (!this.rachio) return;
    try { await this.rachio.stopWatering(valveId); } catch (err) { log.error(`stopWatering ${valveId}: ${err.message}`); }
  }

  /**
   * stopActiveRuns: close the valves now, do not wait for the 2 s confirm poll to notice
   * (review item 2). reason becomes runs.stopped_by.
   */
  async stopActiveRuns(reason, { cameraId = null } = {}) {
    const jobs = [];
    for (const [eventId, tracker] of this.activeRuns) {
      if (cameraId !== null && String(tracker.camera_id) !== String(cameraId)) continue;
      tracker.stop = reason;
      for (const { runId, valveId } of tracker.valves) {
        this.db.updateRun(runId, { stopped_by: reason });
        jobs.push(this.sendStop(tracker, valveId));
      }
      log.info(`stopping the run for ${eventId}: ${reason}`);
    }
    await Promise.all(jobs);
    return jobs.length;
  }

  /**
   * Person stop (spec 6.6): a human Ring event cancels the runs on that camera.
   * It also records the sighting, so a fire that has not started yet is refused too (fix 2).
   */
  async stopIfPerson(row) {
    if (String(row.ring_label ?? '').toLowerCase() !== 'human') return 0;
    this.markHuman(row.camera_id);
    return this.stopActiveRuns('person', { cameraId: row.camera_id });
  }

  // ---- media (spec 6.3) -------------------------------------------------
  async mediaPass() {
    // Review item 8: only greenlisted cameras cost bandwidth, disk and ffmpeg time. Ignored cameras
    // stay in the events table and nothing more.
    for (const event of this.db.eventsAwaitingClip(this.greenCameras(), 15)) {
      const camera = this.ring.camera(event.camera_id);
      if (!camera) continue;
      let clip = null;
      try { clip = await this.ring.downloadClip(camera, event); } catch (err) { log.debug(`clip ${event.event_id}: ${err.message}`); }
      if (!clip) continue;
      this.db.updateEvent(event.event_id, { clip_path: clip, clip_ready_at: nowIso() });
      const written = await extractFrames(clip, this.opts.data_dir, event.event_id);
      // Re-read, because the download and the extraction both took time and a snapshot may have
      // landed on this row in the meantime. The image that decided the event keeps the credit.
      const current = this.db.getEvent(event.event_id) ?? event;
      this.db.updateEvent(event.event_id, framesPatch(current, written.map((p) => path.basename(p)), nowIso()));
      const delayS = Math.round((Date.now() - Date.parse(event.ring_created_at)) / 1000);
      log.info(`clip ready ${event.event_id} after ${delayS}s, ${written.length} frames`);
    }
  }

  // ---- classify, then decide (spec 6.4, v0.3 flow) ----------------------
  /**
   * The images for one event, fastest first.
   *
   * A snapshot, whether it came with a push uuid or from a live request, is one image and that is
   * all the classifier gets: it is a single moment, so a second copy of it would buy nothing and
   * cost tokens and time. The clip fallback keeps all three frames at 1, 3 and 6 s, where the extra
   * frames cost no extra wall-clock, because the clip is already on disk, and they catch an animal
   * that walks into view late (spec B).
   */
  imagesFor(event) {
    if (event.snapshot_path && fs.existsSync(event.snapshot_path)) return [event.snapshot_path];
    return framePaths(this.opts.data_dir, event.event_id).filter((p) => fs.existsSync(p));
  }

  async classifyPass() {
    // Review item 4: eligibility is filtered in SQL, so ineligible rows cannot fill the window.
    for (const event of this.db.eventsAwaitingVerdict(this.greenCameras(), 5)) {
      await this.classifyEvent(event.event_id);
    }
  }

  /**
   * classifyEvent: classify what images exist, then decide from the result and nothing else.
   * An event with no image yet is left alone; the media loop will bring frames and this runs again.
   * A classifier failure that outlived its one retry is a skip, never a run: the system does not
   * water the yard on a guess.
   */
  async classifyEvent(eventId) {
    if (this.classifying.has(eventId)) return;
    const event = this.db.getEvent(eventId);
    if (!event) return;
    if (this.db.getVerdict(eventId) || this.db.getDecision(eventId)) return;
    const images = this.imagesFor(event);
    if (!images.length) {
      // A row can name frames that are not on disk, for example media deleted underneath us. Such a
      // row has no verdict and no decision, so it would sit at the front of the verdict queue for
      // good and starve every newer event. Once it is past stale_after_s no image is coming and it
      // could not fire anyway, so it is closed out here.
      if (isStale(event, { now: Date.now(), processStartedAt: this.startedAt, staleAfterS: this.opts.stale_after_s })) {
        await this.recordSkip(eventId, 'classifier_error', {
          error: 'no image ever arrived', frames_json: event.frames_json ?? null, snapshot_path: event.snapshot_path ?? null,
        });
      }
      return;
    }

    this.classifying.add(eventId);
    try {
      const verdict = await this.classifier.classify(images, listKnob(this.knobs().friendlies));
      this.db.upsertVerdict({ ...verdict, event_id: eventId });
      if (verdict.error) {
        log.warning(`verdict ${eventId} failed: ${verdict.error}`);
        await this.recordSkip(eventId, 'classifier_error', { error: verdict.error, images: images.length });
        return;
      }
      this.db.addCost(localDayKey(), verdict.input_tokens, verdict.output_tokens, verdict.usd);
      log.info(`verdict ${eventId} ${verdict.species} conf=${verdict.confidence} usd=${verdict.usd.toFixed(5)}`);
      if (verdict.is_person === 1) {
        this.markHuman(event.camera_id); // fix 2: the classifier seeing a person counts as a sighting
        await this.stopActiveRuns('person', { cameraId: event.camera_id });
      }
      await this.runDecision(eventId, { ...verdict, is_person: verdict.is_person === 1, source: 'classifier' });
    } finally {
      this.classifying.delete(eventId);
    }
  }

  // ---- poll with backoff (spec 6.8, review item 15) ---------------------
  async pollPass() {
    const ok = await this.ring.poll(20);
    if (ok) {
      if (this.pollFailures) log.info('Ring polling recovered');
      this.pollFailures = 0;
      this.pollDelayMs = this.opts.poll_interval_s * 1000;
      return;
    }
    this.pollFailures += 1;
    this.pollDelayMs = backoffMs(this.pollFailures);
    log.warning(`poll failed ${this.pollFailures} times in a row; next attempt in ${Math.round(this.pollDelayMs / 1000)} s`);
    if (this.pollFailures % 3 === 0) {
      try { await this.ring.restart(); } catch (err) { log.error(`Ring reconnect failed: ${err.message}`); }
    }
  }

  // ---- HA surface (spec 6.7) --------------------------------------------
  async publishHealth() {
    const attrs = healthAttributes({
      pushConnected: this.ring?.pushConnected ?? false,
      lastPollOk: this.ring?.lastPollOk ?? false,
      ringTokenAgeHours: this.ring?.tokenAgeHours?.() ?? null,
      rachioError: this.rachio?.lastAuthError ?? null,
      lastPollAt: this.ring?.lastPollAt ?? null,
    });
    this.healthRef.value = { state: healthState(attrs), ...attrs };
    const last = this.db.listEvents({ limit: 1 })[0];
    await this.ha.setState('sensor.auto_ttds_health', healthState(attrs), attrs);
    await this.ha.setState('sensor.auto_ttds_runs_today', this.db.countSince('runs', 'called_at', localDayStartIso()), {});
    await this.ha.setState('sensor.auto_ttds_spend_usd_month', (this.db.spendForMonth(localMonthKey()).usd ?? 0).toFixed(4), { unit_of_measurement: 'USD' });
    await this.ha.setState('sensor.auto_ttds_last_event', last?.ring_created_at ?? 'none', {
      camera: last?.camera_name ?? null, ring_label: last?.ring_label ?? null, species: last?.species ?? null,
    });
  }

  // ---- boot -------------------------------------------------------------
  async start() {
    fs.mkdirSync(path.join(this.opts.data_dir, 'clips'), { recursive: true });
    fs.mkdirSync(path.join(this.opts.data_dir, 'frames'), { recursive: true });

    // spec 5: import the probe's events and clips, idempotently, on every boot.
    const migrated = migrate(this.db, {
      eventsJsonl: this.opts.migrate_events_jsonl,
      clipsDir: this.opts.migrate_clips_dir,
      dataDir: this.opts.data_dir,
    });
    if (migrated.ran) log.info(`migration: ${migrated.events} new events, ${migrated.skipped} already present, ${migrated.clips} clips copied`);
    const backfilled = this.db.migrations?.should_have_fired_backfilled ?? 0;
    if (backfilled) log.info(`schema upgrade: ${backfilled} v0.1 label(s) carried over into should_have_fired`);

    await this.knobStore.refresh();

    this.classifier = new Classifier({
      client: classifierClient(this.opts.anthropic_api_key),
      model: this.opts.classifier_model,
    });

    try {
      this.rachio = new Rachio({ apiKey: readRachioKey(this.opts.rachio_env_file) });
      const found = await this.rachio.discover();
      this.valves = found.valves;
      this.baseStationId = found.baseStationId;
      log.info(`Rachio: base station ${found.baseStationId ?? 'none'}, ${this.valves.length} valves`);
    } catch (err) {
      log.error(`Rachio setup failed: ${err.message}`);
      this.rachio = null;
    }

    this.ring = new RingIngest({
      tokenFile: this.opts.ring_token_file,
      systemIdFile: this.opts.ring_system_id_file,
      dataDir: this.opts.data_dir,
      apiFactory: async (cfg) => new RingApi(cfg),
      onEvent: (camera, e) => this.handleEvent(camera, e),
      onPush: (camera, n) => this.handlePush(camera, n),
    });
    await this.ring.start();

    const server = createServer({
      db: this.db, dataDir: this.opts.data_dir, knobStore: this.knobStore, healthRef: this.healthRef,
    });
    server.listen(8099, '0.0.0.0', () => log.info('review page listening on 8099 (ingress)'));
    this.server = server;

    this.loops = [
      loop(() => this.pollDelayMs, () => this.pollPass(), 'poll'),
      loop(10000, () => this.mediaPass(), 'media'),
      loop(10000, () => this.classifyPass(), 'classify'),
      loop(30000, () => this.knobStore.refresh(), 'knobs'),
      loop(60000, () => this.publishHealth(), 'health'),
      loop(30000, async () => fs.writeFileSync(path.join(this.opts.data_dir, 'heartbeat'), nowIso()), 'heartbeat'),
    ];
  }

  /**
   * shutdown: close any open valve before the container dies (spec 6.8, review item 15).
   * Best effort with a 5 s cap, because the Supervisor will not wait long.
   */
  async shutdown(stopTimeoutMs = 5000) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const l of this.loops ?? []) l.stop();
    if (this.activeRuns.size) {
      log.warning(`shutting down with ${this.activeRuns.size} run(s) active; closing the valves`);
      // The cap timer is unref'd, so winning the race lets the process exit at once instead of
      // idling for the rest of the timeout.
      const cap = new Promise((r) => { const t = setTimeout(r, stopTimeoutMs); t.unref?.(); });
      await Promise.race([this.stopActiveRuns('shutdown'), cap]);
    }
    // Detached classify work must not be left writing to a database this is about to close.
    // Bounded, because the Supervisor will not wait long either.
    const settled = new Promise((r) => { const t = setTimeout(r, 2000); t.unref?.(); });
    await Promise.race([this.settle(), settled]);
    this.server?.close();
    this.ring?.disconnect();
    this.db.close();
  }

  stop() { return this.shutdown(); }
}

/**
 * loop: a self-rescheduling timer that never overlaps itself and never dies on an error.
 * interval may be a number or a function, so the poll loop can back off (review item 15).
 */
function loop(interval, fn, name) {
  let stopped = false;
  const delay = () => (typeof interval === 'function' ? interval() : interval);
  const tick = async () => {
    if (stopped) return;
    try { await fn(); } catch (err) { log.error(`${name} loop: ${err.message}`); }
    if (!stopped) setTimeout(tick, delay()).unref?.();
  };
  setTimeout(tick, 100).unref?.();
  return { stop: () => { stopped = true; } };
}

async function boot() {
  const opts = readOptions();
  setLogLevel(opts.log_level);
  log.info(`auto-ttds starting, model ${opts.classifier_model}, data dir ${opts.data_dir}`);
  if (!opts.anthropic_api_key) log.warning('no Anthropic API key set in the add-on options; classification will fail');
  const app = new App(opts);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      log.info(`${sig} received, shutting down`);
      app.shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
    });
  }
  await app.start();
}

// Only boot when run directly. Importing main.js from a test does nothing.
if (process.argv[1] && process.argv[1].endsWith('main.js')) {
  boot().catch((err) => { log.error(`boot failed: ${err.message}`); process.exit(1); });
}

export { App, boot, loop, sleep, framePathFor };
