// db.js: SQLite schema and queries (spec section 5), on the built-in node:sqlite module.
// No native build step, which is why the Dockerfile needs no python3/make/g++.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, camera_id TEXT, camera_name TEXT, ring_created_at TEXT, first_seen_at TEXT,
  source TEXT, kind TEXT, ring_label TEXT, ring_labels_json TEXT, recording_status TEXT,
  clip_path TEXT, clip_ready_at TEXT, frames_json TEXT, snapshot_path TEXT,
  test INTEGER DEFAULT 0, raw_json TEXT);
CREATE TABLE IF NOT EXISTS verdicts (
  event_id TEXT PRIMARY KEY, model TEXT, species TEXT, count INTEGER, is_person INTEGER, friendly INTEGER,
  confidence REAL, frames_agree INTEGER, raw_json TEXT, input_tokens INTEGER, output_tokens INTEGER,
  usd REAL, latency_ms INTEGER, at TEXT, error TEXT);
-- decisions.reason: target | non_target | not_greenlisted | person | friendly | cooldown | cap |
--   blackout | program_running | disabled | dry_run | test | no_verdict_timeout | stale
CREATE TABLE IF NOT EXISTS decisions (
  event_id TEXT PRIMARY KEY, at TEXT, action TEXT, reason TEXT, mode TEXT, knobs_json TEXT);
CREATE TABLE IF NOT EXISTS runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, valve_id TEXT, valve_name TEXT,
  -- runs.stopped_by: duration | person | manual | shutdown | null
  requested_s INTEGER, called_at TEXT, http_ms INTEGER, http_status INTEGER, confirmed_at TEXT,
  cleared_at TEXT, stopped_by TEXT, error TEXT, dry_run INTEGER);
CREATE TABLE IF NOT EXISTS labels (
  event_id TEXT PRIMARY KEY, by TEXT, correct INTEGER, actual TEXT, friendly INTEGER, note TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT, camera_id TEXT, raw_json TEXT);
CREATE TABLE IF NOT EXISTS costs (
  day TEXT PRIMARY KEY, calls INTEGER, input_tokens INTEGER, output_tokens INTEGER, usd REAL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS events_created ON events(ring_created_at);
CREATE INDEX IF NOT EXISTS events_camera ON events(camera_id);
CREATE INDEX IF NOT EXISTS runs_event ON runs(event_id);
CREATE INDEX IF NOT EXISTS runs_called ON runs(called_at);
`;

const EVENT_COLS = ['event_id', 'camera_id', 'camera_name', 'ring_created_at', 'first_seen_at', 'source',
  'kind', 'ring_label', 'ring_labels_json', 'recording_status', 'clip_path', 'clip_ready_at',
  'frames_json', 'snapshot_path', 'test', 'raw_json'];

const VERDICT_COLS = ['event_id', 'model', 'species', 'count', 'is_person', 'friendly', 'confidence',
  'frames_agree', 'raw_json', 'input_tokens', 'output_tokens', 'usd', 'latency_ms', 'at', 'error'];

const RUN_COLS = ['event_id', 'valve_id', 'valve_name', 'requested_s', 'called_at', 'http_ms',
  'http_status', 'confirmed_at', 'cleared_at', 'stopped_by', 'error', 'dry_run'];

// node:sqlite binds only null, number, bigint, string and Buffer.
const bind = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
};

const cols = (names) => names.join(', ');
const marks = (names) => names.map(() => '?').join(', ');
const upserts = (names, key) => names.filter((n) => n !== key).map((n) => `${n}=excluded.${n}`).join(', ');

// ---- local time (review item 10) --------------------------------------------
// Everything stored is UTC ISO. Anything Ian reads as "today", "this hour" or "at night" is local,
// so these three helpers are the only place a local conversion happens.

/** Local midnight for the day containing `now`, as a UTC ISO string for SQL comparison. */
export function localDayStartIso(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Local calendar day of an instant, as YYYY-MM-DD. */
export function localDayKey(at = new Date()) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local calendar month of an instant, as YYYY-MM. */
export function localMonthKey(at = new Date()) {
  const key = localDayKey(at);
  return key ? key.slice(0, 7) : null;
}

/** Local hour of an instant, 0 to 23, or null when the timestamp is unusable. */
export function localHourOf(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.getHours();
}

/** Night is 20:00 to 05:59 local (spec 8.1 splits day and night). */
export function isNightHour(hour) {
  return hour === null ? false : (hour >= 20 || hour < 6);
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export class Db {
  /** file ':memory:' gives the in-memory database the tests use. */
  constructor(file) {
    if (file && file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file ?? ':memory:');
    this.sql.exec('PRAGMA journal_mode = WAL;');
    this.sql.exec(SCHEMA);
  }

  close() { try { this.sql.close(); } catch { /* already closed */ } }

  run(query, ...params) { return this.sql.prepare(query).run(...params.map(bind)); }
  get(query, ...params) { return this.sql.prepare(query).get(...params.map(bind)); }
  all(query, ...params) { return this.sql.prepare(query).all(...params.map(bind)); }

  // ---- meta -------------------------------------------------------------
  getMeta(key) { return this.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null; }
  setMeta(key, value) { this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }

  // ---- events -----------------------------------------------------------
  /** Insert if new, keep the existing row otherwise. Returns true when a row was created. */
  insertEvent(row) {
    const values = EVENT_COLS.map((c) => bind(row[c]));
    const res = this.run(
      `INSERT INTO events (${cols(EVENT_COLS)}) VALUES (${marks(EVENT_COLS)}) ON CONFLICT(event_id) DO NOTHING`,
      ...values,
    );
    return res.changes > 0;
  }

  /** Push ingest and late media both patch an existing row, or create one (spec 6.1, 6.3). */
  upsertEvent(row) {
    const present = EVENT_COLS.filter((c) => row[c] !== undefined);
    this.run(
      `INSERT INTO events (${cols(present)}) VALUES (${marks(present)})
       ON CONFLICT(event_id) DO UPDATE SET ${upserts(present, 'event_id')}`,
      ...present.map((c) => bind(row[c])),
    );
  }

  updateEvent(eventId, patch) {
    const present = Object.keys(patch).filter((c) => EVENT_COLS.includes(c) && c !== 'event_id');
    if (!present.length) return;
    this.run(
      `UPDATE events SET ${present.map((c) => `${c} = ?`).join(', ')} WHERE event_id = ?`,
      ...present.map((c) => bind(patch[c])), eventId,
    );
  }

  getEvent(eventId) { return this.get('SELECT * FROM events WHERE event_id = ?', eventId) ?? null; }
  hasEvent(eventId) { return Boolean(this.get('SELECT 1 AS x FROM events WHERE event_id = ?', eventId)); }
  countEvents() { return this.get('SELECT COUNT(*) AS n FROM events').n; }

  /**
   * Events with no clip yet, for the recording-URL retry loop (spec 6.3).
   * Only greenlisted cameras get media: an ignored camera is polled for the events table alone
   * (review item 8).
   */
  eventsAwaitingClip(greenCameraIds = [], maxAgeMinutes = 15) {
    const green = (greenCameraIds ?? []).map(String).filter(Boolean);
    if (!green.length) return [];
    const marks = green.map(() => '?').join(', ');
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60000).toISOString();
    return this.all(
      `SELECT * FROM events WHERE clip_path IS NULL AND first_seen_at >= ? AND camera_id IN (${marks})
       ORDER BY first_seen_at ASC LIMIT 50`,
      cutoff, ...green,
    );
  }

  /**
   * Events with media and no verdict yet (spec 6.4), filtered in SQL so that ineligible rows can
   * never starve the LIMIT window (review item 4). Ineligible means: camera off the greenlist,
   * or no Ring label. An existing verdict row excludes the event whether or not it holds an error,
   * because classify() already made its one in-call retry before writing that row.
   */
  eventsAwaitingVerdict(greenCameraIds = [], limit = 10) {
    const green = (greenCameraIds ?? []).map(String).filter(Boolean);
    if (!green.length) return [];
    const marks = green.map(() => '?').join(', ');
    return this.all(
      `SELECT e.* FROM events e LEFT JOIN verdicts v ON v.event_id = e.event_id
       WHERE v.event_id IS NULL
         AND (e.frames_json IS NOT NULL OR e.snapshot_path IS NOT NULL)
         AND e.camera_id IN (${marks})
         AND e.ring_label IS NOT NULL
       ORDER BY e.first_seen_at ASC LIMIT ?`, ...green, limit,
    );
  }

  // ---- verdicts / decisions --------------------------------------------
  upsertVerdict(row) {
    this.run(
      `INSERT INTO verdicts (${cols(VERDICT_COLS)}) VALUES (${marks(VERDICT_COLS)})
       ON CONFLICT(event_id) DO UPDATE SET ${upserts(VERDICT_COLS, 'event_id')}`,
      ...VERDICT_COLS.map((c) => bind(row[c])),
    );
  }

  getVerdict(eventId) { return this.get('SELECT * FROM verdicts WHERE event_id = ?', eventId) ?? null; }

  upsertDecision(row) {
    this.run(
      `INSERT INTO decisions (event_id, at, action, reason, mode, knobs_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET at=excluded.at, action=excluded.action, reason=excluded.reason,
       mode=excluded.mode, knobs_json=excluded.knobs_json`,
      row.event_id, row.at, row.action, row.reason, row.mode, row.knobs_json,
    );
  }

  getDecision(eventId) { return this.get('SELECT * FROM decisions WHERE event_id = ?', eventId) ?? null; }

  /**
   * Merge keys into decisions.knobs_json in place (review item 6). Used when a verdict lands after
   * an immediate-mode decision: the record gains would_suppress, the decision itself does not change.
   */
  patchDecisionKnobs(eventId, patch) {
    const row = this.getDecision(eventId);
    if (!row) return false;
    let knobs = {};
    try { knobs = JSON.parse(row.knobs_json ?? '{}'); } catch { knobs = {}; }
    this.run('UPDATE decisions SET knobs_json = ? WHERE event_id = ?', JSON.stringify({ ...knobs, ...patch }), eventId);
    return true;
  }

  /** Events still waiting on a classifier verdict in classifier_wait mode (spec 6.5). */
  deferredEvents() {
    return this.all("SELECT * FROM events WHERE event_id IN (SELECT event_id FROM decisions WHERE action = 'defer')");
  }

  // ---- runs -------------------------------------------------------------
  insertRun(row) {
    const res = this.run(
      `INSERT INTO runs (${cols(RUN_COLS)}) VALUES (${marks(RUN_COLS)})`,
      ...RUN_COLS.map((c) => bind(row[c])),
    );
    return Number(res.lastInsertRowid);
  }

  updateRun(runId, patch) {
    const present = Object.keys(patch).filter((c) => RUN_COLS.includes(c));
    if (!present.length) return;
    this.run(
      `UPDATE runs SET ${present.map((c) => `${c} = ?`).join(', ')} WHERE run_id = ?`,
      ...present.map((c) => bind(patch[c])), runId,
    );
  }

  getRun(runId) { return this.get('SELECT * FROM runs WHERE run_id = ?', runId) ?? null; }
  runsForEvent(eventId) { return this.all('SELECT * FROM runs WHERE event_id = ? ORDER BY run_id', eventId); }
  activeRuns() { return this.all('SELECT * FROM runs WHERE cleared_at IS NULL AND dry_run = 0 AND error IS NULL'); }

  // ---- labels / pushes / costs -----------------------------------------
  upsertLabel(row) {
    this.run(
      `INSERT INTO labels (event_id, by, correct, actual, friendly, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET by=excluded.by, correct=excluded.correct, actual=excluded.actual,
       friendly=excluded.friendly, note=excluded.note, at=excluded.at`,
      row.event_id, row.by, row.correct, row.actual, row.friendly, row.note, row.at,
    );
  }

  getLabel(eventId) { return this.get('SELECT * FROM labels WHERE event_id = ?', eventId) ?? null; }
  allLabels() {
    return this.all(
      `SELECT l.*, e.camera_name, e.ring_label, e.ring_created_at, v.species, v.confidence
       FROM labels l LEFT JOIN events e ON e.event_id = l.event_id
       LEFT JOIN verdicts v ON v.event_id = l.event_id ORDER BY l.at DESC`,
    );
  }

  insertPush(row) { this.run('INSERT INTO pushes (received_at, camera_id, raw_json) VALUES (?, ?, ?)', row.received_at, row.camera_id, row.raw_json); }
  countPushes() { return this.get('SELECT COUNT(*) AS n FROM pushes').n; }
  lastPushAt() { return this.get('SELECT received_at FROM pushes ORDER BY id DESC LIMIT 1')?.received_at ?? null; }

  /** Accumulate one classifier call into the daily cost row (spec 5, costs). */
  addCost(day, inputTokens, outputTokens, usd) {
    this.run(
      `INSERT INTO costs (day, calls, input_tokens, output_tokens, usd) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET calls = costs.calls + 1, input_tokens = costs.input_tokens + excluded.input_tokens,
       output_tokens = costs.output_tokens + excluded.output_tokens, usd = costs.usd + excluded.usd`,
      day, Math.round(inputTokens ?? 0), Math.round(outputTokens ?? 0), Number(usd ?? 0),
    );
  }

  spendForMonth(yyyymm) {
    return this.get('SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(calls), 0) AS calls FROM costs WHERE day LIKE ?', `${yyyymm}%`);
  }

  // ---- decision state ---------------------------------------------------
  /**
   * state for decide(): last real run and the run count for the local day (spec 7.8, 7.9).
   * Dry runs never touch water, so they count against neither the cooldown nor the cap
   * (review item 11), and "today" is the local day (review item 10).
   */
  decisionState(now = new Date()) {
    const dayStart = localDayStartIso(now);
    const last = this.get('SELECT called_at FROM runs WHERE dry_run = 0 ORDER BY called_at DESC LIMIT 1');
    const today = this.get('SELECT COUNT(DISTINCT event_id) AS n FROM runs WHERE called_at >= ? AND dry_run = 0', dayStart);
    return { last_run_at: last?.called_at ?? null, runs_today: today?.n ?? 0 };
  }

  /** Rows on the local day, for the tiles (review item 10). */
  countToday(table, column, now = new Date()) {
    return this.countSince(table, column, localDayStartIso(now));
  }

  // ---- page queries -----------------------------------------------------
  listEvents(filters = {}) {
    const where = [];
    const args = [];
    if (filters.camera) { where.push('e.camera_id = ?'); args.push(String(filters.camera)); }
    if (filters.label) { where.push('IFNULL(e.ring_label, \'none\') = ?'); args.push(String(filters.label)); }
    if (filters.action) { where.push('d.action = ?'); args.push(String(filters.action)); }
    if (filters.test === 'only') where.push('e.test = 1');
    if (filters.test === 'hide') where.push('e.test = 0');
    if (filters.unlabeled) where.push('l.event_id IS NULL');
    const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 200));
    return this.all(
      `SELECT e.*, d.action, d.reason, d.mode, d.knobs_json, d.at AS decided_at,
              v.species, v.confidence, v.is_person, v.friendly AS verdict_friendly, v.usd, v.error AS verdict_error,
              l.correct, l.actual, l.friendly AS label_friendly, l.note,
              (SELECT COUNT(*) FROM runs r WHERE r.event_id = e.event_id) AS run_count,
              (SELECT COUNT(*) FROM runs r WHERE r.event_id = e.event_id AND r.confirmed_at IS NOT NULL) AS run_confirmed,
              (SELECT MIN(r.called_at) FROM runs r WHERE r.event_id = e.event_id) AS run_called_at,
              (SELECT MIN(r.confirmed_at) FROM runs r WHERE r.event_id = e.event_id) AS run_confirmed_at,
              (SELECT MAX(r.dry_run) FROM runs r WHERE r.event_id = e.event_id) AS run_dry
       FROM events e
       LEFT JOIN decisions d ON d.event_id = e.event_id
       LEFT JOIN verdicts v ON v.event_id = e.event_id
       LEFT JOIN labels l ON l.event_id = e.event_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.ring_created_at DESC LIMIT ?`,
      ...args, limit,
    );
  }

  cameras() { return this.all('SELECT DISTINCT camera_id, camera_name FROM events ORDER BY camera_name'); }

  countSince(table, column, iso) { return this.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} >= ?`, iso).n; }

  clipDelaysSeconds(limitDays = 30) {
    const cutoff = new Date(Date.now() - limitDays * 86400000).toISOString();
    const rows = this.all('SELECT ring_created_at, clip_ready_at FROM events WHERE clip_ready_at IS NOT NULL AND ring_created_at >= ?', cutoff);
    return rows.map((r) => (Date.parse(r.clip_ready_at) - Date.parse(r.ring_created_at)) / 1000).filter((n) => Number.isFinite(n) && n >= 0);
  }

  /** Grouped in JS, not SQL, because strftime is UTC and the chart is local (review item 10). */
  runsPerDay(days = 30) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const rows = this.all('SELECT called_at FROM runs WHERE called_at >= ?', cutoff);
    const counts = new Map();
    for (const r of rows) {
      const key = localDayKey(r.called_at);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([day, n]) => ({ day, n })).sort((a, b) => a.day.localeCompare(b.day));
  }

  eventsByHour() {
    const rows = this.all('SELECT ring_created_at FROM events');
    const counts = new Array(24).fill(0);
    for (const r of rows) {
      const h = localHourOf(r.ring_created_at);
      if (h !== null) counts[h] += 1;
    }
    return counts.map((n, hour) => ({ hour, n })).filter((r) => r.n > 0);
  }

  latencies() {
    const rows = this.all('SELECT e.first_seen_at, r.confirmed_at FROM runs r JOIN events e ON e.event_id = r.event_id WHERE r.confirmed_at IS NOT NULL');
    return rows.map((r) => (Date.parse(r.confirmed_at) - Date.parse(r.first_seen_at)) / 1000).filter((n) => Number.isFinite(n) && n >= 0);
  }

  /** Label-derived quality, split day and night (spec 8.1). Night is 20:00 to 05:59 local. */
  labelRates() {
    const rows = this.all(
      `SELECT l.correct, d.action, e.ring_created_at FROM labels l
       LEFT JOIN decisions d ON d.event_id = l.event_id
       LEFT JOIN events e ON e.event_id = l.event_id WHERE l.correct IS NOT NULL`,
    );
    const buckets = { day: { fired: 0, falseSpray: 0, skipped: 0, missed: 0 }, night: { fired: 0, falseSpray: 0, skipped: 0, missed: 0 } };
    for (const r of rows) {
      const hour = localHourOf(r.ring_created_at ?? Date.now());
      const b = buckets[isNightHour(hour) ? 'night' : 'day'];
      if (r.action === 'fire') { b.fired += 1; if (r.correct === 0) b.falseSpray += 1; }
      else { b.skipped += 1; if (r.correct === 0) b.missed += 1; }
    }
    const rate = (n, d) => (d ? n / d : null);
    return {
      day: { falseSprayRate: rate(buckets.day.falseSpray, buckets.day.fired), missRate: rate(buckets.day.missed, buckets.day.skipped), ...buckets.day },
      night: { falseSprayRate: rate(buckets.night.falseSpray, buckets.night.fired), missRate: rate(buckets.night.missed, buckets.night.skipped), ...buckets.night },
    };
  }

  /**
   * Delete test events and their children, and report the media that went with them so the caller
   * can remove the files too (review item 16).
   * -> {count, clips: [absolute paths], frames: [basenames], snapshots: [absolute paths]}
   */
  deleteTestEvents() {
    const rows = this.all('SELECT event_id, clip_path, frames_json, snapshot_path FROM events WHERE test = 1');
    const clips = [];
    const frames = [];
    const snapshots = [];
    for (const row of rows) {
      if (row.clip_path) clips.push(row.clip_path);
      if (row.snapshot_path) snapshots.push(row.snapshot_path);
      try { for (const f of JSON.parse(row.frames_json ?? '[]')) frames.push(f); } catch { /* no frames recorded */ }
      for (const t of ['runs', 'labels', 'decisions', 'verdicts', 'events']) this.run(`DELETE FROM ${t} WHERE event_id = ?`, row.event_id);
    }
    return { count: rows.length, clips, frames, snapshots };
  }
}
