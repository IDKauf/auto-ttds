// ring.js: the single Ring client (spec 10.3), token persistence, poll and push ingest,
// clip download, ffmpeg frame extraction, and the first-boot migration (spec 5).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './log.js';

export const FRAME_SECONDS = [1, 3, 6];

/** Filesystem-safe clip name: <created_at>_<event_id>.mp4 with colons flattened (spec 6.3). */
export function clipFileName(createdAt, eventId) {
  return `${String(createdAt).replace(/:/g, '-')}_${eventId}.mp4`;
}

export function clipPathFor(dataDir, cameraId, createdAt, eventId) {
  return path.join(dataDir, 'clips', String(cameraId), clipFileName(createdAt, eventId));
}

export function framePathFor(dataDir, eventId, second) {
  return path.join(dataDir, 'frames', `${eventId}_t${second}.jpg`);
}

export function readRefreshToken(tokenFile) {
  return JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refreshToken;
}

/** Rotated tokens are written back at mode 0600 and never logged (spec 1.1, 10.1). */
export function persistRefreshToken(tokenFile, refreshToken) {
  const tmp = `${tokenFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ refreshToken, obtained: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(tmp, tokenFile);
  try { fs.chmodSync(tokenFile, 0o600); } catch { /* best effort on odd filesystems */ }
}

/** True when this label, in either shape, is Ring's word for a person. */
const isHuman = (label) => String(label ?? '').trim().toLowerCase() === 'human';

/**
 * Map one Ring events-API entry onto an events row (spec 5).
 *
 * Fix 4: Ring sometimes carries the human label only inside cv_properties.detection_types, with
 * the scalar detection_type saying something else or nothing at all. Reading the scalar alone made
 * such an event non-human, which both paid for a classifier call the rule says a person never
 * costs and lost the stop-on-human signal. The array counts as much as the scalar.
 */
export function eventRow(camera, e, source, nowIso = new Date().toISOString()) {
  const cv = e.cv_properties ?? {};
  const labels = (cv.detection_types ?? []).map((x) => (typeof x === 'string' ? x : x?.detection_type)).filter(Boolean);
  const human = isHuman(cv.detection_type) || labels.some(isHuman);
  return {
    event_id: String(e.event_id),
    camera_id: String(camera.id),
    camera_name: camera.name ?? null,
    ring_created_at: e.created_at ?? null,
    first_seen_at: nowIso,
    source,
    kind: e.kind ?? null,
    ring_label: human ? 'human' : (cv.detection_type ?? null),
    ring_labels_json: JSON.stringify(labels),
    recording_status: e.recording_status ?? null,
    test: 0,
    raw_json: JSON.stringify({ ...e, ding_id_str: e.ding_id_str }),
  };
}

/** Run ffmpeg once per frame time (spec 1.7). Returns the paths that were written. */
export async function extractFrames(clipPath, dataDir, eventId, deps = {}) {
  const spawnImpl = deps.spawn ?? spawn;
  const written = [];
  fs.mkdirSync(path.join(dataDir, 'frames'), { recursive: true });
  for (const sec of FRAME_SECONDS) {
    const out = framePathFor(dataDir, eventId, sec);
    const args = ['-y', '-ss', String(sec), '-i', clipPath, '-frames:v', '1', '-q:v', '3', '-vf', 'scale=960:-1', out];
    const code = await new Promise((resolve) => {
      const p = spawnImpl('ffmpeg', args, { stdio: 'ignore' });
      p.on('error', () => resolve(-1));
      p.on('close', (c) => resolve(c));
    });
    if (code === 0 && fs.existsSync(out)) written.push(out);
    else log.debug(`ffmpeg frame t=${sec}s failed for ${eventId}`);
  }
  return written;
}

export class RingIngest {
  /**
   * @param {object} deps {tokenFile, systemIdFile, dataDir, ignoredCameras, apiFactory, fetchImpl}
   * apiFactory is injected so tests can run without a Ring account (spec 10.2).
   */
  constructor(deps = {}) {
    this.tokenFile = deps.tokenFile;
    this.systemIdFile = deps.systemIdFile;
    this.dataDir = deps.dataDir;
    this.apiFactory = deps.apiFactory;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.api = null;
    this.cameras = [];
    this.pushConnected = false;
    this.lastPollOk = false;
    this.lastPollAt = null;
    this.onEvent = deps.onEvent ?? (() => {});
    this.onPush = deps.onPush ?? (() => {});
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tokenWaitMs = deps.tokenWaitMs ?? 30000;
    this.tokenWaitTries = deps.tokenWaitTries ?? Infinity; // bounded only in tests
  }

  /**
   * Wait for the Ring token and system id files rather than exiting (review item 15). The probe may
   * still be writing them, or the collector may not have been stopped yet.
   */
  async readCredentials() {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const refreshToken = readRefreshToken(this.tokenFile);
        const systemId = fs.readFileSync(this.systemIdFile, 'utf8').trim();
        if (!refreshToken || !systemId) throw new Error('token or system id is empty');
        return { refreshToken, systemId };
      } catch (err) {
        if (attempt >= this.tokenWaitTries) throw err;
        log.warning(`Ring credential files not usable yet (${err.message}); retrying in ${Math.round(this.tokenWaitMs / 1000)} s`);
        await this.sleep(this.tokenWaitMs);
      }
    }
  }

  tokenAgeHours() {
    try {
      const obtained = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')).obtained;
      return obtained ? (Date.now() - Date.parse(obtained)) / 3600000 : null;
    } catch { return null; }
  }

  async start() {
    const { refreshToken, systemId } = await this.readCredentials();
    this.api = await this.apiFactory({ refreshToken, systemId, avoidSnapshotBatteryDrain: true, cameraStatusPollingSeconds: 0 });
    this.api.onRefreshTokenUpdated?.subscribe?.(({ newRefreshToken }) => {
      persistRefreshToken(this.tokenFile, newRefreshToken);
      log.info('Ring refresh token rotated and persisted');
    });
    this.cameras = await this.api.getCameras();
    for (const camera of this.cameras) {
      log.info(`Ring camera id=${camera.id} name="${camera.name}"`);
      camera.onNewNotification?.subscribe?.((n) => {
        this.pushConnected = true;
        // onPush is async, and the subscriber cannot await it (review 2 item 2). Without this the
        // first failing push is an unhandled rejection that takes the process down.
        try {
          Promise.resolve(this.onPush(camera, n)).catch((err) => log.error(`push handler failed: ${err.message}`));
        } catch (err) {
          log.error(`push handler threw: ${err.message}`);
        }
      });
    }
    return this.cameras;
  }

  camera(cameraId) { return this.cameras.find((c) => String(c.id) === String(cameraId)) ?? null; }

  /** Drop the client and build a new one. One client per process at any moment (spec 10.3). */
  async restart() {
    log.warning('reconnecting the Ring client after repeated poll failures');
    this.disconnect();
    this.api = null;
    this.cameras = [];
    this.pushConnected = false;
    await this.start();
  }

  /** One poll pass over every camera, ignored ones included so the page can show them (spec 6.1). */
  async poll(limit = 20) {
    let ok = true;
    for (const camera of this.cameras) {
      try {
        const res = await camera.getEvents({ limit });
        const events = (res?.events ?? []).slice().reverse();
        for (const e of events) await this.onEvent(camera, e);
      } catch (err) {
        ok = false;
        log.warning(`poll ${camera.name} failed: ${err.message}`);
      }
    }
    this.lastPollOk = ok;
    this.lastPollAt = new Date().toISOString();
    return ok;
  }

  /** Download the recording once Ring has one. Returns the path, or null while it is not ready. */
  async downloadClip(camera, event) {
    const out = clipPathFor(this.dataDir, camera.id, event.ring_created_at ?? event.created_at, event.event_id);
    if (fs.existsSync(out)) return out;
    const dingId = event.ding_id_str ?? JSON.parse(event.raw_json ?? '{}').ding_id_str;
    if (!dingId) return null;
    const url = await camera.getRecordingUrl(dingId, { transcoded: false });
    if (!url) return null;
    const res = await this.fetchImpl(url);
    if (!res.ok) return null;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return out;
  }

  /**
   * Push snapshot by uuid (spec 6.3). Returns the saved path or null.
   *
   * getSnapshotByUuid, never getSnapshot. Both fetch an image, but getSnapshot with no uuid asks
   * app-snaps.ring.com for the NEXT snapshot with extras=force, which tells the camera to take a
   * new picture. getSnapshotByUuid hits the clientApi snapshots/uuid endpoint, which can only ever
   * return an image Ring already captured at detection. Nothing in this add-on wakes a camera.
   */
  async saveSnapshot(camera, eventId, uuid) {
    if (!uuid || typeof camera?.getSnapshotByUuid !== 'function') return null;
    try {
      const buf = await camera.getSnapshotByUuid(uuid);
      if (!buf) return null;
      const out = path.join(this.dataDir, 'frames', `${eventId}_snapshot.jpg`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      return out;
    } catch (err) {
      log.debug(`snapshot for ${eventId} failed: ${err.message}`);
      return null;
    }
  }

  disconnect() { try { this.api?.disconnect?.(); } catch { /* already gone */ } }
}

/**
 * migrate: import the probe's events.jsonl and clips into the database (spec 5).
 * Idempotent: event insert is ON CONFLICT DO NOTHING and clips are skipped when already copied.
 */
export function migrate(db, { eventsJsonl, clipsDir, dataDir }) {
  const result = { events: 0, clips: 0, skipped: 0, ran: false };
  if (!eventsJsonl || !fs.existsSync(eventsJsonl)) return result;
  result.ran = true;
  const lines = fs.readFileSync(eventsJsonl, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.event_id) continue;
    const created = rec.created_at ?? rec.raw?.created_at ?? null;
    const row = {
      event_id: String(rec.event_id),
      camera_id: String(rec.cameraId ?? ''),
      camera_name: rec.camera ?? null,
      ring_created_at: created,
      first_seen_at: rec.first_seen ?? created,
      source: 'poll',
      kind: rec.kind ?? null,
      ring_label: rec.detection_type ?? null,
      ring_labels_json: JSON.stringify(rec.detection_types ?? []),
      recording_status: rec.recording_status ?? null,
      test: 0,
      raw_json: JSON.stringify(rec.raw ?? rec),
    };
    const created_row = db.insertEvent(row);
    if (created_row) result.events += 1; else result.skipped += 1;

    if (!clipsDir || !created) continue;
    const src = path.join(clipsDir, String(rec.cameraId), clipFileName(created, rec.event_id));
    if (!fs.existsSync(src)) continue;
    const dest = clipPathFor(dataDir, rec.cameraId, created, rec.event_id);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      result.clips += 1;
    }
    db.updateEvent(row.event_id, { clip_path: dest, clip_ready_at: db.getEvent(row.event_id)?.clip_ready_at ?? null });
  }
  db.setMeta('migrated_at', new Date().toISOString());
  db.setMeta('migrated_counts', JSON.stringify(result));
  return result;
}
