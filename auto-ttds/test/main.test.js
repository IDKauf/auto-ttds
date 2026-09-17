// App wiring: the boot backlog, the person stop during a live run, push enrichment, late verdicts,
// media gating, lazy Rachio lookups and shutdown. Ring, Rachio and Claude are all mocked, and no
// credential file is read (spec 10.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App, backoffMs } from '../src/main.js';
import { Rachio } from '../src/rachio.js';
import { knobDefaults } from '../src/config.js';
import { eventRow } from '../src/ring.js';
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
      ? { valve: { state: { reportedState: { lastWateringAction: watering } } } }
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
  app.ring = { camera: (id) => [CAM, IGNORED].find((c) => String(c.id) === String(id)) ?? null, pushConnected: false, lastPollOk: true };
  return { app, dataDir, calls, knobs, refreshCount: () => refreshes, release: () => release(), cleanup: () => { app.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('a boot backlog is recorded and never fires (review item 1)', async () => {
  const { app, calls, cleanup } = makeApp();
  const old = new Date(Date.now() - 6 * 3600 * 1000).toISOString(); // well past stale_after_s
  for (let i = 0; i < 5; i += 1) {
    await app.handleEvent(CAM, ringEvent(`old${i}`, { created_at: old }));
  }
  assert.equal(app.db.countEvents(), 5);
  for (let i = 0; i < 5; i += 1) {
    const d = app.db.getDecision(`old${i}`);
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'stale');
    assert.equal(app.db.runsForEvent(`old${i}`).length, 0);
  }
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM runs').n, 0);
  assert.deepEqual(calls, [], 'a stale backlog makes no Rachio calls at all');
  cleanup();
});

test('a live event still fires after a stale backlog', async () => {
  const { app, cleanup } = makeApp();
  await app.handleEvent(CAM, ringEvent('old', { created_at: new Date(Date.now() - 7200000).toISOString() }));
  await app.handleEvent(CAM, ringEvent('live'));
  await tick();
  assert.equal(app.db.getDecision('live').action, 'fire');
  assert.equal(app.db.runsForEvent('live').length, 2); // both valves
  cleanup();
});

test('a human event stops a run that is already going (review item 2)', async () => {
  let watering = { reason: 'QUICK_RUN', durationSeconds: 60 };
  const { app, calls, release, cleanup } = makeApp({}, { hold: true, watering: () => watering });

  await app.handleEvent(CAM, ringEvent('live'));
  await tick();
  // runDecision returned while the run is still open: the poll loop was never blocked.
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

test('a person verdict stops a run on the same camera (review item 2)', async () => {
  const { app, calls, cleanup } = makeApp({}, { hold: true, watering: () => ({ reason: 'QUICK_RUN' }) });
  await app.handleEvent(CAM, ringEvent('live'));
  await tick();
  assert.equal(app.activeRuns.size, 1);

  app.db.updateEvent('live', { frames_json: '["live_t1.jpg"]' });
  fs.mkdirSync(path.join(app.opts.data_dir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(app.opts.data_dir, 'frames', 'live_t1.jpg'), 'jpeg');
  app.classifier = { classify: async () => ({ model: 'claude-haiku-4-5', species: 'person', is_person: 1, friendly: 0, confidence: 0.9, input_tokens: 10, output_tokens: 5, usd: 0.00005, latency_ms: 10, at: iso(), error: null }) };
  await app.classifyPass();

  assert.ok(calls.filter((c) => c.includes('stopWatering')).length >= 1);
  for (const run of app.db.runsForEvent('live')) assert.equal(run.stopped_by, 'person');
  cleanup();
});

test('a poll fills in a row the push created first (review item 3)', async () => {
  const { app, cleanup } = makeApp();
  app.ring.saveSnapshot = async () => null;
  await app.handlePush(CAM, { data: { event: { ding: { id: 'p9', subtype: 'motion', detection_type: 'animal' } } }, android_config: { category: 'com.ring.motion' } });
  await tick();
  const pushed = app.db.getEvent('p9');
  assert.equal(pushed.source, 'push');
  assert.equal(pushed.ring_created_at, null);
  const decisionAfterPush = app.db.getDecision('p9');

  const created = iso(-2000);
  await app.handleEvent(CAM, ringEvent('p9', { created_at: created, recording_status: 'ready' }));
  const enriched = app.db.getEvent('p9');
  assert.equal(enriched.ring_created_at, created);
  assert.equal(enriched.recording_status, 'ready');
  assert.equal(enriched.source, 'push', 'provenance stays push');
  assert.equal(enriched.first_seen_at, pushed.first_seen_at, 'the push is still what the latency is measured from');
  assert.deepEqual(JSON.parse(enriched.ring_labels_json), ['animal']);
  assert.equal(JSON.parse(enriched.raw_json).ding_id_str, '1');
  assert.equal(app.db.getDecision('p9').at, decisionAfterPush.at, 'the poll does not decide again');
  assert.equal(app.db.runsForEvent('p9').length, 2, 'still exactly one run, from the push');
  cleanup();
});

test('a friendly verdict after an immediate run is recorded, not re-decided (review item 6)', async () => {
  const { app, cleanup } = makeApp({ friendlies: 'rabbit' });
  await app.handleEvent(CAM, ringEvent('live'));
  await tick();
  const before = app.db.getDecision('live');
  assert.equal(before.action, 'fire');

  app.db.updateEvent('live', { frames_json: '["live_t1.jpg"]' });
  fs.mkdirSync(path.join(app.opts.data_dir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(app.opts.data_dir, 'frames', 'live_t1.jpg'), 'jpeg');
  app.classifier = { classify: async () => ({ model: 'claude-haiku-4-5', species: 'rabbit', is_person: 0, friendly: 1, confidence: 0.8, input_tokens: 2200, output_tokens: 120, usd: 0.0028, latency_ms: 500, at: iso(), error: null }) };
  await app.classifyPass();

  const after = app.db.getDecision('live');
  assert.equal(after.action, 'fire');
  assert.equal(after.at, before.at, 'the decision row is not replaced');
  const knobs = JSON.parse(after.knobs_json);
  assert.equal(knobs.would_suppress, 1);
  assert.equal(knobs.friendly_species, 'rabbit');
  assert.equal(app.db.get('SELECT usd FROM costs WHERE calls = 1').usd, 0.0028);
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
  assert.equal(app.db.getDecision('bird1').reason, 'not_greenlisted');
  await app.mediaPass();
  assert.deepEqual(downloads, ['639481050'], 'only the greenlisted camera costs a clip download');

  app.db.updateEvent('bird1', { frames_json: '["bird1_t1.jpg"]' });
  app.classifier = { classify: async () => { throw new Error('the classifier must not see an ignored camera'); } };
  await app.classifyPass();
  assert.equal(app.db.getVerdict('bird1'), null);
  cleanup();
});

test('skip paths make zero Rachio lookups, a fire makes one (review item 9)', async () => {
  const { app, calls, cleanup } = makeApp({ enabled: false });
  await app.handleEvent(CAM, ringEvent('off1'));
  assert.deepEqual(calls, []);

  const cap = makeApp({ daily_cap: 1 });
  cap.app.db.insertRun({ event_id: 'seed', valve_id: 'v1', requested_s: 60, called_at: iso(), dry_run: 0 });
  await cap.app.handleEvent(CAM, ringEvent('capped'));
  assert.equal(cap.app.db.getDecision('capped').reason, 'cap');
  assert.deepEqual(cap.calls, [], 'the cap is checked before any getValve');
  cap.cleanup();

  const fire = makeApp();
  await fire.app.handleEvent(CAM, ringEvent('live'));
  await tick();
  assert.ok(fire.calls.some((c) => c.includes('getValve')), 'a would-be fire does check for a program');
  fire.cleanup();
  cleanup();
});

test('a Rachio program running on a target valve still wins (spec 7.11)', async () => {
  const { app, cleanup } = makeApp({}, { watering: () => ({ reason: 'SCHEDULE', durationSeconds: 30 }) });
  await app.handleEvent(CAM, ringEvent('live'));
  await tick();
  assert.equal(app.db.getDecision('live').reason, 'program_running');
  assert.equal(app.db.runsForEvent('live').length, 0);
  cleanup();
});

test('knobs are re-read on every decision (review item 12)', async () => {
  const { app, refreshCount, cleanup } = makeApp();
  await app.handleEvent(CAM, ringEvent('live1'));
  await app.handleEvent(CAM, ringEvent('live2'));
  await tick();
  assert.ok(refreshCount() >= 2, `expected a refresh per decision, saw ${refreshCount()}`);
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
  await app.handleEvent(CAM, ringEvent('live'));
  await tick();
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
  const rows = after.all('SELECT stopped_by FROM runs');
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.stopped_by, 'shutdown');
  after.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('dry run writes rows and never calls Rachio', async () => {
  const { app, calls, cleanup } = makeApp({ dry_run: true });
  await app.handleEvent(CAM, ringEvent('live'));
  await tick();
  const runs = app.db.runsForEvent('live');
  assert.equal(runs.length, 2);
  for (const r of runs) assert.equal(r.dry_run, 1);
  assert.deepEqual(calls.filter((c) => c.includes('Watering')), []);
  cleanup();
});

// ---- v0.2: Ring's push enum has no animal value, so the label arrives late -----------------
// A push-sourced insert decides on human, loitering, motion, other_motion or null and records
// skip/non_target; the events API then enriches ring_label to animal. Before v0.2 that enrichment
// never re-decided, so whichever path won the insert decided the outcome of identical cat events.

const push = (id, detection) => ({
  android_config: { category: 'com.ring.motion' },
  data: { event: { ding: { id, subtype: 'motion', detection_type: detection } } },
});

test('a late animal label re-decides a push skip and fires exactly once', async () => {
  const { app, cleanup } = makeApp();
  app.ring.saveSnapshot = async () => null;

  await app.handlePush(CAM, push('p1', 'other_motion'));
  await tick();
  const first = app.db.getDecision('p1');
  assert.equal(first.action, 'skip');
  assert.equal(first.reason, 'non_target');
  assert.equal(app.db.runsForEvent('p1').length, 0);
  assert.equal(JSON.parse(first.knobs_json).decided_label, 'other_motion');

  await app.handleEvent(CAM, ringEvent('p1')); // the events API brings cv_properties.animal
  await tick();
  const after = app.db.getDecision('p1');
  assert.equal(after.action, 'fire');
  assert.equal(after.reason, 'target');
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM decisions WHERE event_id = ?', 'p1').n, 1,
    'the decision row is updated in place, not duplicated');
  const knobs = JSON.parse(after.knobs_json);
  assert.equal(knobs.redecided, true);
  assert.equal(knobs.previous_reason, 'non_target');
  assert.equal(knobs.decided_label, 'animal');
  assert.equal(app.db.runsForEvent('p1').length, 2, 'one run per valve, once');

  // A later poll pass that changes something other than the label enriches and stops there.
  await app.handleEvent(CAM, ringEvent('p1', { recording_status: 'audio_ready' }));
  await tick();
  assert.equal(app.db.getEvent('p1').recording_status, 'audio_ready');
  assert.equal(app.db.runsForEvent('p1').length, 2, 'an unchanged label never fires again');
  assert.equal(app.db.getDecision('p1').at, after.at, 'and never rewrites the decision');
  cleanup();
});

test('an event that already ran is never re-decided into a second run', async () => {
  const { app, cleanup } = makeApp();
  app.ring.saveSnapshot = async () => null;
  await app.handlePush(CAM, push('p2', 'other_motion'));
  await tick();
  app.db.insertRun({ event_id: 'p2', valve_id: 'v1', requested_s: 60, called_at: iso(), dry_run: 0 });

  await app.handleEvent(CAM, ringEvent('p2'));
  await tick();
  const decision = app.db.getDecision('p2');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'non_target');
  assert.equal(app.db.runsForEvent('p2').length, 1, 'the existing run is the only run');
  assert.equal(app.db.getEvent('p2').ring_label, 'animal', 'the row is still enriched');
  cleanup();
});

test('a skip for person is never re-decided by a later label', async () => {
  const { app, calls, cleanup } = makeApp();
  app.ring.saveSnapshot = async () => null;
  await app.handlePush(CAM, push('p3', 'human'));
  await tick();
  assert.equal(app.db.getDecision('p3').reason, 'person');

  await app.handleEvent(CAM, ringEvent('p3'));
  await tick();
  const decision = app.db.getDecision('p3');
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'person');
  assert.equal(JSON.parse(decision.knobs_json).redecided, undefined);
  assert.equal(app.db.runsForEvent('p3').length, 0);
  assert.deepEqual(calls, [], 'a person skip costs no Rachio call either');
  cleanup();
});

test('a skip the label cannot explain away is left alone', async () => {
  const { app, cleanup } = makeApp({ enabled: false });
  app.ring.saveSnapshot = async () => null;
  await app.handlePush(CAM, push('p4', 'other_motion'));
  await tick();
  assert.equal(app.db.getDecision('p4').reason, 'disabled');

  await app.handleEvent(CAM, ringEvent('p4'));
  await tick();
  assert.equal(app.db.getDecision('p4').reason, 'disabled');
  assert.equal(app.db.runsForEvent('p4').length, 0);
  cleanup();
});

test('a relabeled event that is already stale keeps its skip', async () => {
  const { app, calls, cleanup } = makeApp();
  app.ring.saveSnapshot = async () => null;
  await app.handlePush(CAM, push('p5', 'other_motion'));
  await tick();

  const old = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  await app.handleEvent(CAM, ringEvent('p5', { created_at: old }));
  await tick();
  assert.equal(app.db.getEvent('p5').ring_label, 'animal');
  assert.equal(app.db.getDecision('p5').reason, 'non_target', 'water is pointless six hours later');
  assert.equal(app.db.runsForEvent('p5').length, 0);
  assert.deepEqual(calls, []);
  cleanup();
});

test('a push arriving after the poll never downgrades the Ring label', async () => {
  const { app, cleanup } = makeApp();
  app.ring.saveSnapshot = async () => null;
  await app.handleEvent(CAM, ringEvent('p6'));
  await tick();
  assert.equal(app.db.getDecision('p6').action, 'fire');

  await app.handlePush(CAM, push('p6', 'other_motion'));
  await tick();
  assert.equal(app.db.getEvent('p6').ring_label, 'animal', 'the push enum has no animal value to offer');
  assert.equal(app.db.runsForEvent('p6').length, 2, 'and it starts nothing new');
  cleanup();
});

test('an enrichment landing mid decision leaves the event fired, not stranded', async () => {
  const { app, cleanup } = makeApp();
  app.ring.saveSnapshot = async () => null;
  // The knob refresh is the await inside runDecision. Enriching during it is the race: the push
  // path must not come back and write a skip based on the label the poll has already replaced.
  const refresh = app.knobStore.refresh;
  let armed = true;
  app.knobStore.refresh = async () => {
    const out = await refresh();
    if (armed) { armed = false; await app.handleEvent(CAM, ringEvent('r1')); }
    return out;
  };

  await app.handlePush(CAM, push('r1', 'other_motion'));
  await tick();
  await tick();

  assert.equal(app.db.getEvent('r1').ring_label, 'animal');
  const decision = app.db.getDecision('r1');
  assert.equal(decision.action, 'fire', 'the decision is made on the label the row actually holds');
  assert.equal(JSON.parse(decision.knobs_json).decided_label, 'animal');
  assert.equal(app.db.runsForEvent('r1').length, 2);
  cleanup();
});

test('a row stranded by an earlier version heals on the next poll that sees it', async () => {
  const { app, cleanup } = makeApp();
  // The shape v0.2.0 could leave behind: the label is already animal, the decision still says it
  // was made on other_motion, and nothing has run. This poll pass brings no new field at all.
  const polled = ringEvent('s1');
  const row = eventRow(CAM, polled, 'push', iso(-5000));
  app.db.insertEvent(row);
  app.db.upsertDecision({
    event_id: 's1', at: iso(-4000), action: 'skip', reason: 'non_target', mode: 'immediate',
    knobs_json: JSON.stringify({ decided_label: 'other_motion' }),
  });

  await app.handleEvent(CAM, polled);
  await tick();
  const decision = app.db.getDecision('s1');
  assert.equal(decision.action, 'fire');
  const knobs = JSON.parse(decision.knobs_json);
  assert.equal(knobs.redecided, true);
  assert.equal(knobs.previous_reason, 'non_target');
  assert.equal(app.db.runsForEvent('s1').length, 2);
  cleanup();
});

test('a decision made on the label the row still holds is left alone', async () => {
  const { app, calls, cleanup } = makeApp();
  const polled = ringEvent('s2', { cv_properties: { detection_type: 'other_motion', detection_types: [] } });
  app.db.insertEvent(eventRow(CAM, polled, 'poll', iso(-5000)));
  app.db.upsertDecision({
    event_id: 's2', at: iso(-4000), action: 'skip', reason: 'non_target', mode: 'immediate',
    knobs_json: JSON.stringify({ decided_label: 'other_motion' }),
  });

  await app.handleEvent(CAM, polled);
  await tick();
  assert.equal(app.db.getDecision('s2').reason, 'non_target');
  assert.equal(app.db.runsForEvent('s2').length, 0);
  assert.deepEqual(calls, [], 'a poll pass that brings nothing new costs nothing');
  cleanup();
});
