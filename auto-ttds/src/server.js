// server.js: the ingress HTTP surface (spec 6, 8). node:http only, no framework.
// Ingress requests arrive with X-Ingress-Path; the page uses relative URLs only, so that prefix
// never has to be baked into a link (spec 1.8).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { localDayStartIso, localMonthKey } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(here, '..', 'web');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function ingressPrefix(req) {
  return req.headers['x-ingress-path'] ?? '';
}

/** Reject anything that climbs out of the directory it is served from. */
export function safeJoin(root, ...parts) {
  const target = path.resolve(root, ...parts.map((p) => p.replace(/^[/\\]+/, '')));
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null;
  return target;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function sendFile(req, res, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
    const start = startRaw === '' ? Math.max(0, stat.size - Number(endRaw)) : Number(startRaw);
    const end = endRaw === '' || startRaw === '' ? stat.size - 1 : Math.min(Number(endRaw), stat.size - 1);
    if (start >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * buildMetrics: the tiles and charts from spec 8.1 and 8.4. Pure over the db, so it is testable.
 */
export function buildMetrics(db, extra = {}) {
  const now = new Date();
  const dayStart = localDayStartIso(now); // review item 10
  const weekStart = new Date(now.getTime() - 7 * 86400000).toISOString();
  const month = localMonthKey(now);
  const delays = db.clipDelaysSeconds();
  const sorted = delays.slice().sort((a, b) => a - b);
  const medianDelay = sorted.length ? (sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2) : null;
  const valveToday = db.valveSecondsSince(dayStart);
  const valveWeek = db.valveSecondsSince(weekStart);
  return {
    events_today: db.countSince('events', 'first_seen_at', dayStart),
    events_7d: db.countSince('events', 'first_seen_at', weekStart),
    runs_today: db.countSince('runs', 'called_at', dayStart),
    runs_7d: db.countSince('runs', 'called_at', weekStart),
    // Water tracking (v0.3). These are valve open time, never measured volume: see flow_7d.
    valve_seconds_today: valveToday.seconds,
    valve_seconds_7d: valveWeek.seconds,
    valve_runs_today: valveToday.runs,
    valve_runs_7d: valveWeek.runs,
    events_fired_today: db.eventsFiredSince(dayStart),
    flow_7d: db.flowSummary(weekStart),
    events_total: db.countEvents(),
    spend_month_usd: db.spendForMonth(month).usd,
    calls_month: db.spendForMonth(month).calls,
    push_count: db.countPushes(),
    push_last_at: db.lastPushAt(),
    clip_delay_median_s: medianDelay,
    label_rates: db.labelRates(),
    runs_per_day: db.runsPerDay(30),
    events_by_hour: db.eventsByHour(),
    latencies_s: db.latencies(),
    cameras: db.cameras(),
    ...extra,
  };
}

/**
 * deleteTestEventsAndMedia: drop the rows, then the clips and frames they owned (review item 16).
 * Every path is re-checked against the media roots before anything is unlinked.
 */
export function deleteTestEventsAndMedia(db, dataDir) {
  const { count, clips, frames, snapshots } = db.deleteTestEvents();
  const roots = { clips: path.join(dataDir, 'clips'), frames: path.join(dataDir, 'frames') };
  const unlink = (file) => {
    if (!file) return;
    const root = file.startsWith(roots.clips) ? roots.clips : roots.frames;
    const safe = safeJoin(root, path.relative(root, file));
    if (!safe) { log.warning('refusing to delete a media path outside the data directory'); return; }
    try { fs.rmSync(safe, { force: true }); } catch (err) { log.warning(`could not delete a test media file: ${err.message}`); }
  };
  for (const clip of clips) unlink(clip);
  for (const snap of snapshots) unlink(snap);
  for (const name of frames) unlink(path.join(roots.frames, path.basename(name)));
  return count;
}

/**
 * createServer(deps) -> http.Server
 * deps: {db, dataDir, knobStore, healthRef, onDeleteTests}
 */
export function createServer(deps) {
  const { db, dataDir } = deps;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
        log.debug(`page request, ingress prefix "${ingressPrefix(req)}"`);
        sendFile(req, res, path.join(WEB_DIR, 'index.html'));
        return;
      }

      if (req.method === 'GET' && route === '/api/events') {
        const rows = db.listEvents({
          limit: url.searchParams.get('limit'),
          camera: url.searchParams.get('camera') || null,
          label: url.searchParams.get('label') || null,
          action: url.searchParams.get('action') || null,
          test: url.searchParams.get('test') || null,
          unlabeled: url.searchParams.get('unlabeled') === '1',
        });
        sendJson(res, 200, { events: rows });
        return;
      }

      if (req.method === 'GET' && route === '/api/metrics') {
        sendJson(res, 200, buildMetrics(db, {
          knobs: deps.knobStore?.get?.() ?? null,
          knobs_refreshed_at: deps.knobStore?.lastRefreshAt ?? null,
          health: deps.healthRef?.value ?? null,
        }));
        return;
      }

      // Two independent labels: actual (what the animal was) and should_have_fired (yes or no).
      // Only the keys the caller sent are written, so either one can be set on its own.
      if (req.method === 'POST' && route === '/api/label') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!body.event_id) { sendJson(res, 400, { error: 'event_id required' }); return; }
        const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
        const text = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
        const patch = { event_id: String(body.event_id), by: String(body.by ?? 'ingress'), at: new Date().toISOString() };
        if (has('actual')) patch.actual = text(body.actual);
        if (has('note')) patch.note = text(body.note);
        if (has('should_have_fired')) {
          patch.should_have_fired = body.should_have_fired === null || body.should_have_fired === undefined
            ? null : (Number(body.should_have_fired) ? 1 : 0);
        }
        db.upsertLabel(patch);
        sendJson(res, 200, { ok: true, label: db.getLabel(String(body.event_id)) });
        return;
      }

      if (req.method === 'GET' && route === '/api/export/labels.csv') {
        const head = ['event_id', 'at', 'camera_name', 'ring_created_at', 'ring_label', 'species', 'confidence', 'should_have_fired', 'actual', 'note'];
        const lines = [head.join(',')];
        for (const r of db.allLabels()) lines.push(head.map((h) => csvCell(r[h])).join(','));
        const text = `${lines.join('\n')}\n`;
        res.writeHead(200, { 'Content-Type': TYPES['.csv'], 'Content-Disposition': 'attachment; filename="labels.csv"' });
        res.end(text);
        return;
      }

      if (req.method === 'POST' && route === '/api/delete-tests') {
        const n = deps.onDeleteTests ? await deps.onDeleteTests() : deleteTestEventsAndMedia(db, dataDir);
        sendJson(res, 200, { deleted: n });
        return;
      }

      if (req.method === 'GET' && route.startsWith('/media/frames/')) {
        const file = safeJoin(path.join(dataDir, 'frames'), decodeURIComponent(route.slice('/media/frames/'.length)));
        if (!file) { res.writeHead(403); res.end('forbidden'); return; }
        sendFile(req, res, file);
        return;
      }

      if (req.method === 'GET' && route.startsWith('/media/clips/')) {
        const rest = decodeURIComponent(route.slice('/media/clips/'.length));
        const file = safeJoin(path.join(dataDir, 'clips'), rest);
        if (!file) { res.writeHead(403); res.end('forbidden'); return; }
        sendFile(req, res, file);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      log.error(`request ${req.method} ${route} failed: ${err.message}`);
      sendJson(res, 500, { error: 'server error' });
    }
  });
}
