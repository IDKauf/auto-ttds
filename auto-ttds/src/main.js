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
    this.startedAt = nowIso(); // review item 1: everything older than this is backlog
    this.pollFailures = 0;
    this.pollDelayMs = opts.poll_interval_s * 1000;
    this.shuttingDown = false;
  }

  knobs() { return this.knobStore.get(); }
  greenCameras() { return listKnob(this.knobs().camera_greenlist); }

  // ---- ingest (spec 6.1) ------------------------------------------------
  async handleEvent(camera, e) {
    const id = String(e.event_id);
    const existing = this.db.getEvent(id);

    // Review item 3: a push-first row has no Ring timestamp or recording status. The poll pass fills
    // those in. It does not decide again, because the push already did.
    if (existing) {
      if (existing.source === 'push' && !existing.ring_created_at) {
        const fresh = eventRow(camera, e, 'push', existing.first_seen_at);
        this.db.updateEvent(id, {
          camera_name: fresh.camera_name,
          ring_created_at: fresh.ring_created_at,
          kind: fresh.kind ?? existing.kind,
          ring_label: fresh.ring_label ?? existing.ring_label,
          ring_labels_json: fresh.ring_labels_json,
          recording_status: fresh.recording_status,
          raw_json: fresh.raw_json,
        });
        log.info(`event ${id} enriched from the poll pass (push arrived first)`);
      }
      return;
    }

    const row = eventRow(camera, e, 'poll', nowIso());
    row.test = this.knobs().test_mode ? 1 : 0; // spec 7.2
    this.db.insertEvent(row);
    log.info(`event ${id} ${camera.name} kind=${row.kind} label=${row.ring_label ?? 'none'}`);
    await this.ha.fireEvent('auto_ttds_event', row);

    // A human on a greenlisted camera stops whatever is running, stale or not (spec 6.6).
    await this.stopIfPerson(row);

    // Review item 1: the first poll after a boot returns the whole backlog. Record it, never fire.
    if (isStale(row, { now: Date.now(), processStartedAt: this.startedAt, staleAfterS: this.opts.stale_after_s })) {
      const decision = {
        event_id: id, at: nowIso(), action: 'skip', reason: 'stale', mode: this.knobs().mode,
        knobs_json: JSON.stringify({ started_at: this.startedAt, ring_created_at: row.ring_created_at, stale_after_s: this.opts.stale_after_s }),
      };
      this.db.upsertDecision(decision);
      await this.ha.fireEvent('auto_ttds_decision', decision);
      log.debug(`decision ${id} skip/stale`);
      return;
    }

    await this.runDecision(id);
  }

  async handlePush(camera, notification) {
    const ding = notification?.data?.event?.ding ?? {};
    const id = ding.id === undefined || ding.id === null ? null : String(ding.id);
    this.db.insertPush({ received_at: nowIso(), camera_id: String(camera.id), raw_json: JSON.stringify(notification) });
    log.info(`push ${camera.name} category=${notification?.android_config?.category ?? '-'} detection=${ding.detection_type ?? '-'}`);
    if (!id) return;
    const known = this.db.hasEvent(id);
    this.db.upsertEvent({
      event_id: id,
      camera_id: String(camera.id),
      camera_name: camera.name ?? null,
      first_seen_at: known ? undefined : nowIso(),
      source: known ? undefined : 'push',
      ring_label: ding.detection_type ?? undefined,
      kind: ding.subtype ?? undefined,
      test: this.knobs().test_mode ? 1 : 0,
    });
    if (String(ding.detection_type ?? '').toLowerCase() === 'human') {
      await this.stopIfPerson({ camera_id: String(camera.id), ring_label: 'human' });
    }
    const uuid = notification?.img?.snapshot_uuid;
    if (uuid && this.greenCameras().includes(String(camera.id))) {
      this.ring.saveSnapshot(camera, id, uuid)
        .then((p) => { if (p) this.db.updateEvent(id, { snapshot_path: p }); })
        .catch(() => {});
    }
    if (!known) this.runDecision(id).catch((err) => log.error(`push decision failed: ${err.message}`));
  }

  // ---- decision (spec 6.2, 6.5, 7) --------------------------------------
  async runDecision(eventId) {
    const event = this.db.getEvent(eventId);
    if (!event) return;
    // Review item 12: 14 state reads, so the README claim that a knob change needs no restart and
    // takes effect on the next decision is literally true. The 30 s loop still feeds the page.
    await this.knobStore.refresh();
    const knobs = this.knobs();
    const verdictRow = this.db.getVerdict(eventId);
    const verdict = verdictRow && !verdictRow.error
      ? { ...verdictRow, is_person: verdictRow.is_person === 1, friendly: verdictRow.friendly === 1 }
      : null;
    const valves = resolveValves(event.camera_id, knobs.valve_map, this.valves.map((v) => v.id));
    const state = { ...this.db.decisionState(), now: Date.now(), program_running: false };

    // Review item 9: decide once with no Rachio call. Only a decision that would otherwise fire is
    // worth a getValve, so every skip path costs zero Rachio requests.
    let result = decide(event, verdict, knobs, state);
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
      mode: result.mode,
      knobs_json: JSON.stringify({ ...knobs, would_suppress: result.wouldSuppress, dry_run: result.dryRun, test: result.test, valves }),
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

  /** Person stop (spec 6.6): a human Ring event cancels the runs on that camera. */
  async stopIfPerson(row) {
    if (String(row.ring_label ?? '').toLowerCase() !== 'human') return 0;
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
      this.db.updateEvent(event.event_id, { frames_json: JSON.stringify(written.map((p) => path.basename(p))) });
      const delayS = Math.round((Date.now() - Date.parse(event.ring_created_at)) / 1000);
      log.info(`clip ready ${event.event_id} after ${delayS}s, ${written.length} frames`);
    }
  }

  // ---- classify (spec 6.4) ----------------------------------------------
  async classifyPass() {
    const knobs = this.knobs();
    const friendlies = listKnob(knobs.friendlies);
    // Review item 4: eligibility is filtered in SQL, so ineligible rows cannot fill the window.
    for (const event of this.db.eventsAwaitingVerdict(this.greenCameras(), 5)) {
      if (this.classifying.has(event.event_id)) continue;
      this.classifying.add(event.event_id);
      try {
        const frames = framePaths(this.opts.data_dir, event.event_id).filter((p) => fs.existsSync(p));
        const snapshot = event.snapshot_path && fs.existsSync(event.snapshot_path) ? [event.snapshot_path] : [];
        const images = frames.length ? frames : snapshot;
        if (!images.length) continue;
        const verdict = await this.classifier.classify(images, friendlies);
        this.db.upsertVerdict({ ...verdict, event_id: event.event_id });
        if (!verdict.error) {
          this.db.addCost(localDayKey(), verdict.input_tokens, verdict.output_tokens, verdict.usd);
          log.info(`verdict ${event.event_id} ${verdict.species} conf=${verdict.confidence} usd=${verdict.usd.toFixed(5)}`);
          if (verdict.is_person === 1) await this.stopActiveRuns('person', { cameraId: event.camera_id });
        } else {
          log.warning(`verdict ${event.event_id} failed: ${verdict.error}`);
        }
        await this.afterVerdict(event, verdict, friendlies);
      } finally {
        this.classifying.delete(event.event_id);
      }
    }
  }

  /**
   * afterVerdict: classifier_wait re-decides (spec 6.5). Immediate mode does not: the run already
   * happened, so a friendly species is recorded on the decision instead (review item 6).
   */
  async afterVerdict(event, verdict, friendlies) {
    const decision = this.db.getDecision(event.event_id);
    if (!decision) return;
    if (decision.action === 'defer') { await this.runDecision(event.event_id); return; }
    if (decision.mode !== 'immediate' || verdict.error) return;
    const species = String(verdict.species ?? '').toLowerCase();
    const friendly = verdict.friendly === 1 || (species !== '' && friendlies.map((f) => f.toLowerCase()).includes(species));
    if (!friendly) return;
    this.db.patchDecisionKnobs(event.event_id, { would_suppress: 1, friendly_species: species || null });
    log.info(`verdict ${event.event_id} is a friendly (${species}); decision recorded as would_suppress`);
  }

  /** Deferred events whose classifier wait expired (spec 6.5). */
  async deferPass() {
    for (const event of this.db.deferredEvents()) await this.runDecision(event.event_id);
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

    await this.knobStore.refresh();

    this.classifier = new Classifier({
      client: new Anthropic({ apiKey: this.opts.anthropic_api_key }),
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
      loop(10000, () => this.deferPass(), 'defer'),
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
