// Table test for decide() covering every reason string in the decisions schema (spec 5, 7, 11.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, resolveValves, REASONS, isStale, staleCutoffMs, DEFAULT_STALE_AFTER_S } from '../src/decide.js';

const T0 = Date.parse('2026-09-16T12:00:00.000Z');

const knobs = (over = {}) => ({
  enabled: true,
  dry_run: false,
  test_mode: false,
  mode: 'immediate',
  camera_greenlist: '639481050,73991832',
  target_labels: 'animal',
  friendlies: 'rabbit',
  valve_map: '*',
  run_seconds: 60,
  cooldown_seconds: 0,
  daily_cap: 0,
  blackout: '',
  skip_when_program_running: true,
  classifier_max_wait_s: 120,
  ...over,
});

const event = (over = {}) => ({
  event_id: 'e1',
  camera_id: '639481050',
  ring_label: 'animal',
  first_seen_at: new Date(T0).toISOString(),
  ...over,
});

const state = (over = {}) => ({ now: T0, last_run_at: null, runs_today: 0, program_running: false, ...over });

const verdict = (over = {}) => ({ species: 'coyote', count: 1, is_person: false, friendly: false, confidence: 0.9, ...over });

const CASES = [
  // [name, event, verdict, knobs, state, expected action, expected reason]
  ['disabled master switch', event(), null, knobs({ enabled: false }), state(), 'skip', 'disabled'],
  ['camera off the greenlist', event({ camera_id: '700809115' }), null, knobs(), state(), 'skip', 'not_greenlisted'],
  ['human Ring label', event({ ring_label: 'human' }), null, knobs(), state(), 'skip', 'person'],
  ['person in the verdict', event(), verdict({ is_person: true, species: 'person' }), knobs({ mode: 'classifier_wait' }), state(), 'skip', 'person'],
  ['non target Ring label', event({ ring_label: 'other_motion' }), null, knobs(), state(), 'skip', 'non_target'],
  ['null Ring label counts as non target', event({ ring_label: null }), null, knobs(), state(), 'skip', 'non_target'],
  ['classifier_wait defers before the timeout', event(), null, knobs({ mode: 'classifier_wait' }), state({ now: T0 + 30000 }), 'defer', 'target'],
  ['classifier_wait fires on timeout', event(), null, knobs({ mode: 'classifier_wait' }), state({ now: T0 + 121000 }), 'fire', 'no_verdict_timeout'],
  ['classifier_wait suppresses a friendly', event(), verdict({ species: 'rabbit' }), knobs({ mode: 'classifier_wait' }), state(), 'skip', 'friendly'],
  ['classifier_wait honors the friendly flag from the model', event(), verdict({ species: 'hare', friendly: true }), knobs({ mode: 'classifier_wait' }), state(), 'skip', 'friendly'],
  ['cooldown not elapsed', event(), null, knobs({ cooldown_seconds: 300 }), state({ last_run_at: new Date(T0 - 60000).toISOString() }), 'skip', 'cooldown'],
  ['daily cap reached', event(), null, knobs({ daily_cap: 5 }), state({ runs_today: 5 }), 'skip', 'cap'],
  ['program running on a target valve', event(), null, knobs(), state({ program_running: true }), 'skip', 'program_running'],
  ['plain target fires', event(), null, knobs(), state(), 'fire', 'target'],
  ['dry run still fires, with the flag', event(), null, knobs({ dry_run: true }), state(), 'fire', 'target'],
];

test('decide table', async (t) => {
  for (const [name, e, v, k, s, action, reason] of CASES) {
    await t.test(name, () => {
      const r = decide(e, v, k, s);
      assert.equal(r.action, action, `${name}: action`);
      assert.equal(r.reason, reason, `${name}: reason`);
    });
  }
});

test('every reason string in the schema is accounted for', () => {
  const emitted = new Set(CASES.map(([, , , , , , reason]) => reason));
  // Reachable reasons are all exercised by the table above.
  for (const r of ['disabled', 'not_greenlisted', 'person', 'non_target', 'no_verdict_timeout', 'friendly', 'cooldown', 'cap', 'program_running', 'target']) {
    assert.ok(emitted.has(r), `reason ${r} is covered by the table`);
  }
  // The remaining three are schema slots that v1 deliberately never emits (spec 7.2, 7.10, 7.12).
  for (const r of ['blackout', 'dry_run', 'test']) {
    assert.ok(REASONS.includes(r), `reason ${r} is a known slot`);
    assert.ok(!emitted.has(r), `reason ${r} is not emitted in v1`);
  }
  // stale is emitted by main.js before decide() ever runs (review item 1), covered in main.test.js.
  assert.ok(REASONS.includes('stale'));
  assert.equal(REASONS.length, 14);
});

test('blackout entries are warned about and ignored, not a skip (spec 7.10)', () => {
  const r = decide(event(), null, knobs({ blackout: 'sleeping,party' }), state());
  assert.equal(r.action, 'fire');
  assert.equal(r.reason, 'target');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /blackout entries ignored/);
});

test('dry run rides as a flag with reason target (spec 7.12)', () => {
  const r = decide(event(), null, knobs({ dry_run: true }), state());
  assert.equal(r.dryRun, true);
  assert.equal(r.reason, 'target');
});

test('test mode marks the event and continues (spec 7.2)', () => {
  const r = decide(event(), null, knobs({ test_mode: true }), state());
  assert.equal(r.test, true);
  assert.equal(r.action, 'fire');
  const skipped = decide(event({ camera_id: 'nope' }), null, knobs({ test_mode: true }), state());
  assert.equal(skipped.test, true);
  assert.equal(skipped.reason, 'not_greenlisted');
});

test('immediate mode records a friendly as would_suppress instead of skipping (spec 7.7)', () => {
  const r = decide(event(), verdict({ species: 'rabbit' }), knobs(), state());
  assert.equal(r.action, 'fire');
  assert.equal(r.reason, 'target');
  assert.equal(r.wouldSuppress, 1);
});

test('classifier_wait lets the verdict overrule a non target Ring label', () => {
  const r = decide(event({ ring_label: 'other_motion' }), verdict(), knobs({ mode: 'classifier_wait' }), state());
  assert.equal(r.action, 'fire');
  assert.equal(r.reason, 'target');
});

test('cooldown of zero never blocks', () => {
  const r = decide(event(), null, knobs({ cooldown_seconds: 0 }), state({ last_run_at: new Date(T0 - 1000).toISOString() }));
  assert.equal(r.action, 'fire');
});

test('daily cap of zero means no cap', () => {
  const r = decide(event(), null, knobs({ daily_cap: 0 }), state({ runs_today: 500 }));
  assert.equal(r.action, 'fire');
});

test('skip_when_program_running off ignores a running program', () => {
  const r = decide(event(), null, knobs({ skip_when_program_running: false }), state({ program_running: true }));
  assert.equal(r.action, 'fire');
});

test('decide is pure: it does not mutate its arguments', () => {
  const e = event(); const k = knobs(); const s = state();
  const snapshot = JSON.stringify([e, k, s]);
  decide(e, verdict(), k, s);
  assert.equal(JSON.stringify([e, k, s]), snapshot);
});

test('resolveValves reads the valve map knob', () => {
  const all = ['v1', 'v2', 'v3'];
  assert.deepEqual(resolveValves('639481050', '*', all), all);
  assert.deepEqual(resolveValves('639481050', '', all), all);
  assert.deepEqual(resolveValves('639481050', '639481050:v1|v3;73991832:v2', all), ['v1', 'v3']);
  assert.deepEqual(resolveValves('73991832', '639481050:v1|v3;73991832:v2', all), ['v2']);
  assert.deepEqual(resolveValves('700809115', '639481050:v1', all), []);
  assert.deepEqual(resolveValves('639481050', '639481050:vX', all), []);
});

test('an empty greenlist means nothing may trigger (review item 7)', () => {
  for (const empty of ['', '   ', ',,', []]) {
    const r = decide(event(), null, knobs({ camera_greenlist: empty }), state());
    assert.equal(r.action, 'skip', `greenlist ${JSON.stringify(empty)}`);
    assert.equal(r.reason, 'not_greenlisted');
  }
});

test('stale events are backlog, not triggers (review item 1, cutoff from the option)', () => {
  const started = '2026-09-16T12:00:00.000Z';
  const now = Date.parse(started) + 5000;
  const old = '2026-01-01T00:00:00.000Z'; // a start time that cannot trip the second rule

  // The default cutoff is the stale_after_s default, 300 s (review 2 item 3).
  assert.equal(DEFAULT_STALE_AFTER_S, 300);
  assert.equal(staleCutoffMs(undefined), 300000);
  assert.equal(staleCutoffMs(600), 600000);
  assert.equal(staleCutoffMs('junk'), 300000);
  assert.equal(staleCutoffMs(0), 300000);

  // Older than the default cutoff
  assert.equal(isStale({ ring_created_at: new Date(now - 400000).toISOString() }, { now, processStartedAt: old }), true);
  // Inside the default cutoff
  assert.equal(isStale({ ring_created_at: new Date(now - 120000).toISOString() }, { now, processStartedAt: old }), false);
  // A configured cutoff overrides it in both directions
  assert.equal(isStale({ ring_created_at: new Date(now - 120000).toISOString() }, { now, processStartedAt: old, staleAfterS: 60 }), true);
  assert.equal(isStale({ ring_created_at: new Date(now - 400000).toISOString() }, { now, processStartedAt: old, staleAfterS: 3600 }), false);
  // The processStartedAt rule survives any cutoff: fresh, but from before this boot
  assert.equal(isStale({ ring_created_at: new Date(Date.parse(started) - 1000).toISOString() }, { now, processStartedAt: started, staleAfterS: 3600 }), true);
  // No timestamp to judge by
  assert.equal(isStale({}, { now, processStartedAt: started }), false);
});
