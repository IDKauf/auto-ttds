// SQLite round trips and page queries on an in-memory database (spec 5, 11.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db, median, localDayStartIso, localDayKey, localMonthKey, localHourOf, isNightHour } from '../src/db.js';

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function seed() {
  const db = new Db(':memory:');
  db.insertEvent({
    event_id: 'e1', camera_id: '639481050', camera_name: 'Cat Cam', ring_created_at: iso(-60000),
    first_seen_at: iso(-59000), source: 'poll', kind: 'motion', ring_label: 'animal',
    ring_labels_json: '["animal"]', recording_status: 'ready', test: 0, raw_json: '{}',
  });
  db.insertEvent({
    event_id: 'e2', camera_id: '73991832', camera_name: 'Behind the Office Cam', ring_created_at: iso(-30000),
    first_seen_at: iso(-29000), source: 'push', kind: 'motion', ring_label: 'human',
    ring_labels_json: '["human"]', recording_status: 'ready', test: 1, raw_json: '{}',
  });
  return db;
}

test('event insert is idempotent and readable back', () => {
  const db = seed();
  assert.equal(db.countEvents(), 2);
  assert.equal(db.insertEvent({ event_id: 'e1', camera_id: 'x' }), false);
  assert.equal(db.getEvent('e1').camera_name, 'Cat Cam');
  assert.equal(db.hasEvent('nope'), false);
  db.close();
});

test('upsertEvent patches only the columns it is given', () => {
  const db = seed();
  db.upsertEvent({ event_id: 'e1', source: 'push', ring_label: 'animal' });
  const row = db.getEvent('e1');
  assert.equal(row.source, 'push');
  assert.equal(row.camera_name, 'Cat Cam');
  db.close();
});

test('verdict, decision, run and label round trip', () => {
  const db = seed();
  db.upsertVerdict({ event_id: 'e1', model: 'claude-haiku-4-5', species: 'coyote', count: 1, is_person: 0, friendly: 0, confidence: 0.8, frames_agree: null, raw_json: '{}', input_tokens: 2200, output_tokens: 120, usd: 0.0028, latency_ms: 900, at: iso(), error: null });
  assert.equal(db.getVerdict('e1').species, 'coyote');

  db.upsertDecision({ event_id: 'e1', at: iso(), action: 'fire', reason: 'target', mode: 'immediate', knobs_json: '{}' });
  assert.equal(db.getDecision('e1').action, 'fire');

  const runId = db.insertRun({ event_id: 'e1', valve_id: 'v1', valve_name: 'Hose Sprinkler 1', requested_s: 60, called_at: iso(), dry_run: 0 });
  db.updateRun(runId, { http_status: 200, http_ms: 310, confirmed_at: iso(9000) });
  const run = db.getRun(runId);
  assert.equal(run.http_status, 200);
  assert.equal(db.runsForEvent('e1').length, 1);
  assert.equal(db.activeRuns().length, 1);

  db.upsertLabel({ event_id: 'e1', by: 'ingress', correct: 1, actual: 'coyote', friendly: 0, note: 'clear', at: iso() });
  assert.equal(db.getLabel('e1').correct, 1);
  assert.equal(db.allLabels()[0].species, 'coyote');
  db.close();
});

test('cost accumulation is per day', () => {
  const db = new Db(':memory:');
  db.addCost('2026-09-16', 2200, 120, 0.0028);
  db.addCost('2026-09-16', 2100, 110, 0.0027);
  db.addCost('2026-08-31', 1000, 100, 0.0015);
  const row = db.get('SELECT * FROM costs WHERE day = ?', '2026-09-16');
  assert.equal(row.calls, 2);
  assert.equal(row.input_tokens, 4300);
  assert.equal(Number(row.usd.toFixed(4)), 0.0055);
  assert.equal(Number(db.spendForMonth('2026-09').usd.toFixed(4)), 0.0055);
  assert.equal(db.spendForMonth('2026-08').calls, 1);
  db.close();
});

test('listEvents filters', () => {
  const db = seed();
  db.upsertDecision({ event_id: 'e1', at: iso(), action: 'fire', reason: 'target', mode: 'immediate', knobs_json: '{}' });
  db.upsertDecision({ event_id: 'e2', at: iso(), action: 'skip', reason: 'person', mode: 'immediate', knobs_json: '{}' });
  db.upsertLabel({ event_id: 'e1', by: 'ingress', correct: 1, actual: null, friendly: 0, note: null, at: iso() });

  assert.equal(db.listEvents({}).length, 2);
  assert.equal(db.listEvents({ camera: '639481050' }).length, 1);
  assert.equal(db.listEvents({ label: 'human' })[0].event_id, 'e2');
  assert.equal(db.listEvents({ action: 'fire' })[0].event_id, 'e1');
  assert.equal(db.listEvents({ test: 'hide' }).length, 1);
  assert.equal(db.listEvents({ test: 'only' })[0].event_id, 'e2');
  assert.equal(db.listEvents({ unlabeled: true })[0].event_id, 'e2');
  assert.equal(db.listEvents({ limit: 1 }).length, 1);
  // newest first
  assert.equal(db.listEvents({})[0].event_id, 'e2');
  db.close();
});

test('decision state reports the last run and today count', () => {
  const db = seed();
  assert.deepEqual(db.decisionState(), { last_run_at: null, runs_today: 0 });
  const at = iso();
  db.insertRun({ event_id: 'e1', valve_id: 'v1', requested_s: 60, called_at: at, dry_run: 0 });
  db.insertRun({ event_id: 'e1', valve_id: 'v2', requested_s: 60, called_at: at, dry_run: 0 });
  const st = db.decisionState();
  assert.equal(st.last_run_at, at);
  assert.equal(st.runs_today, 1); // two valves, one event, one run for the cap
  db.close();
});

test('clip delay, runs per day, hour histogram and latencies', () => {
  const db = seed();
  const created = new Date(Date.now() - 120000).toISOString();
  db.updateEvent('e1', { clip_ready_at: new Date(Date.parse(created) + 45000).toISOString() });
  db.updateEvent('e1', { ring_created_at: created });
  assert.equal(db.clipDelaysSeconds()[0], 45);
  db.insertRun({ event_id: 'e1', valve_id: 'v1', requested_s: 60, called_at: iso(), confirmed_at: iso(9000), dry_run: 0 });
  assert.equal(db.runsPerDay(30).length, 1);
  assert.equal(db.eventsByHour().reduce((a, r) => a + r.n, 0), 2);
  assert.equal(db.latencies().length, 1);
  db.close();
});

test('label rates split day and night', () => {
  const db = new Db(':memory:');
  const mk = (id, hourLocal, action, correct) => {
    const d = new Date(); d.setHours(hourLocal, 0, 0, 0);
    db.insertEvent({ event_id: id, camera_id: 'c', ring_created_at: d.toISOString(), first_seen_at: d.toISOString(), source: 'poll', test: 0 });
    db.upsertDecision({ event_id: id, at: d.toISOString(), action, reason: 'target', mode: 'immediate', knobs_json: '{}' });
    db.upsertLabel({ event_id: id, by: 't', correct, actual: null, friendly: 0, note: null, at: d.toISOString() });
  };
  mk('d1', 12, 'fire', 1);
  mk('d2', 13, 'fire', 0);
  mk('n1', 22, 'fire', 0);
  mk('n2', 23, 'skip', 0);
  const r = db.labelRates();
  assert.equal(r.day.fired, 2);
  assert.equal(r.day.falseSprayRate, 0.5);
  assert.equal(r.night.falseSprayRate, 1);
  assert.equal(r.night.missRate, 1);
  db.close();
});

test('deleting test events removes their children and reports their media (review item 16)', () => {
  const db = seed();
  db.upsertDecision({ event_id: 'e2', at: iso(), action: 'skip', reason: 'person', mode: 'immediate', knobs_json: '{}' });
  db.insertRun({ event_id: 'e2', valve_id: 'v1', requested_s: 5, called_at: iso(), dry_run: 1 });
  db.updateEvent('e2', { clip_path: '/share/auto-ttds/clips/73991832/c.mp4', frames_json: '["e2_t1.jpg","e2_t3.jpg"]', snapshot_path: '/share/auto-ttds/frames/e2_snapshot.jpg' });
  const res = db.deleteTestEvents();
  assert.equal(res.count, 1);
  assert.deepEqual(res.clips, ['/share/auto-ttds/clips/73991832/c.mp4']);
  assert.deepEqual(res.frames, ['e2_t1.jpg', 'e2_t3.jpg']);
  assert.deepEqual(res.snapshots, ['/share/auto-ttds/frames/e2_snapshot.jpg']);
  assert.equal(db.countEvents(), 1);
  assert.equal(db.runsForEvent('e2').length, 0);
  assert.equal(db.getDecision('e2'), null);
  db.close();
});

test('the clip queue only holds greenlisted cameras (review item 8)', () => {
  const db = seed();
  const green = ['639481050', '73991832'];
  assert.equal(db.eventsAwaitingClip(green, 60).length, 2);
  assert.deepEqual(db.eventsAwaitingClip(['639481050'], 60).map((r) => r.event_id), ['e1']);
  assert.deepEqual(db.eventsAwaitingClip([], 60), []);
  db.updateEvent('e1', { clip_path: '/x.mp4' });
  assert.deepEqual(db.eventsAwaitingClip(green, 60).map((r) => r.event_id), ['e2']);
  db.close();
});

test('ineligible events cannot starve the verdict queue (review item 4)', () => {
  const db = new Db(':memory:');
  const green = ['639481050'];
  const add = (id, cameraId, label, offsetMs) => db.insertEvent({
    event_id: id, camera_id: cameraId, camera_name: 'c', ring_created_at: iso(offsetMs),
    first_seen_at: iso(offsetMs), source: 'poll', kind: 'motion', ring_label: label,
    recording_status: 'ready', frames_json: '["f.jpg"]', test: 0, raw_json: '{}',
  });
  // Six ineligible rows queued ahead of the one that matters, with a window of 5.
  add('x1', '700809115', 'animal', -6000);
  add('x2', '700809115', 'animal', -5000);
  add('x3', '639481050', null, -4000);
  add('x4', '639481050', null, -3000);
  add('x5', '700809115', null, -2000);
  add('x6', '639481050', null, -1000);
  add('good', '639481050', 'animal', 0);

  const queue = db.eventsAwaitingVerdict(green, 5);
  assert.deepEqual(queue.map((r) => r.event_id), ['good']);

  // An event with a verdict row drops out, error or not: classify() already made its one retry.
  db.upsertVerdict({ event_id: 'good', model: 'm', at: iso(), error: 'overloaded' });
  assert.deepEqual(db.eventsAwaitingVerdict(green, 5), []);
  assert.deepEqual(db.eventsAwaitingVerdict([], 5), []);
  db.close();
});

test('a snapshot alone is enough to enter the verdict queue', () => {
  const db = new Db(':memory:');
  db.insertEvent({ event_id: 's1', camera_id: '639481050', ring_created_at: iso(), first_seen_at: iso(), source: 'push', ring_label: 'animal', snapshot_path: '/f/s1_snapshot.jpg', test: 0 });
  assert.equal(db.eventsAwaitingVerdict(['639481050'], 5).length, 1);
  db.close();
});

test('deferred events come back for a second decision', () => {
  const db = seed();
  db.upsertDecision({ event_id: 'e1', at: iso(), action: 'defer', reason: 'target', mode: 'classifier_wait', knobs_json: '{}' });
  assert.equal(db.deferredEvents().length, 1);
  db.upsertDecision({ event_id: 'e1', at: iso(), action: 'fire', reason: 'target', mode: 'classifier_wait', knobs_json: '{}' });
  assert.equal(db.deferredEvents().length, 0);
  db.close();
});

test('pushes and meta', () => {
  const db = new Db(':memory:');
  assert.equal(db.countPushes(), 0);
  db.insertPush({ received_at: iso(), camera_id: '1', raw_json: '{}' });
  assert.equal(db.countPushes(), 1);
  assert.ok(db.lastPushAt());
  db.setMeta('k', 'v');
  assert.equal(db.getMeta('k'), 'v');
  assert.equal(db.getMeta('missing'), null);
  db.close();
});

test('the daily cap ignores dry runs (review item 11)', () => {
  const db = seed();
  db.insertRun({ event_id: 'e1', valve_id: 'v1', requested_s: 60, called_at: iso(), dry_run: 1 });
  db.insertRun({ event_id: 'e2', valve_id: 'v1', requested_s: 60, called_at: iso(), dry_run: 1 });
  assert.deepEqual(db.decisionState(), { last_run_at: null, runs_today: 0 });
  const at = iso();
  db.insertRun({ event_id: 'e1', valve_id: 'v2', requested_s: 60, called_at: at, dry_run: 0 });
  const st = db.decisionState();
  assert.equal(st.runs_today, 1);
  assert.equal(st.last_run_at, at);
  db.close();
});

test('one local-time helper set drives the cap, the tiles and the charts (review item 10)', () => {
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  assert.equal(localDayStartIso(noon), new Date(noon.getFullYear(), noon.getMonth(), noon.getDate()).toISOString());
  assert.equal(localDayKey(noon), `${noon.getFullYear()}-${String(noon.getMonth() + 1).padStart(2, '0')}-${String(noon.getDate()).padStart(2, '0')}`);
  assert.equal(localMonthKey(noon), localDayKey(noon).slice(0, 7));
  assert.equal(localHourOf(noon), 12);
  assert.equal(localDayKey('nonsense'), null);
  assert.equal(localHourOf('nonsense'), null);
  for (const h of [20, 22, 0, 5]) assert.equal(isNightHour(h), true, `hour ${h} is night`);
  for (const h of [6, 12, 19]) assert.equal(isNightHour(h), false, `hour ${h} is day`);
  assert.equal(isNightHour(null), false);

  // The histogram and the runs chart bucket by local time, not by the UTC string.
  const db = new Db(':memory:');
  const at = new Date(); at.setHours(23, 30, 0, 0);
  db.insertEvent({ event_id: 'l1', camera_id: 'c', ring_created_at: at.toISOString(), first_seen_at: at.toISOString(), source: 'poll', test: 0 });
  db.insertRun({ event_id: 'l1', valve_id: 'v1', requested_s: 60, called_at: at.toISOString(), dry_run: 0 });
  assert.deepEqual(db.eventsByHour(), [{ hour: 23, n: 1 }]);
  assert.deepEqual(db.runsPerDay(30), [{ day: localDayKey(at), n: 1 }]);
  assert.equal(db.countToday('events', 'first_seen_at'), 1);
  db.close();
});

test('patchDecisionKnobs merges without changing the decision (review item 6)', () => {
  const db = seed();
  db.upsertDecision({ event_id: 'e1', at: iso(), action: 'fire', reason: 'target', mode: 'immediate', knobs_json: JSON.stringify({ mode: 'immediate', would_suppress: 0 }) });
  assert.equal(db.patchDecisionKnobs('e1', { would_suppress: 1, friendly_species: 'rabbit' }), true);
  const row = db.getDecision('e1');
  assert.equal(row.action, 'fire');
  assert.equal(row.reason, 'target');
  const knobs = JSON.parse(row.knobs_json);
  assert.equal(knobs.would_suppress, 1);
  assert.equal(knobs.friendly_species, 'rabbit');
  assert.equal(knobs.mode, 'immediate');
  assert.equal(db.patchDecisionKnobs('missing', { would_suppress: 1 }), false);
  db.close();
});

test('median helper', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([9, 1, 5]), 5);
});
