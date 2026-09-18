// config.js: add-on options (spec 3) plus the HA helper knobs (spec 4).
// Options come from /data/options.json, which the Supervisor writes. There is no bashio in this
// container, so main.js reads that file directly; env vars are the fallback for a local run.
import fs from 'node:fs';

export const OPTION_DEFAULTS = {
  anthropic_api_key: '',
  classifier_model: 'claude-haiku-4-5',
  poll_interval_s: 10,
  ring_token_file: '/homeassistant/.auto-ttds/ring-token.json',
  ring_system_id_file: '/homeassistant/.auto-ttds/system-id',
  rachio_env_file: '/homeassistant/.auto-ttds/rachio.env',
  data_dir: '/share/auto-ttds',
  log_level: 'info',
  stale_after_s: 300, // review 2 item 3: an event older than this is backlog, never a trigger
  // Migration sources (spec 5). Kept as options so the paths are not hardcoded.
  migrate_events_jsonl: '/homeassistant/.auto-ttds/events.jsonl',
  migrate_clips_dir: '/homeassistant/.auto-ttds/data',
};

const ENV_KEYS = {
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  classifier_model: 'CLASSIFIER_MODEL',
  poll_interval_s: 'POLL_INTERVAL_S',
  ring_token_file: 'RING_TOKEN_FILE',
  ring_system_id_file: 'RING_SYSTEM_ID_FILE',
  rachio_env_file: 'RACHIO_ENV_FILE',
  data_dir: 'DATA_DIR',
  log_level: 'LOG_LEVEL',
  stale_after_s: 'STALE_AFTER_S',
  migrate_events_jsonl: 'MIGRATE_EVENTS_JSONL',
  migrate_clips_dir: 'MIGRATE_CLIPS_DIR',
};

export function readOptions(optionsFile = '/data/options.json', env = process.env) {
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(optionsFile, 'utf8'));
  } catch {
    fromFile = {}; // local run, or first boot before the Supervisor wrote the file
  }
  const opts = { ...OPTION_DEFAULTS };
  for (const key of Object.keys(OPTION_DEFAULTS)) {
    const v = fromFile[key] ?? env[ENV_KEYS[key]];
    if (v !== undefined && v !== null && v !== '') opts[key] = v;
  }
  opts.poll_interval_s = Math.min(120, Math.max(5, Number(opts.poll_interval_s) || 10));
  opts.stale_after_s = Math.min(3600, Math.max(30, Number(opts.stale_after_s) || 300));
  return opts;
}

// spec 4: helper entity -> knob. A missing helper falls back to the default.
// v0.3 changed two meanings and removed no helper: all fourteen stay as they are.
//  - target_labels now holds classifier species that fire, or "*" for any animal. It is no longer
//    read against the Ring label, which only ever decides "person" now.
//  - mode is recorded on every decision row and no longer changes anything: the classification
//    always comes first, so there is nothing left to wait for or to run ahead of.
export const KNOB_SPEC = {
  enabled: { entity: 'input_boolean.auto_ttds_enabled', type: 'bool', def: true },
  dry_run: { entity: 'input_boolean.auto_ttds_dry_run', type: 'bool', def: false },
  test_mode: { entity: 'input_boolean.auto_ttds_test_mode', type: 'bool', def: false },
  mode: { entity: 'input_select.auto_ttds_mode', type: 'str', def: 'immediate' },
  camera_greenlist: { entity: 'input_text.auto_ttds_camera_greenlist', type: 'str', def: '639481050,73991832' },
  target_labels: { entity: 'input_text.auto_ttds_target_labels', type: 'str', def: '*' },
  friendlies: { entity: 'input_text.auto_ttds_friendlies', type: 'str', def: 'rabbit' },
  valve_map: { entity: 'input_text.auto_ttds_valve_map', type: 'str', def: '*' },
  run_seconds: { entity: 'input_number.auto_ttds_run_seconds', type: 'num', def: 60 },
  cooldown_seconds: { entity: 'input_number.auto_ttds_cooldown_seconds', type: 'num', def: 0 },
  daily_cap: { entity: 'input_number.auto_ttds_daily_cap', type: 'num', def: 0 },
  blackout: { entity: 'input_text.auto_ttds_blackout', type: 'str', def: '' },
  skip_when_program_running: { entity: 'input_boolean.auto_ttds_skip_when_program_running', type: 'bool', def: true },
  classifier_max_wait_s: { entity: 'input_number.auto_ttds_classifier_max_wait_s', type: 'num', def: 120 },
};

export function knobDefaults() {
  const out = {};
  for (const [key, spec] of Object.entries(KNOB_SPEC)) out[key] = spec.def;
  return out;
}

// parseKnobs is pure: it takes a map of entity_id -> state string and returns the knob object.
export function parseKnobs(states) {
  const out = knobDefaults();
  for (const [key, spec] of Object.entries(KNOB_SPEC)) {
    const raw = states?.[spec.entity];
    if (raw === undefined || raw === null || raw === 'unknown' || raw === 'unavailable') continue;
    if (spec.type === 'bool') out[key] = String(raw) === 'on' || String(raw) === 'true';
    else if (spec.type === 'num') { const n = Number(raw); if (Number.isFinite(n)) out[key] = n; }
    else out[key] = String(raw);
  }
  return out;
}

// KnobStore keeps the latest knobs in memory. main.js refreshes it every 30 s (spec 4).
export class KnobStore {
  constructor(ha) {
    this.ha = ha;
    this.knobs = knobDefaults();
    this.lastRefreshAt = null;
    this.lastError = null;
  }

  get() { return this.knobs; }

  async refresh() {
    if (!this.ha) return this.knobs;
    try {
      const wanted = Object.values(KNOB_SPEC).map((s) => s.entity);
      const states = await this.ha.getStates(wanted);
      this.knobs = parseKnobs(states);
      this.lastRefreshAt = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
    }
    return this.knobs;
  }
}
