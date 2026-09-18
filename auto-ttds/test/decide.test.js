// Table test for decide() covering every reason string it can emit (db.js schema comment, spec 11.1).
// v0.3: the classification decides. The Ring label is not an input to decide() at all.
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
  target_labels: '*',
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

const verdict = (over = {}) => ({ species: 'coyote', count: 1, is_person: false, confidence: 0.9, ...over });

const CASES = [
  // [name, event, verdict, knobs, state, expected action, expected reason]
  ['disabled master switch', event(), verdict(), knobs({ enabled: false }), state(), 'skip', 'disabled'],
  ['camera off the greenlist', event({ camera_id: '700809115' }), verdict(), knobs(), state(), 'skip', 'not_greenlisted'],
  ['camera off the greenlist with no classification at all', event({ camera_id: '700809115' }), null, knobs(), state(), 'skip', 'not_greenlisted'],
  ['the classifier saw a person', event(), verdict({ species: 'person', is_person: true }), knobs(), state(), 'skip', 'person'],
  ['the classifier saw nothing', event(), verdict({ species: 'none' }), knobs(), state(), 'skip', 'no_animal'],
  ['a friendly species', event(), verdict({ species: 'rabbit' }), knobs(), state(), 'skip', 'friendly'],
  ['a species off a named target list', event(), verdict({ species: 'cat' }), knobs({ target_labels: 'coyote,raccoon' }), state(), 'skip', 'non_target'],
  ['no classification never fires', event(), null, knobs(), state(), 'skip', 'non_target'],
  ['cooldown not elapsed', event(), verdict(), knobs({ cooldown_seconds: 300 }), state({ last_run_at: new Date(T0 - 60000).toISOString() }), 'skip', 'cooldown'],
  ['daily cap reached', event(), verdict(), knobs({ daily_cap: 5 }), state({ runs_today: 5 }), 'skip', 'cap'],
  ['program running on a target valve', event(), verdict(), knobs(), state({ program_running: true }), 'skip', 'program_running'],
  ['a classified animal fires', event(), verdict(), knobs(), state(), 'fire', 'target'],
  ['an unidentified animal fires under the wildcard', event(), verdict({ species: 'animal_unknown' }), knobs(), state(), 'fire', 'target'],
  ['eyeshine at night fires under the wildcard', event(), verdict({ species: 'eyes_unknown' }), knobs(), state(), 'fire', 'target'],
  ['a named target species fires', event(), verdict({ species: 'raccoon' }), knobs({ target_labels: 'coyote,raccoon' }), state(), 'fire', 'target'],
  ['dry run still fires, with the flag', event(), verdict(), knobs({ dry_run: true }), state(), 'fire', 'target'],
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
  for (const r of ['disabled', 'not_greenlisted', 'person', 'no_animal', 'friendly', 'non_target', 'cooldown', 'cap', 'program_running', 'target']) {
    assert.ok(emitted.has(r), `reason ${r} is covered by the table`);
  }
  // Schema slots decide() deliberately never emits.
  for (const r of ['blackout', 'dry_run', 'test', 'no_verdict_timeout']) {
    assert.ok(REASONS.includes(r), `reason ${r} is a known slot`);
    assert.ok(!emitted.has(r), `reason ${r} is not emitted`);
  }
  // main.js writes these two before or instead of a classification, covered in main.test.js.
  assert.ok(REASONS.includes('stale'));
  assert.ok(REASONS.includes('classifier_error'));
  assert.equal(REASONS.length, 16);
});

test('the Ring label is not an input to the decision (v0.3)', () => {
  // A human Ring label on an animal verdict still fires: main.js decides the person case before it
  // ever classifies, so by the time decide() runs the only word that counts is the species.
  const fired = decide(event({ ring_label: 'human' }), verdict({ species: 'coyote' }), knobs(), state());
  assert.equal(fired.action, 'fire');
  assert.equal(fired.reason, 'target');
  // And an "other_motion" Ring label no longer suppresses a real animal.
  const other = decide(event({ ring_label: 'other_motion' }), verdict({ species: 'raccoon' }), knobs(), state());
  assert.equal(other.action, 'fire');
  // A null label is not a target list entry any more either.
  const none = decide(event({ ring_label: null }), verdict({ species: 'deer' }), knobs(), state());
  assert.equal(none.action, 'fire');
});

test('the friendlies knob is the only source of friendliness', () => {
  // A friendly flag the model volunteered is not read: only the knob suppresses.
  const r = decide(event(), verdict({ species: 'cat', friendly: true }), knobs({ friendlies: 'rabbit' }), state());
  assert.equal(r.action, 'fire');
  const suppressed = decide(event(), verdict({ species: 'cat' }), knobs({ friendlies: 'rabbit,cat' }), state());
  assert.equal(suppressed.action, 'skip');
  assert.equal(suppressed.reason, 'friendly');
});

test('an is_person verdict is a person whatever the species field says', () => {
  const r = decide(event(), { species: 'cat', is_person: true }, knobs(), state());
  assert.equal(r.reason, 'person');
});

test('target_labels of * means any animal, and a named list means only those', () => {
  const wildcard = knobs({ target_labels: '*' });
  for (const species of ['cat', 'coyote', 'animal_unknown', 'eyes_unknown', 'squirrel']) {
    assert.equal(decide(event(), verdict({ species }), wildcard, state()).action, 'fire', species);
  }
  const named = knobs({ target_labels: 'coyote' });
  assert.equal(decide(event(), verdict({ species: 'coyote' }), named, state()).action, 'fire');
  assert.equal(decide(event(), verdict({ species: 'animal_unknown' }), named, state()).reason, 'non_target');
});

test('blackout entries are warned about and ignored, not a skip (spec 7.10)', () => {
  const r = decide(event(), verdict(), knobs({ blackout: 'sleeping,party' }), state());
  assert.equal(r.action, 'fire');
  assert.equal(r.reason, 'target');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /blackout entries ignored/);
});

test('dry run rides as a flag with reason target (spec 7.12)', () => {
  const r = decide(event(), verdict(), knobs({ dry_run: true }), state());
  assert.equal(r.dryRun, true);
  assert.equal(r.reason, 'target');
});

test('test mode marks the event and continues (spec 7.2)', () => {
  const r = decide(event(), verdict(), knobs({ test_mode: true }), state());
  assert.equal(r.test, true);
  assert.equal(r.action, 'fire');
  const skipped = decide(event({ camera_id: 'nope' }), verdict(), knobs({ test_mode: true }), state());
  assert.equal(skipped.test, true);
  assert.equal(skipped.reason, 'not_greenlisted');
});

test('cooldown of zero never blocks', () => {
  const r = decide(event(), verdict(), knobs({ cooldown_seconds: 0 }), state({ last_run_at: new Date(T0 - 1000).toISOString() }));
  assert.equal(r.action, 'fire');
});

test('daily cap of zero means no cap', () => {
  const r = decide(event(), verdict(), knobs({ daily_cap: 0 }), state({ runs_today: 500 }));
  assert.equal(r.action, 'fire');
});

test('skip_when_program_running off ignores a running program', () => {
  const r = decide(event(), verdict(), knobs({ skip_when_program_running: false }), state({ program_running: true }));
  assert.equal(r.action, 'fire');
});

test('decide is pure: it does not mutate its arguments', () => {
  const e = event(); const k = knobs(); const s = state(); const v = verdict();
  const snapshot = JSON.stringify([e, v, k, s]);
  decide(e, v, k, s);
  assert.equal(JSON.stringify([e, v, k, s]), snapshot);
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
    const r = decide(event(), verdict(), knobs({ camera_greenlist: empty }), state());
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
