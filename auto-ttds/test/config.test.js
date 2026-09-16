// Add-on options and HA helper knobs (spec 3, 4). No real options file is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOptions, parseKnobs, knobDefaults, KNOB_SPEC, KnobStore, OPTION_DEFAULTS } from '../src/config.js';
import { healthAttributes, healthState } from '../src/ha.js';

test('missing options file falls back to the defaults', () => {
  const opts = readOptions('/no/such/options.json', {});
  assert.equal(opts.classifier_model, 'claude-haiku-4-5');
  assert.equal(opts.data_dir, '/share/auto-ttds');
  assert.equal(opts.poll_interval_s, 10);
  assert.equal(opts.anthropic_api_key, '');
});

test('options.json wins, env is the fallback for a local run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttds-opt-'));
  const file = path.join(dir, 'options.json');
  fs.writeFileSync(file, JSON.stringify({ classifier_model: 'claude-sonnet-5', poll_interval_s: 30, data_dir: '/share/x' }));
  const opts = readOptions(file, { DATA_DIR: '/ignored', LOG_LEVEL: 'debug' });
  assert.equal(opts.classifier_model, 'claude-sonnet-5');
  assert.equal(opts.poll_interval_s, 30);
  assert.equal(opts.data_dir, '/share/x');
  assert.equal(opts.log_level, 'debug');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stale_after_s defaults to 300 and is clamped to the schema range (review 2 item 3)', () => {
  assert.equal(readOptions('/no/such/options.json', {}).stale_after_s, 300);
  assert.equal(OPTION_DEFAULTS.stale_after_s, 300);
  assert.equal(readOptions('/none', { STALE_AFTER_S: '600' }).stale_after_s, 600);
  assert.equal(readOptions('/none', { STALE_AFTER_S: '1' }).stale_after_s, 30);
  assert.equal(readOptions('/none', { STALE_AFTER_S: '99999' }).stale_after_s, 3600);
  assert.equal(readOptions('/none', { STALE_AFTER_S: 'junk' }).stale_after_s, 300);
});

test('poll interval is clamped to the schema range', () => {
  assert.equal(readOptions('/none', { POLL_INTERVAL_S: '1' }).poll_interval_s, 5);
  assert.equal(readOptions('/none', { POLL_INTERVAL_S: '9999' }).poll_interval_s, 120);
  assert.equal(readOptions('/none', { POLL_INTERVAL_S: 'junk' }).poll_interval_s, 10);
});

test('every option in the defaults is a documented knob path', () => {
  assert.deepEqual(Object.keys(OPTION_DEFAULTS).sort(), [
    'anthropic_api_key', 'classifier_model', 'data_dir', 'log_level', 'migrate_clips_dir',
    'migrate_events_jsonl', 'poll_interval_s', 'rachio_env_file', 'ring_system_id_file', 'ring_token_file',
    'stale_after_s',
  ]);
});

test('knob defaults match the spec 4 table', () => {
  const d = knobDefaults();
  assert.equal(d.enabled, true);
  assert.equal(d.dry_run, false);
  assert.equal(d.test_mode, false);
  assert.equal(d.mode, 'immediate');
  assert.equal(d.camera_greenlist, '639481050,73991832');
  assert.equal(d.target_labels, 'animal');
  assert.equal(d.friendlies, 'rabbit');
  assert.equal(d.valve_map, '*');
  assert.equal(d.run_seconds, 60);
  assert.equal(d.cooldown_seconds, 0);
  assert.equal(d.daily_cap, 0);
  assert.equal(d.blackout, '');
  assert.equal(d.skip_when_program_running, true);
  assert.equal(d.classifier_max_wait_s, 120);
  assert.equal(Object.keys(KNOB_SPEC).length, 14);
});

test('helper states are parsed, and a missing helper keeps its default', () => {
  const k = parseKnobs({
    'input_boolean.auto_ttds_enabled': 'off',
    'input_boolean.auto_ttds_dry_run': 'on',
    'input_select.auto_ttds_mode': 'classifier_wait',
    'input_number.auto_ttds_run_seconds': '90.0',
    'input_text.auto_ttds_friendlies': 'rabbit,squirrel',
    'input_number.auto_ttds_daily_cap': 'unknown',
  });
  assert.equal(k.enabled, false);
  assert.equal(k.dry_run, true);
  assert.equal(k.mode, 'classifier_wait');
  assert.equal(k.run_seconds, 90);
  assert.equal(k.friendlies, 'rabbit,squirrel');
  assert.equal(k.daily_cap, 0);
  assert.equal(k.test_mode, false);
});

test('KnobStore refreshes from HA and survives an outage', async () => {
  const store = new KnobStore({ getStates: async () => ({ 'input_boolean.auto_ttds_enabled': 'off' }) });
  await store.refresh();
  assert.equal(store.get().enabled, false);
  assert.ok(store.lastRefreshAt);

  const broken = new KnobStore({ getStates: async () => { throw new Error('supervisor down'); } });
  await broken.refresh();
  assert.equal(broken.get().enabled, true);
  assert.equal(broken.lastError, 'supervisor down');

  const noHa = new KnobStore(null);
  assert.deepEqual(await noHa.refresh(), knobDefaults());
});

test('health sensor payload (spec 6.7)', () => {
  const ok = healthAttributes({ pushConnected: true, lastPollOk: true, ringTokenAgeHours: 12.34, rachioError: null, lastPollAt: 'now' });
  assert.deepEqual(ok, { push_connected: true, last_poll_ok: true, ring_token_age_hours: 12.3, rachio_error: null, last_poll_at: 'now' });
  assert.equal(healthState(ok), 'ok');
  assert.equal(healthState(healthAttributes({ lastPollOk: true, rachioError: 'Rachio HTTP 401' })), 'error');
  assert.equal(healthState(healthAttributes({ lastPollOk: false })), 'error');
  assert.equal(healthAttributes({ ringTokenAgeHours: null }).ring_token_age_hours, null);
});
