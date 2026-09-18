// App wiring: the classify-first pipeline, the boot backlog, the person stop during a live run,
// push snapshots, media gating, lazy Rachio lookups and shutdown. Ring, Rachio and Claude are all
// mocked, and no credential file is read (spec 10.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App, backoffMs, framesPatch, classifierClient, CLASSIFIER_TIMEOUT_MS } from '../src/main.js';
import { Rachio } from '../src/rachio.js';
import { knobDefaults } from '../src/config.js';
import { Db } from '../src/db.js';

const tick = () => new Promise((r) => setImmediate(r));
const iso = (o = 0) => new Date(Date.now() + o).toISOString();
const CAM = { id: 639481050, name: 'Cat Cam' };
const IGNORED = { id: 700809115, name: 'Buddha Cam' };

const ringEvent = (id, over = {}) => ({
  event_id: id,
  ding_id_str: '1',
  created_at: iso(),
  kind: 'motion',
  recording_status: 'ready',
  cv_properties: { detection_type: 'animal', detection_types: [{ detection_type: 'animal' }] },
  ...over,
});

const push = (id, detection, over = {}) => ({
  android_config: { category: 'com.ring.motion' },
  data: { event: { ding: { id, subtype: 'motion', detection_type: detection } } },
  ...over,
});

/** A classifier stub. Every call is recorded, so "it cost nothing" is a real assertion. */
function stubClassifier(app, over = {}) {
  const calls = [];
  app.classifier = {
    calls,
    classify: async (images, friendlies) => {
      calls.push({ images, friendlies });
      return {
        model: 'claude-haiku-4-5', species: 'coyote', count: 1, is_person: 0, friendly: 0,
        confidence: 0.9, input_tokens: 2200, output_tokens: 120, usd: 0.0028, latency_ms: 500,
        at: iso(), error: null, ...over,
      };
    },
  };
  return calls;
}

/** Put a frame on disk for an event, the way the media loop would. */
function giveFrames(app, eventId, seconds = [1]) {
  const dir = path.join(app.opts.data_dir, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  const names = seconds.map((sec) => `${eventId}_t${sec}.jpg`);
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'jpeg');
  app.db.updateEvent(eventId, { frames_json: JSON.stringify(names) });
}

/** An App with a real database in a temp directory and every network edge stubbed. */
function makeApp(knobOver = {}, rachioOver = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttds-app-'));
  const app = new App({
    data_dir: dataDir, poll_interval_s: 10, stale_after_s: 300, classifier_model: 'claude-haiku-4-5',
    anthropic_api_key: '', log_level: 'warning',
  });
  const knobs = { ...knobDefaults(), ...knobOver };
  let refreshes = 0;
  app.knobStore = { get: () => knobs, refresh: async () => { refreshes += 1; return knobs; }, lastRefreshAt: null };
  app.ha = { fireEvent: async () => {}, setState: async () => {}, getStates: async () => ({}) };
  app.valves = [{ id: 'v1', name: 'Hose Sprinkler 1' }, { id: 'v2', name: 'Hose sprinkler 2' }];

  const calls = [];
  const rachioFetch = async (url, opts) => {
    calls.push(`${opts.method} ${url.split('/').slice(3).join('/')}`);
    const watering = rachioOver.watering?.() ?? null;
    const body = url.includes('getValve')
      ? { valve: { detectFlow: false, state: { reportedState: { lastWateringAction: watering } } } }
      : {};
    return { status: 200, ok: true, text: async () => JSON.stringify(body) };
  };
  let clock = 0;
  // hold parks the confirm loop inside its 2 s sleep, which is what "a run is in progress" means
  // for a test with no wall clock.
  let release = () => {};
  const sleepImpl = rachioOver.hold
    ? () => new Promise((r) => { release = r; })
    : async () => {};
  app.rachio = new Rachio({ apiKey: 'test-key', fetchImpl: rachioFetch, sleep: sleepImpl, now: () => (clock += 1000) });
  app.ring = {
    camera: (id) => [CAM, IGNORED].find((c) => String(c.id) === String(id)) ?? null,
    saveSnapshot: async () => null,
    pushConnected: false,
    lastPollOk: true,
  };
  stubClassifier(app);
  return { app, dataDir, calls, knobs, refreshCount: () => refreshes, release: () => release(), cleanup: () => { app.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

/** The whole v0.3 path for one polled event: ingest, then a clip and frames, then classify. */
async function ingestAndClassify(app, camera, event) {
  await app.handleEvent(camera, event);
  giveFrames(app, String(event.event_id));
  await app.classifyPass();
  await tick();
}

// ---- v0.3: the classification decides, and nothing else does ---------------

test('an event has no decision and no run until it has been classified', async () => {
  const { app, calls, cleanup } = makeApp();
  await app.handleEvent(CAM, ringEvent('live'));
  await tick();
  assert.equal(app.db.getDecision('live'), null, 'the Ring label alone decides nothing');
  assert.equal(app.db.runsForEvent('live').length, 0);
  assert.deepEqual(calls, [], 'and it costs no Rachio call while it waits');

  giveFrames(app, 'live');
  await app.classifyPass();
  await tick();
  const decision = app.db.getDecision('live');
  assert.equal(decision.action, 'fire');
  assert.equal(decision.reason, 'target');
  assert.equal(JSON.parse(decision.knobs_json).species, 'coyote');
  assert.equal(JSON.parse(decision.knobs_json).verdict_source, 'classifier');
  assert.equal(app.db.runsForEvent('live').length, 2); // both valves
  cleanup();
});

test('the classifier overrules the Ring label in both directions', async () => {
  // Ring said other_motion, the classifier saw a raccoon: it fires.
  const quiet = makeApp();
  stubClassifier(quiet.app, { species: 'raccoon' });
  await ingestAndClassify(quiet.app, CAM, ringEvent('m1', { cv_properties: { detection_type: 'other_motion', detection_types: [] } }));
  assert.equal(quiet.app.db.getDecision('m1').action, 'fire');
  assert.equal(quiet.app.db.runsForEvent('m1').length, 2);
  quiet.cleanup();

  // Ring said animal, the classifier saw nothing move but a shadow: it does not.
  const shade = makeApp();
  stubClassifier(shade.app, { species: 'none', confidence: 0.8 });
  await ingestAndClassify(shade.app, CAM, ringEvent('m2'));
  const decision = shade.app.db.getDecision('m2');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'no_animal');
  assert.equal(shade.app.db.runsForEvent('m2').length, 0);
  assert.deepEqual(shade.calls, [], 'a no_animal skip costs no Rachio call');
  shade.cleanup();
});

test('an unidentified animal and eyeshine both fire under the default wildcard', async () => {
  for (const species of ['animal_unknown', 'eyes_unknown']) {
    const { app, cleanup } = makeApp();
    stubClassifier(app, { species });
    await ingestAndClassify(app, CAM, ringEvent(`u_${species}`));
    assert.equal(app.db.getDecision(`u_${species}`).action, 'fire', species);
    assert.equal(app.db.runsForEvent(`u_${species}`).length, 2, species);
    cleanup();
  }
});

test('a friendly species is a real skip now, not a note on a run that already happened', async () => {
  const { app, calls, cleanup } = makeApp({ friendlies: 'rabbit' });
  stubClassifier(app, { species: 'rabbit', friendly: 1 });
  await ingestAndClassify(app, CAM, ringEvent('bun'));
  const decision = app.db.getDecision('bun');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'friendly');
  assert.equal(app.db.runsForEvent('bun').length, 0, 'no water was spent before the answer arrived');
  assert.deepEqual(calls, []);
  assert.equal(app.db.get('SELECT usd FROM costs WHERE calls = 1').usd, 0.0028, 'the call is still billed');
  cleanup();
});

test('Ring calling it human skips for free, with no classifier call at all', async () => {
  const { app, calls, cleanup } = makeApp();
  const classifier = stubClassifier(app);
  await app.handleEvent(CAM, ringEvent('h1', { cv_properties: { detection_type: 'human', detection_types: [] } }));
  await tick();
  const decision = app.db.getDecision('h1');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'person');
  assert.equal(JSON.parse(decision.knobs_json).verdict_source, 'ring');
  assert.equal(classifier.length, 0, 'a person costs nothing to decide');
  assert.deepEqual(calls, []);

  // And it stays out of the classifier queue even once frames land.
  giveFrames(app, 'h1');
  await app.classifyPass();
  assert.equal(classifier.length, 0);
  assert.equal(app.db.getVerdict('h1'), null);
  cleanup();
});

test('a classifier failure is a skip, never a run', async () => {
  const { app, calls, cleanup } = makeApp();
  stubClassifier(app, { species: null, is_person: 0, error: 'overloaded', usd: 0, input_tokens: 0, output_tokens: 0 });
  await ingestAndClassify(app, CAM, ringEvent('err1'));
  const decision = app.db.getDecision('err1');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'classifier_error');
  assert.equal(JSON.parse(decision.knobs_json).error, 'overloaded');
  assert.equal(app.db.runsForEvent('err1').length, 0);
  assert.deepEqual(calls, []);
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM costs').n, 0, 'a failed call bills nothing');

  // The verdict row holds the error, so it is not classified again and not decided again.
  await app.classifyPass();
  assert.equal(app.classifier.calls.length, 1);
  cleanup();
});

test('an event is classified once and run once', async () => {
  const { app, cleanup } = makeApp();
  await ingestAndClassify(app, CAM, ringEvent('once'));
  assert.equal(app.db.runsForEvent('once').length, 2);
  await app.classifyPass();
  await app.classifyEvent('once');
  await tick();
  assert.equal(app.classifier.calls.length, 1, 'a verdict row keeps it out of the queue');
  assert.equal(app.db.runsForEvent('once').length, 2);
  cleanup();
});

// ---- push: the snapshot is the fast path ------------------------------------

test('a push snapshot is classified straight away, without waiting for the clip', async () => {
  const { app, cleanup } = makeApp();
  const snapshot = path.join(app.opts.data_dir, 'frames', 'p1_snapshot.jpg');
  app.ring.saveSnapshot = async (camera, id, uuid) => {
    assert.equal(uuid, 'uuid-1');
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, 'jpeg');
    return snapshot;
  };

  await app.handlePush(CAM, push('p1', 'other_motion', { img: { snapshot_uuid: 'uuid-1' } }));
  await tick();

  assert.equal(app.db.getEvent('p1').snapshot_path, snapshot);
  assert.deepEqual(app.classifier.calls[0].images, [snapshot], 'the snapshot alone is enough to decide');
  assert.equal(app.db.getDecision('p1').action, 'fire');
  assert.equal(app.db.runsForEvent('p1').length, 2);
  cleanup();
});

test('a push with no snapshot waits for the clip instead of guessing', async () => {
  const { app, cleanup } = makeApp();
  await app.handlePush(CAM, push('p2', 'other_motion'));
  await tick();
  assert.equal(app.db.getDecision('p2'), null);
  assert.equal(app.classifier.calls.length, 0);

  // The poll pass fills the row in, and still decides nothing on its own.
  await app.handleEvent(CAM, ringEvent('p2'));
  await tick();
  assert.equal(app.db.getEvent('p2').ring_label, 'animal');
  assert.equal(app.db.getEvent('p2').source, 'push', 'provenance stays push');
  assert.equal(app.db.getDecision('p2'), null, 'enrichment is not a decision');

  // The frames arrive, the classifier answers, and only then does water run.
  giveFrames(app, 'p2');
  await app.classifyPass();
  await tick();
  assert.equal(app.db.getDecision('p2').action, 'fire');
  assert.equal(app.db.runsForEvent('p2').length, 2);
  cleanup();
});

test('a human push skips for free and never asks for a snapshot', async () => {
  const { app, cleanup } = makeApp();
  let snapshots = 0;
  app.ring.saveSnapshot = async () => { snapshots += 1; return null; };
  await app.handlePush(CAM, push('p3', 'human', { img: { snapshot_uuid: 'uuid-3' } }));
  await tick();
  assert.equal(app.db.getDecision('p3').reason, 'person');
  assert.equal(snapshots, 0);
  assert.equal(app.classifier.calls.length, 0);
  cleanup();
});

test('a poll fills in a row the push created first (review item 3)', async () => {
  const { app, cleanup } = makeApp();
  await app.handlePush(CAM, push('p9', 'other_motion'));
  await tick();
  const pushed = app.db.getEvent('p9');
  assert.equal(pushed.source, 'push');
  assert.equal(pushed.ring_created_at, null);

  const created = iso(-2000);
  await app.handleEvent(CAM, ringEvent('p9', { created_at: created, recording_status: 'ready' }));
  const enriched = app.db.getEvent('p9');
  assert.equal(enriched.ring_created_at, created);
  assert.equal(enriched.recording_status, 'ready');
  assert.equal(enriched.first_seen_at, pushed.first_seen_at, 'the push is still what the latency is measured from');
  assert.deepEqual(JSON.parse(enriched.ring_labels_json), ['animal']);
  assert.equal(JSON.parse(enriched.raw_json).ding_id_str, '1', 'and the clip loop now has a ding id');
  cleanup();
});

test('a push arriving after the poll never downgrades the Ring label', async () => {
  const { app, cleanup } = makeApp();
  await ingestAndClassify(app, CAM, ringEvent('p6'));
  assert.equal(app.db.getDecision('p6').action, 'fire');

  await app.handlePush(CAM, push('p6', 'other_motion'));
  await tick();
  assert.equal(app.db.getEvent('p6').ring_label, 'animal', 'the push enum has no animal value to offer');
  assert.equal(app.db.runsForEvent('p6').length, 2, 'and it starts nothing new');
  cleanup();
});

// ---- the person stop, which the classification never replaces ---------------

test('a human event stops a run that is already going (review item 2)', async () => {
  let watering = { reason: 'QUICK_RUN', durationSeconds: 60 };
  const { app, calls, release, cleanup } = makeApp({}, { hold: true, watering: () => watering });

  await ingestAndClassify(app, CAM, ringEvent('live'));
  assert.equal(app.activeRuns.size, 1);
  const before = app.db.runsForEvent('live');
  assert.equal(before.length, 2);
  assert.equal(before[0].cleared_at, null);

  await app.handleEvent(CAM, ringEvent('human1', { cv_properties: { detection_type: 'human', detection_types: [] } }));
  watering = null;

  const stops = calls.filter((c) => c.includes('stopWatering'));
  assert.equal(stops.length, 2, 'one stop per open valve, sent immediately');
  for (const run of app.db.runsForEvent('live')) assert.equal(run.stopped_by, 'person');
  assert.equal(app.db.getDecision('human1').reason, 'person');

  release();
  await tick();
  // The confirm loop sends its own stop as well (review 2 item 1): a duplicate is harmless, and it
  // is the only stop that counts when the immediate one raced startWatering.
  assert.ok(calls.filter((c) => c.includes('stopWatering')).length >= 2);
  cleanup();
});

test('a person verdict on a later event stops the run on that camera', async () => {
  const { app, calls, cleanup } = makeApp({}, { hold: true, watering: () => ({ reason: 'QUICK_RUN' }) });
  await ingestAndClassify(app, CAM, ringEvent('live'));
  assert.equal(app.activeRuns.size, 1);

  // A second event on the same camera, which the classifier says is a person.
  await app.handleEvent(CAM, ringEvent('live2'));
  giveFrames(app, 'live2');
  stubClassifier(app, { species: 'person', is_person: 1 });
  await app.classifyPass();
  await tick();

  assert.ok(calls.filter((c) => c.includes('stopWatering')).length >= 1);
  for (const run of app.db.runsForEvent('live')) assert.equal(run.stopped_by, 'person');
  assert.equal(app.db.getDecision('live2').reason, 'person');
  assert.equal(app.db.runsForEvent('live2').length, 0);
  cleanup();
});

// ---- backlog, cost control and the knobs ------------------------------------

test('a boot backlog is recorded, never classified and never fired (review item 1)', async () => {
  const { app, calls, cleanup } = makeApp();
  const old = new Date(Date.now() - 6 * 3600 * 1000).toISOString(); // well past stale_after_s
  for (let i = 0; i < 5; i += 1) {
    await app.handleEvent(CAM, ringEvent(`old${i}`, { created_at: old }));
    giveFrames(app, `old${i}`);
  }
  await app.classifyPass();
  assert.equal(app.db.countEvents(), 5);
  for (let i = 0; i < 5; i += 1) {
    const d = app.db.getDecision(`old${i}`);
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'stale');
    assert.equal(app.db.runsForEvent(`old${i}`).length, 0);
  }
  assert.equal(app.classifier.calls.length, 0, 'a backlog is not worth classifying either');
  assert.deepEqual(calls, [], 'a stale backlog makes no Rachio calls at all');
  cleanup();
});

test('a live event still fires after a stale backlog', async () => {
  const { app, cleanup } = makeApp();
  await app.handleEvent(CAM, ringEvent('old', { created_at: new Date(Date.now() - 7200000).toISOString() }));
  await ingestAndClassify(app, CAM, ringEvent('live'));
  assert.equal(app.db.getDecision('live').action, 'fire');
  assert.equal(app.db.runsForEvent('live').length, 2);
  cleanup();
});

test('ignored cameras are polled for the table and nothing else (review item 8)', async () => {
  const { app, cleanup } = makeApp();
  const downloads = [];
  app.ring.downloadClip = async (camera) => { downloads.push(String(camera.id)); return null; };
  await app.handleEvent(CAM, ringEvent('green1'));
  await app.handleEvent(IGNORED, ringEvent('bird1'));
  await tick();

  assert.equal(app.db.countEvents(), 2, 'both are on the events table');
  assert.equal(app.db.getDecision('bird1').reason, 'not_greenlisted', 'decided without a classifier call');
  await app.mediaPass();
  assert.deepEqual(downloads, ['639481050'], 'only the greenlisted camera costs a clip download');

  giveFrames(app, 'bird1');
  await app.classifyPass();
  assert.equal(app.classifier.calls.length, 0);
  assert.equal(app.db.getVerdict('bird1'), null);
  cleanup();
});

test('skip paths make zero Rachio lookups, a fire makes one (review item 9)', async () => {
  const off = makeApp({ enabled: false });
  await ingestAndClassify(off.app, CAM, ringEvent('off1'));
  assert.equal(off.app.db.getDecision('off1').reason, 'disabled');
  assert.deepEqual(off.calls, []);
  off.cleanup();

  const cap = makeApp({ daily_cap: 1 });
  cap.app.db.insertRun({ event_id: 'seed', valve_id: 'v1', requested_s: 60, called_at: iso(), dry_run: 0 });
  await ingestAndClassify(cap.app, CAM, ringEvent('capped'));
  assert.equal(cap.app.db.getDecision('capped').reason, 'cap');
  assert.deepEqual(cap.calls, [], 'the cap is checked before any getValve');
  cap.cleanup();

  const fire = makeApp();
  await ingestAndClassify(fire.app, CAM, ringEvent('live'));
  assert.ok(fire.calls.some((c) => c.includes('getValve')), 'a would-be fire does check for a program');
  fire.cleanup();
});

test('a Rachio program running on a target valve still wins (spec 7.11)', async () => {
  const { app, cleanup } = makeApp({}, { watering: () => ({ reason: 'SCHEDULE', durationSeconds: 30 }) });
  await ingestAndClassify(app, CAM, ringEvent('live'));
  assert.equal(app.db.getDecision('live').reason, 'program_running');
  assert.equal(app.db.runsForEvent('live').length, 0);
  cleanup();
});

test('knobs are re-read on every decision (review item 12)', async () => {
  const { app, refreshCount, cleanup } = makeApp();
  await ingestAndClassify(app, CAM, ringEvent('live1'));
  await ingestAndClassify(app, CAM, ringEvent('live2'));
  assert.ok(refreshCount() >= 2, `expected a refresh per decision, saw ${refreshCount()}`);
  cleanup();
});

test('the event row is read after the knob refresh, never before', async () => {
  // Ordering hygiene kept from v0.2: whatever landed on the row while the knobs were being fetched
  // is what the decision is made on, so a decision can never be written from a stale copy.
  const { app, cleanup } = makeApp();
  const order = [];
  const refresh = app.knobStore.refresh;
  app.knobStore.refresh = async () => { const out = await refresh(); order.push('refresh'); return out; };
  const getEvent = app.db.getEvent.bind(app.db);
  app.db.getEvent = (id) => { order.push(`getEvent:${id}`); return getEvent(id); };

  app.db.insertEvent({ event_id: 'o1', camera_id: String(CAM.id), first_seen_at: iso(), source: 'poll', test: 0 });
  order.length = 0;
  await app.runDecision('o1', { species: 'coyote', is_person: false, source: 'classifier' });
  assert.deepEqual(order.slice(0, 2), ['refresh', 'getEvent:o1']);
  cleanup();
});

test('poll backoff climbs and resets (review item 15)', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(backoffMs), [5000, 10000, 20000, 40000, 80000, 120000, 120000]);
  assert.equal(backoffMs(0), 0);

  const { app, cleanup } = makeApp();
  let ok = false;
  let restarts = 0;
  app.ring.poll = async () => ok;
  app.ring.restart = async () => { restarts += 1; };
  await app.pollPass();
  assert.equal(app.pollDelayMs, 5000);
  await app.pollPass();
  assert.equal(app.pollDelayMs, 10000);
  await app.pollPass();
  assert.equal(app.pollDelayMs, 20000);
  assert.equal(restarts, 1, 'a reconnect is attempted after three failures in a row');
  ok = true;
  await app.pollPass();
  assert.equal(app.pollFailures, 0);
  assert.equal(app.pollDelayMs, 10000, 'back to the configured poll interval');
  cleanup();
});

test('shutdown closes an open valve before exit (review item 15)', async () => {
  const { app, calls } = makeApp({}, { hold: true, watering: () => ({ reason: 'QUICK_RUN' }) });
  await ingestAndClassify(app, CAM, ringEvent('live'));
  assert.equal(app.activeRuns.size, 1);

  app.server = { close: () => {} };
  app.ring.disconnect = () => {};
  const dataDir = app.opts.data_dir;
  const t0 = Date.now();
  await app.shutdown(5000);
  assert.ok(Date.now() - t0 < 1000, 'shutdown returns as soon as the valves are closed, it does not sit out the cap');
  assert.equal(calls.filter((c) => c.includes('stopWatering')).length, 2);

  // Reopened from disk, so this also proves the rows were committed before the process died.
  const after = new Db(path.join(dataDir, 'auto-ttds.db'));
  const rows = after.all('SELECT stopped_by, flow_detected FROM runs');
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.stopped_by, 'shutdown');
    assert.equal(r.flow_detected, null, 'the timer reported no flow, which is not the same as none');
  }
  after.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('dry run writes rows and never calls Rachio', async () => {
  const { app, calls, cleanup } = makeApp({ dry_run: true });
  await ingestAndClassify(app, CAM, ringEvent('live'));
  const runs = app.db.runsForEvent('live');
  assert.equal(runs.length, 2);
  for (const r of runs) assert.equal(r.dry_run, 1);
  assert.deepEqual(calls.filter((c) => c.includes('Watering')), []);
  cleanup();
});

test('a push that arrives after the poll adds its snapshot and never re-decides', async () => {
  const { app, cleanup } = makeApp();
  const snapshot = path.join(app.opts.data_dir, 'frames', 'p7_snapshot.jpg');
  app.ring.saveSnapshot = async () => {
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, 'jpeg');
    return snapshot;
  };
  await app.handleEvent(CAM, ringEvent('p7'));
  assert.equal(app.db.getDecision('p7'), null);

  await app.handlePush(CAM, push('p7', 'other_motion', { img: { snapshot_uuid: 'uuid-7' } }));
  await tick();
  assert.deepEqual(app.classifier.calls[0].images, [snapshot], 'the late snapshot is still the fast image');
  assert.equal(app.db.getDecision('p7').action, 'fire');
  assert.equal(app.db.runsForEvent('p7').length, 2);

  // A second push for the same event changes nothing.
  await app.handlePush(CAM, push('p7', 'other_motion', { img: { snapshot_uuid: 'uuid-7' } }));
  await tick();
  assert.equal(app.classifier.calls.length, 1);
  assert.equal(app.db.runsForEvent('p7').length, 2);
  cleanup();
});

test('a human push on an event that already ran stops the water without rewriting the decision', async () => {
  const { app, calls, cleanup } = makeApp({}, { hold: true, watering: () => ({ reason: 'QUICK_RUN' }) });
  await ingestAndClassify(app, CAM, ringEvent('p8'));
  assert.equal(app.db.getDecision('p8').action, 'fire');

  await app.handlePush(CAM, push('p8', 'human'));
  await tick();
  assert.equal(app.db.getDecision('p8').action, 'fire', 'the history of what was decided stands');
  assert.ok(calls.filter((c) => c.includes('stopWatering')).length >= 1, 'but the water stops');
  for (const run of app.db.runsForEvent('p8')) assert.equal(run.stopped_by, 'person');
  cleanup();
});

test('a label that turns human before anything was decided is decided as a person', async () => {
  const { app, cleanup } = makeApp();
  await app.handlePush(CAM, push('p10', 'other_motion'));
  await tick();
  assert.equal(app.db.getDecision('p10'), null);

  // The events API brings the real label, and it is human.
  await app.handleEvent(CAM, ringEvent('p10', { cv_properties: { detection_type: 'human', detection_types: [] } }));
  await tick();
  assert.equal(app.db.getDecision('p10').reason, 'person');
  assert.equal(app.classifier.calls.length, 0, 'and it is never classified');

  // Frames arriving later change nothing: a person is out of the queue for good.
  giveFrames(app, 'p10');
  await app.classifyPass();
  assert.equal(app.classifier.calls.length, 0);
  assert.equal(app.db.runsForEvent('p10').length, 0);
  cleanup();
});

// ---- v0.4: the poll path stops waiting for the clip -------------------------

test('no camera is ever asked for an image the add-on does not already have', async () => {
  const { app, cleanup } = makeApp();
  // Any capture route would have to go through the camera object, so fail loudly on all of them.
  const trap = (name) => () => { throw new Error(`${name} must never be called`); };
  const guarded = { ...CAM, getSnapshot: trap('getSnapshot'), getNextSnapshot: trap('getNextSnapshot') };
  app.ring.camera = () => guarded;
  let byUuid = 0;
  app.ring.saveSnapshot = async (camera, id, uuid) => {
    byUuid += 1;
    assert.ok(uuid, 'a stored image is only ever fetched by the uuid the push carried');
    return null;
  };

  await app.handleEvent(guarded, ringEvent('c1'));            // poll, animal, no image
  await app.handleEvent(IGNORED, ringEvent('c2'));            // off the greenlist
  await app.handleEvent(guarded, ringEvent('c3', { cv_properties: { detection_type: 'human', detection_types: [] } }));
  await app.handlePush(guarded, push('c4', 'other_motion'));  // a push with no snapshot uuid
  await app.settle();
  await tick();

  assert.equal(byUuid, 0, 'a push with no uuid asks for nothing at all');
  assert.equal(app.db.getEvent('c1').snapshot_path, null, 'a polled event simply waits for its clip');
  assert.equal(app.db.getEvent('c1').image_source, null);
  assert.equal(app.db.getDecision('c1'), null, 'and nothing is decided until an image exists');
  assert.equal(app.db.getDecision('c2').reason, 'not_greenlisted');
  assert.equal(app.db.getDecision('c3').reason, 'person');
  cleanup();
});

test('the push snapshot path records where its image came from', async () => {
  const { app, cleanup } = makeApp();
  const snapshot = path.join(app.opts.data_dir, 'frames', 'ps1_snapshot.jpg');
  app.ring.saveSnapshot = async () => {
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, 'jpeg');
    return snapshot;
  };
  await app.handlePush(CAM, push('ps1', 'other_motion', { img: { snapshot_uuid: 'uuid-ps1' } }));
  await tick();
  const row = app.db.getEvent('ps1');
  assert.equal(row.image_source, 'push_snapshot');
  assert.ok(row.image_ready_at);
  assert.deepEqual(app.classifier.calls[0].images, [snapshot], 'one image on the push path too');
  cleanup();
});

test('clip frames are recorded as the image source only when they are the image', () => {
  const at = '2026-09-17T12:00:00.000Z';
  const fresh = framesPatch({ event_id: 'e', image_source: null, snapshot_path: null }, ['e_t1.jpg', 'e_t3.jpg'], at);
  assert.equal(fresh.image_source, 'clip_frames');
  assert.equal(fresh.image_ready_at, at);
  assert.deepEqual(JSON.parse(fresh.frames_json), ['e_t1.jpg', 'e_t3.jpg']);

  // A clip that lands after the push snapshot already decided the event rewrites nothing.
  const after = framesPatch({ event_id: 'e', image_source: 'push_snapshot', snapshot_path: '/f/e_snapshot.jpg' }, ['e_t1.jpg'], at);
  assert.equal(after.image_source, undefined);
  assert.equal(after.image_ready_at, undefined);
  assert.deepEqual(JSON.parse(after.frames_json), ['e_t1.jpg']);

  // A clip ffmpeg could not read claims nothing.
  const empty = framesPatch({ event_id: 'e' }, [], at);
  assert.equal(empty.image_source, undefined);
  assert.deepEqual(JSON.parse(empty.frames_json), []);
});

test('trigger latency is recorded from the Ring event to the first valve command', async () => {
  const { app, cleanup } = makeApp();
  app.startedAt = iso(-60000); // this boot is a minute old, so a nine second old event is live
  const created = iso(-9000); // the Ring event was nine seconds ago
  await ingestAndClassify(app, CAM, ringEvent('lat1', { created_at: created }));

  const decision = app.db.getDecision('lat1');
  assert.equal(decision.action, 'fire');
  const ms = decision.trigger_latency_ms;
  assert.ok(Number.isInteger(ms), 'the figure is stored in milliseconds');
  assert.ok(ms >= 9000 && ms < 12000, `measured from ring_created_at, saw ${ms} ms`);
  assert.equal(app.db.runsForEvent('lat1').length, 2);
  cleanup();
});

test('nothing fired means no trigger latency to report', async () => {
  // A skip records none.
  const skipped = makeApp({ friendlies: 'rabbit' });
  stubClassifier(skipped.app, { species: 'rabbit' });
  await ingestAndClassify(skipped.app, CAM, ringEvent('lat2'));
  assert.equal(skipped.app.db.getDecision('lat2').reason, 'friendly');
  assert.equal(skipped.app.db.getDecision('lat2').trigger_latency_ms, null);
  skipped.cleanup();

  // A dry run issues no startWatering, so there is no command to time.
  const dry = makeApp({ dry_run: true });
  await ingestAndClassify(dry.app, CAM, ringEvent('lat3'));
  assert.equal(dry.app.db.getDecision('lat3').action, 'fire');
  assert.equal(dry.app.db.runsForEvent('lat3').length, 2);
  assert.equal(dry.app.db.getDecision('lat3').trigger_latency_ms, null, 'a dry run commands no valve');
  dry.cleanup();
});

// ---- review fixes 1 to 5 ----------------------------------------------------

/** A classifier stub that takes its time, so "the poll loop did not wait" is measurable. */
function slowClassifier(app, delayMs) {
  const calls = [];
  app.classifier = {
    calls,
    classify: async (images) => {
      calls.push({ images });
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        model: 'claude-haiku-4-5', species: 'coyote', count: 1, is_person: 0, friendly: 0,
        confidence: 0.9, input_tokens: 2200, output_tokens: 120, usd: 0.0028, latency_ms: delayMs,
        at: iso(), error: null,
      };
    },
  };
  return calls;
}

test('fix 1: a slow snapshot and a slow classifier never hold up the poll batch', async () => {
  const { app, calls, release, cleanup } = makeApp({}, { hold: true, watering: () => ({ reason: 'QUICK_RUN' }) });
  await ingestAndClassify(app, CAM, ringEvent('live'));
  assert.equal(app.activeRuns.size, 1, 'a run is going, which is when a person matters most');

  // The classifier is now slow, and there are four animal events ahead of the human one.
  slowClassifier(app, 150);
  for (const id of ['b1', 'b2', 'b3', 'b4']) {
    // Each already has an image, so each reaches the slow classifier the moment it is ingested.
    const dir = path.join(app.opts.data_dir, 'frames');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}_t1.jpg`), 'jpeg');
  }

  const batch = [
    ringEvent('b1'), ringEvent('b2'), ringEvent('b3'), ringEvent('b4'),
    ringEvent('bhuman', { cv_properties: { detection_type: 'human', detection_types: [] } }),
  ];
  const t0 = Date.now();
  for (const e of batch) {
    await app.handleEvent(CAM, e); // exactly what ring.poll does with a batch
    if (String(e.event_id).startsWith('b') && e.event_id !== 'bhuman') {
      app.db.updateEvent(String(e.event_id), { frames_json: `["${e.event_id}_t1.jpg"]` });
    }
  }
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 120, `the poll batch did not wait on the slow work (took ${elapsed} ms, serial would be 600+)`);
  assert.equal(app.db.getDecision('bhuman').reason, 'person', 'the human event was decided inside the batch');
  const stops = calls.filter((c) => c.includes('stopWatering'));
  assert.equal(stops.length, 2, 'and it stopped both open valves, with no delay');
  for (const run of app.db.runsForEvent('live')) assert.equal(run.stopped_by, 'person');

  await app.settle(); // the detached work still finishes, it just finishes off the poll clock
  release();
  await tick();
  cleanup();
});

test('fix 1: the Anthropic client is bounded, not left on the SDK defaults', () => {
  const client = classifierClient('not-a-real-key');
  assert.equal(CLASSIFIER_TIMEOUT_MS, 20000);
  assert.equal(client.timeout, 20000, 'the SDK default is 600000 ms');
  assert.equal(client.maxRetries, 0, 'the SDK default is 2, on top of the one retry classify() makes');
});

test('fix 2: a human push seconds before the verdict stops the fire that has not started', async () => {
  const { app, calls, cleanup } = makeApp();
  // The person arrives first, with nothing running for stopActiveRuns to reach.
  await app.handlePush(CAM, push('h9', 'human'));
  await tick();
  assert.equal(app.activeRuns.size, 0);

  // The animal event that was already in flight now classifies and would have fired.
  await app.handleEvent(CAM, ringEvent('a9'));
  await app.settle();
  giveFrames(app, 'a9');
  await app.classifyPass();
  await tick();

  const decision = app.db.getDecision('a9');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'person');
  assert.equal(app.db.runsForEvent('a9').length, 0);
  assert.deepEqual(calls.filter((c) => c.includes('startWatering')), [], 'no valve was ever commanded');
  assert.deepEqual(calls, [], 'and the skip cost no Rachio call at all');
  cleanup();
});

test('fix 2: the block lasts one run length and then lets water through again', async () => {
  const { app, cleanup } = makeApp({ run_seconds: 60 });
  assert.equal(app.humanSeenRecently(CAM.id, 60, Date.now()), false, 'nobody seen yet');
  app.markHuman(CAM.id, Date.now() - 30000);
  assert.equal(app.humanSeenRecently(CAM.id, 60, Date.now()), true, 'inside the run that would start');
  assert.equal(app.humanSeenRecently(CAM.id, 60, Date.now() + 31000), false, 'past it');
  assert.equal(app.humanSeenRecently(IGNORED.id, 60, Date.now()), false, 'and it is per camera');

  // A sighting the guard has let go of does not block anything.
  app.markHuman(CAM.id, Date.now() - 90000); // a minute and a half ago, past a 60 s run
  await ingestAndClassify(app, CAM, ringEvent('after'));
  assert.equal(app.db.getDecision('after').action, 'fire');

  // And a sighting inside the window does.
  app.markHuman(CAM.id);
  await ingestAndClassify(app, CAM, ringEvent('blocked'));
  assert.equal(app.db.getDecision('blocked').reason, 'person');
  assert.equal(app.db.runsForEvent('blocked').length, 0);
  cleanup();
});

test('fix 5: an event that went stale while waiting for its clip does not fire', async () => {
  const { app, calls, cleanup } = makeApp();
  // The row was inserted live and has been sitting in the queue for 31 minutes.
  const old = new Date(Date.now() - 31 * 60000).toISOString();
  app.db.insertEvent({
    event_id: 's9', camera_id: String(CAM.id), camera_name: CAM.name, ring_created_at: old,
    first_seen_at: iso(), source: 'poll', kind: 'motion', ring_label: 'animal', test: 0, raw_json: '{}',
  });
  giveFrames(app, 's9');
  await app.classifyPass();
  await tick();

  const decision = app.db.getDecision('s9');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'stale', 'staleness is re-checked at decision time, not only at insert');
  assert.equal(app.db.runsForEvent('s9').length, 0);
  assert.deepEqual(calls, [], 'and it costs no Rachio call');
  assert.equal(app.db.getVerdict('s9').species, 'coyote', 'the verdict it waited for is still recorded');

  // A fresh event on the same camera still fires, so the cutoff is age and nothing else.
  await ingestAndClassify(app, CAM, ringEvent('fresh9'));
  assert.equal(app.db.getDecision('fresh9').action, 'fire');
  cleanup();
});

test('fix 5: the stale cutoff is the existing stale_after_s option, not a new knob', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttds-stale-'));
  const app = new App({
    data_dir: dataDir, poll_interval_s: 10, stale_after_s: 3600, classifier_model: 'claude-haiku-4-5',
    anthropic_api_key: '', log_level: 'warning',
  });
  const knobs = knobDefaults();
  app.knobStore = { get: () => knobs, refresh: async () => knobs, lastRefreshAt: null };
  app.ha = { fireEvent: async () => {}, setState: async () => {}, getStates: async () => ({}) };
  app.valves = [{ id: 'v1', name: 'Hose Sprinkler 1' }];
  app.rachio = null;
  stubClassifier(app);
  app.startedAt = iso(-2 * 3600 * 1000); // this boot is two hours old, so only the age rule applies

  // 31 minutes old, but this install allows an hour.
  app.db.insertEvent({
    event_id: 'wide', camera_id: String(CAM.id), ring_created_at: new Date(Date.now() - 31 * 60000).toISOString(),
    first_seen_at: iso(), source: 'poll', ring_label: 'animal', test: 0,
  });
  await app.runDecision('wide', { species: 'coyote', is_person: false, source: 'classifier' });
  await tick();
  assert.equal(app.db.getDecision('wide').action, 'fire', 'a wider cutoff keeps the same event alive');
  app.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('fix 4: a human only named in the detection_types array still skips for free', async () => {
  const { app, calls, cleanup } = makeApp();
  const classifier = stubClassifier(app);
  await app.handleEvent(CAM, ringEvent('hx', { cv_properties: { detection_type: null, detection_types: [{ detection_type: 'human' }] } }));
  await app.settle();

  assert.equal(app.db.getEvent('hx').ring_label, 'human');
  const decision = app.db.getDecision('hx');
  assert.equal(decision.reason, 'person');
  assert.equal(JSON.parse(decision.knobs_json).verdict_source, 'ring');
  assert.equal(classifier.length, 0, 'a person costs no classifier call, whatever shape the label came in');
  assert.deepEqual(calls, []);
  cleanup();
});

// ---- final review fixes -----------------------------------------------------

test('a verdict that lands after the label turned human cannot open a valve', async () => {
  const { app, calls, cleanup } = makeApp();
  // The classifier is slow the way the real one can be: a request, a 30 s sleep, another request.
  let finish = () => {};
  const held = new Promise((r) => { finish = r; });
  app.classifier = {
    classify: async () => {
      await held;
      return {
        model: 'claude-haiku-4-5', species: 'coyote', count: 1, is_person: 0, friendly: 0,
        confidence: 0.9, input_tokens: 2200, output_tokens: 120, usd: 0.0028, latency_ms: 70000,
        at: iso(), error: null,
      };
    },
  };

  // A push with a snapshot starts the classify.
  const snapshot = path.join(app.opts.data_dir, 'frames', 'late1_snapshot.jpg');
  app.ring.saveSnapshot = async () => {
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, 'jpeg');
    return snapshot;
  };
  const classifying = app.handlePush(CAM, push('late1', 'other_motion', { img: { snapshot_uuid: 'u1' } }));
  await tick();
  assert.equal(app.db.getEvent('late1').snapshot_path, snapshot, 'the classify is in flight');

  // While it is in flight the poll brings the real label, and it is human.
  await app.handleEvent(CAM, ringEvent('late1', { cv_properties: { detection_type: 'human', detection_types: [] } }));
  await tick();
  assert.equal(app.db.getEvent('late1').ring_label, 'human');
  assert.equal(app.db.getDecision('late1').reason, 'person');

  // Seventy seconds later the verdict says coyote. It must not flip the decision.
  app.lastHumanAt.clear(); // the 60 s window has long expired, so only the durable record saves it
  finish();
  await classifying;
  await app.settle();
  await tick();

  const decision = app.db.getDecision('late1');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'person');
  assert.equal(app.db.runsForEvent('late1').length, 0);
  assert.deepEqual(calls, [], 'no Rachio call of any kind was made on a person');
  cleanup();
});

test('a decision already recorded as person survives a later animal verdict', async () => {
  const { app, calls, cleanup } = makeApp();
  app.db.insertEvent({
    event_id: 'p11', camera_id: String(CAM.id), ring_created_at: iso(), first_seen_at: iso(),
    source: 'push', ring_label: 'other_motion', test: 0,
  });
  await app.recordSkip('p11', 'person', { by: 'an earlier pass' });
  await app.runDecision('p11', { species: 'coyote', is_person: false, source: 'classifier' });
  await tick();
  assert.equal(app.db.getDecision('p11').reason, 'person', 'the recorded person wins, even with a clean label');
  assert.equal(app.db.runsForEvent('p11').length, 0);
  assert.deepEqual(calls, []);
  cleanup();
});

test('rows whose frames are missing from disk are closed out instead of holding the queue', async () => {
  const { app, cleanup } = makeApp();
  app.startedAt = iso(-3600 * 1000);
  // Five ghosts: frames_json names files that are not there. Older than the real event, so they
  // are first in the window, and past stale_after_s so no image can still be coming.
  for (let i = 0; i < 5; i += 1) {
    const at = new Date(Date.now() - (600 + i) * 1000).toISOString();
    app.db.insertEvent({
      event_id: `ghost${i}`, camera_id: String(CAM.id), ring_created_at: at, first_seen_at: at,
      source: 'poll', ring_label: 'animal', frames_json: `["ghost${i}_t1.jpg"]`, test: 0,
    });
  }
  assert.equal(app.db.eventsAwaitingVerdict(app.greenCameras(), 5).length, 5, 'the window is full of ghosts');

  await app.classifyPass();
  await tick();
  for (let i = 0; i < 5; i += 1) {
    const d = app.db.getDecision(`ghost${i}`);
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'classifier_error');
    assert.equal(JSON.parse(d.knobs_json).error, 'no image ever arrived');
  }
  assert.equal(app.classifier.calls.length, 0, 'nothing was sent to Claude, because there was nothing to send');

  // The window is now free for a real event, which classifies and fires.
  await ingestAndClassify(app, CAM, ringEvent('real1'));
  assert.equal(app.db.getDecision('real1').action, 'fire');
  cleanup();
});

test('a young row with no image on disk is left alone to wait for its clip', async () => {
  const { app, cleanup } = makeApp();
  app.db.insertEvent({
    event_id: 'young1', camera_id: String(CAM.id), ring_created_at: iso(), first_seen_at: iso(),
    source: 'poll', ring_label: 'animal', frames_json: '["young1_t1.jpg"]', test: 0,
  });
  await app.classifyPass();
  await tick();
  assert.equal(app.db.getDecision('young1'), null, 'a live event still gets its chance');
  cleanup();
});

test('a human push upgrades a label the poll already stored', async () => {
  const { app, cleanup } = makeApp();
  await app.handleEvent(CAM, ringEvent('up1', { cv_properties: { detection_type: 'other_motion', detection_types: [] } }));
  await app.settle();
  assert.equal(app.db.getEvent('up1').ring_label, 'other_motion');

  await app.handlePush(CAM, push('up1', 'human'));
  await tick();
  assert.equal(app.db.getEvent('up1').ring_label, 'human', 'a person arriving late always wins');
  assert.equal(app.db.getDecision('up1').reason, 'person');

  // And a non-human push still cannot downgrade what the poll knows.
  await app.handlePush(CAM, push('up1', 'other_motion'));
  await tick();
  assert.equal(app.db.getEvent('up1').ring_label, 'human');
  cleanup();
});

test('a human push with no ding id still stops the water', async () => {
  const { app, calls, release, cleanup } = makeApp({}, { hold: true, watering: () => ({ reason: 'QUICK_RUN' }) });
  await ingestAndClassify(app, CAM, ringEvent('live'));
  assert.equal(app.activeRuns.size, 1);

  await app.handlePush(CAM, push(null, 'human'));
  await tick();
  assert.equal(calls.filter((c) => c.includes('stopWatering')).length, 2, 'both valves closed');
  for (const run of app.db.runsForEvent('live')) assert.equal(run.stopped_by, 'person');
  assert.equal(app.humanSeenRecently(CAM.id, 60, Date.now()), true, 'and the camera is marked');
  assert.equal(app.db.countPushes(), 1, 'the idless push itself is still recorded');
  release();
  await tick();
  cleanup();
});

test('an event created before this boot cannot fire even when it is under the stale cutoff', async () => {
  const { app, calls, cleanup } = makeApp();
  // Ten seconds old, well inside stale_after_s, but from before the restart.
  const created = iso(-10000);
  app.startedAt = iso(-5000);
  app.db.insertEvent({
    event_id: 'boot1', camera_id: String(CAM.id), ring_created_at: created, first_seen_at: iso(),
    source: 'poll', ring_label: 'animal', test: 0,
  });
  giveFrames(app, 'boot1');
  await app.classifyPass();
  await tick();
  const decision = app.db.getDecision('boot1');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'stale', 'a restart does not spray at what happened before it');
  assert.equal(app.db.runsForEvent('boot1').length, 0);
  assert.deepEqual(calls, []);
  cleanup();
});

test('a hanging Rachio socket cannot stall the person stop', async () => {
  const { app, cleanup } = makeApp();
  // Every Rachio request hangs until its own timeout aborts it.
  app.rachio = new Rachio({
    apiKey: 'test-key',
    timeoutMs: 20,
    fetchImpl: (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')));
    }),
  });
  const runId = app.db.insertRun({ event_id: 'ev', valve_id: 'v1', requested_s: 60, called_at: iso(), dry_run: 0 });
  app.activeRuns.set('ev', { camera_id: String(CAM.id), stop: false, valves: [{ runId, valveId: 'v1' }], stopSent: new Set() });

  const t0 = Date.now();
  const stopped = await app.stopActiveRuns('person', { cameraId: CAM.id });
  const elapsed = Date.now() - t0;
  assert.equal(stopped, 1);
  assert.ok(elapsed < 500, `the stop returned on its own timeout, not the socket's (took ${elapsed} ms)`);
  assert.equal(app.db.getRun(runId).stopped_by, 'person', 'and the run is recorded as stopped by a person');
  cleanup();
});
