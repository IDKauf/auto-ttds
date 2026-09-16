// decide.js: the pure decision function from spec section 7, plus the pure valve-map helper.
// No I/O, no clock, no globals. Everything it needs arrives in the four arguments.

// Every reason string the decisions table may hold (spec 5, decisions.reason).
export const REASONS = [
  'target',
  'non_target',
  'not_greenlisted',
  'person',
  'friendly',
  'cooldown',
  'cap',
  'blackout',
  'program_running',
  'disabled',
  'dry_run',
  'test',
  'no_verdict_timeout',
  'stale', // review item 1: an event older than the backlog window never fires
];

const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((s) => String(s).trim().toLowerCase())
  .filter(Boolean);

export const DEFAULT_STALE_AFTER_S = 300;

/**
 * isStale: true when an event is old enough that firing on it would be spraying at nothing.
 * Review item 1, cutoff from the stale_after_s add-on option (review 2 item 3).
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
 * action: 'fire' | 'skip' | 'defer'
 * flags: test, dryRun, wouldSuppress, warnings[]
 */
export function decide(event, verdict, knobs, state) {
  const warnings = [];
  const k = knobs ?? {};
  const s = state ?? {};
  const now = ms(s.now ?? Date.now());
  const mode = k.mode === 'classifier_wait' ? 'classifier_wait' : 'immediate';
  const out = (action, reason, extra = {}) => ({
    action,
    reason,
    test: Boolean(k.test_mode),
    dryRun: Boolean(k.dry_run),
    wouldSuppress: 0,
    warnings,
    mode,
    ...extra,
  });

  // spec 7.1: master switch off means log only.
  if (k.enabled === false) return out('skip', 'disabled');

  // spec 7.2: test mode marks the event and continues. The flag rides on every result via out().

  // spec 7.3: camera greenlist.
  // Review item 7: an empty greenlist is not a wildcard. Nothing is green, so nothing fires.
  const green = list(k.camera_greenlist);
  if (!green.includes(String(event?.camera_id ?? '').toLowerCase())) {
    return out('skip', 'not_greenlisted');
  }

  // spec 7.4: people are never a target, from either source.
  const ringLabel = String(event?.ring_label ?? '').trim().toLowerCase();
  if (ringLabel === 'human' || verdict?.is_person === true) return out('skip', 'person');

  // spec 7.5: non-target Ring label, when the verdict cannot overrule it yet.
  const targets = list(k.target_labels);
  const isTargetLabel = ringLabel !== '' && targets.includes(ringLabel);
  if (!isTargetLabel && (mode === 'immediate' || !verdict)) return out('skip', 'non_target');

  // spec 7.6 / 6.5: classifier_wait defers until the verdict lands or the wait expires.
  const timedOut = (now - ms(event?.first_seen_at ?? now)) >= Number(k.classifier_max_wait_s ?? 120) * 1000;
  let timeoutFire = false;
  if (mode === 'classifier_wait' && !verdict) {
    if (!timedOut) return out('defer', 'target');
    // Timed out with no verdict: fire on the strength of the Ring label alone.
    timeoutFire = true;
  }

  // spec 7.7: friendlies suppress in classifier_wait, and are informational in immediate mode.
  const friendlies = list(k.friendlies);
  const species = String(verdict?.species ?? '').trim().toLowerCase();
  const isFriendly = verdict ? (verdict.friendly === true || (species !== '' && friendlies.includes(species))) : false;
  let wouldSuppress = 0;
  if (isFriendly) {
    if (mode === 'classifier_wait') return out('skip', 'friendly');
    wouldSuppress = 1; // immediate mode: recorded in decisions.knobs_json, not a skip
  }

  // spec 7.8: cooldown.
  const cooldown = Number(k.cooldown_seconds ?? 0);
  if (cooldown > 0 && s.last_run_at != null && (now - ms(s.last_run_at)) < cooldown * 1000) {
    return out('skip', 'cooldown', { wouldSuppress });
  }

  // spec 7.9: daily cap, 0 means none.
  const cap = Number(k.daily_cap ?? 0);
  if (cap > 0 && Number(s.runs_today ?? 0) >= cap) return out('skip', 'cap', { wouldSuppress });

  // spec 7.10: v1 knows no blackout conditions. Any entry is warned about and ignored.
  const blackout = list(k.blackout);
  if (blackout.length) warnings.push(`blackout entries ignored in v1: ${blackout.join(',')}`);

  // spec 7.11: a Rachio program already watering a target valve wins. runDecision only looks this
  // up after every earlier check has passed (review item 9), so skip paths make no Rachio calls.
  if (k.skip_when_program_running !== false && s.program_running === true) {
    return out('skip', 'program_running', { wouldSuppress });
  }

  // spec 7.12 and 7.13: fire. dry_run rides as a flag, the reason stays target.
  return out('fire', timeoutFire ? 'no_verdict_timeout' : 'target', { wouldSuppress });
}

/**
 * resolveValves: pure valve-map reader for the input_text.auto_ttds_valve_map knob (spec 4).
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
