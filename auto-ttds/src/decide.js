// decide.js: the pure decision function, plus the pure valve-map helper.
// No I/O, no clock, no globals. Everything it needs arrives in the four arguments.
//
// v0.3 moved the classifier in front of the decision. decide() now reads the classifier species and
// never the Ring label: Ring's own label only decides whether an event is a person, which main.js
// handles before it spends anything on a classifier call.
// v0.4 dropped the mode knob and the no_verdict_timeout reason. Neither had any effect on anything
// this function returned.

// Every reason string the decisions table may hold (db.js, decisions.reason).
export const REASONS = [
  'target',
  'non_target',
  'not_greenlisted',
  'person',
  'no_animal', // v0.3: the classifier saw no animal, for example moving shade or an empty yard
  'friendly',
  'cooldown',
  'cap',
  'blackout',
  'program_running',
  'disabled',
  'dry_run',
  'test',
  'stale', // an event older than the backlog window never fires
  'classifier_error', // v0.3: no classification means no water, ever
];

const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((s) => String(s).trim().toLowerCase())
  .filter(Boolean);

export const DEFAULT_STALE_AFTER_S = 300;

/**
 * isStale: true when an event is old enough that firing on it would be spraying at nothing.
 * Cutoff from the stale_after_s add-on option.
 * Two independent rules: older than stale_after_s, or created before this process started.
 */
export function staleCutoffMs(staleAfterS) {
  const s = Number(staleAfterS);
  return (Number.isFinite(s) && s > 0 ? s : DEFAULT_STALE_AFTER_S) * 1000;
}

export function isStale(event, { now, processStartedAt, staleAfterS } = {}) {
  const created = ms(event?.ring_created_at ?? event?.first_seen_at);
  if (!Number.isFinite(created)) return false; // no timestamp to judge by, treat as live
  const at = ms(now ?? Date.now());
  if (created < at - staleCutoffMs(staleAfterS)) return true;
  if (processStartedAt !== undefined && processStartedAt !== null && created < ms(processStartedAt)) return true;
  return false;
}

/**
 * decide(event, verdict, knobs, state) -> {action, reason, ...flags}
 * action: 'fire' | 'skip'
 * flags: test, dryRun, warnings[]
 *
 * verdict is the classifier result. There is no decision without one, so a caller that has no
 * classification must not call this at all, with one exception: the greenlist check comes first, so
 * main.js decides a camera off the greenlist with no verdict and pays no classifier bill for it.
 */
export function decide(event, verdict, knobs, state) {
  const warnings = [];
  const k = knobs ?? {};
  const s = state ?? {};
  const now = ms(s.now ?? Date.now());
  const out = (action, reason, extra = {}) => ({
    action,
    reason,
    test: Boolean(k.test_mode),
    dryRun: Boolean(k.dry_run),
    warnings,
    ...extra,
  });

  // 1: master switch off means log only.
  if (k.enabled === false) return out('skip', 'disabled');

  // 2: test mode marks the event and continues. The flag rides on every result via out().

  // 3: camera greenlist. An empty greenlist is not a wildcard: nothing is green, so nothing fires.
  const green = list(k.camera_greenlist);
  if (!green.includes(String(event?.camera_id ?? '').toLowerCase())) {
    return out('skip', 'not_greenlisted');
  }

  const species = String(verdict?.species ?? '').trim().toLowerCase();

  // 4: people are never a target. is_person is derived from species === 'person'.
  if (species === 'person' || verdict?.is_person === true) return out('skip', 'person');

  // 5: nothing in the yard, for example moving shade.
  if (species === 'none') return out('skip', 'no_animal');

  // 6: the friendlies knob is the only source of friendliness. The model is not asked.
  if (species !== '' && list(k.friendlies).includes(species)) return out('skip', 'friendly');

  // 7: target_labels holds classifier species that fire, or "*" for any animal. Every species that
  // reaches this line is an animal, animal_unknown and eyes_unknown included. No classification at
  // all is never a target: an event with no species can never reach fire.
  const targets = list(k.target_labels);
  if (!(targets.includes('*') ? species !== '' : targets.includes(species))) {
    return out('skip', 'non_target');
  }

  // 8: cooldown.
  const cooldown = Number(k.cooldown_seconds ?? 0);
  if (cooldown > 0 && s.last_run_at != null && (now - ms(s.last_run_at)) < cooldown * 1000) {
    return out('skip', 'cooldown');
  }

  // 9: daily cap, 0 means none.
  const cap = Number(k.daily_cap ?? 0);
  if (cap > 0 && Number(s.runs_today ?? 0) >= cap) return out('skip', 'cap');

  // 10: v1 knows no blackout conditions. Any entry is warned about and ignored.
  const blackout = list(k.blackout);
  if (blackout.length) warnings.push(`blackout entries ignored in v1: ${blackout.join(',')}`);

  // 11: a Rachio program already watering a target valve wins. runDecision only looks this up after
  // every earlier check has passed, so skip paths make no Rachio calls.
  if (k.skip_when_program_running !== false && s.program_running === true) {
    return out('skip', 'program_running');
  }

  // 12 and 13: fire. dry_run rides as a flag, the reason stays target.
  return out('fire', 'target');
}

/**
 * resolveValves: pure valve-map reader for the input_text.auto_ttds_valve_map knob.
 * "*" means every known valve; otherwise "cameraId:valveId|valveId;cameraId:valveId".
 */
export function resolveValves(cameraId, valveMap, allValveIds) {
  const all = (allValveIds ?? []).map(String);
  const raw = String(valveMap ?? '*').trim();
  if (raw === '' || raw === '*') return all;
  for (const entry of raw.split(';')) {
    const [cam, valves] = entry.split(':');
    if (!cam || !valves) continue;
    if (cam.trim() !== String(cameraId)) continue;
    const picked = valves.split('|').map((v) => v.trim()).filter(Boolean);
    return picked.filter((v) => all.length === 0 || all.includes(v));
  }
  return [];
}
