// Frame and clip naming, event mapping, token persistence and the migration (spec 5, 6.3, 11.1).
// No Ring client is constructed and no credential file is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { clipFileName, clipPathFor, framePathFor, eventRow, persistRefreshToken, migrate, extractFrames, RingIngest } from '../src/ring.js';
import { Db } from '../src/db.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `auto-ttds-${name}-`));

test('clip and frame naming', () => {
  assert.equal(clipFileName('2026-09-16T04:05:06.000Z', 'ev1'), '2026-09-16T04-05-06.000Z_ev1.mp4');
  assert.equal(clipPathFor('/share/auto-ttds', 639481050, '2026-09-16T04:05:06.000Z', 'ev1'),
    '/share/auto-ttds/clips/639481050/2026-09-16T04-05-06.000Z_ev1.mp4');
  assert.equal(framePathFor('/share/auto-ttds', 'ev1', 3), '/share/auto-ttds/frames/ev1_t3.jpg');
});

test('eventRow maps the Ring events API onto the schema', () => {
  const camera = { id: 639481050, name: 'Cat Cam' };
  const e = {
    event_id: 'ev1', ding_id_str: '77', created_at: '2026-09-16T04:05:06.000Z', kind: 'motion',
    recording_status: 'ready',
    cv_properties: { detection_type: 'animal', detection_types: [{ detection_type: 'animal' }, { detection_type: 'other_motion' }] },
  };
  const row = eventRow(camera, e, 'poll', '2026-09-16T04:05:10.000Z');
  assert.equal(row.event_id, 'ev1');
  assert.equal(row.camera_id, '639481050');
  assert.equal(row.ring_label, 'animal');
  assert.deepEqual(JSON.parse(row.ring_labels_json), ['animal', 'other_motion']);
  assert.equal(row.source, 'poll');
  assert.equal(row.first_seen_at, '2026-09-16T04:05:10.000Z');
  assert.equal(JSON.parse(row.raw_json).ding_id_str, '77');
});

test('eventRow tolerates a null label and missing cv_properties', () => {
  const row = eventRow({ id: 1, name: 'c' }, { event_id: 'x', created_at: 'now', kind: 'ding' }, 'push');
  assert.equal(row.ring_label, null);
  assert.deepEqual(JSON.parse(row.ring_labels_json), []);
});

test('rotated refresh tokens are written at mode 0600', () => {
  const dir = tmp('token');
  const file = path.join(dir, 'ring-token.json');
  persistRefreshToken(file, 'not-a-real-token');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refreshToken, 'not-a-real-token');
  persistRefreshToken(file, 'rotated');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refreshToken, 'rotated');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractFrames calls ffmpeg with the spec arguments and collects what was written', async () => {
  const dir = tmp('frames');
  const seen = [];
  const fakeSpawn = (cmd, args) => {
    seen.push({ cmd, args });
    const out = args[args.length - 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'jpeg');
    const em = new EventEmitter();
    setImmediate(() => em.emit('close', 0));
    return em;
  };
  const written = await extractFrames('/clip.mp4', dir, 'ev1', { spawn: fakeSpawn });
  assert.equal(written.length, 3);
  assert.equal(seen[0].cmd, 'ffmpeg');
  assert.deepEqual(seen.map((s) => s.args[2]), ['1', '3', '6']);
  assert.ok(seen[0].args.includes('scale=960:-1'));
  assert.ok(seen[0].args.includes('-q:v'));
  assert.equal(written[1], path.join(dir, 'frames', 'ev1_t3.jpg'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractFrames drops frames ffmpeg could not make', async () => {
  const dir = tmp('frames2');
  const fakeSpawn = () => { const em = new EventEmitter(); setImmediate(() => em.emit('close', 1)); return em; };
  assert.deepEqual(await extractFrames('/clip.mp4', dir, 'ev2', { spawn: fakeSpawn }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

function probeFixture() {
  const src = tmp('probe');
  const dataDir = tmp('data');
  const created = '2026-09-15T20:00:00.000Z';
  const rec = {
    first_seen: '2026-09-15T20:00:04.000Z', cameraId: 639481050, camera: 'Cat Cam', event_id: 'p1',
    ding_id_str: '55', created_at: created, kind: 'motion', recording_status: 'ready',
    detection_type: 'animal', detection_types: ['animal'], raw: { event_id: 'p1' },
  };
  const rec2 = { ...rec, event_id: 'p2', created_at: '2026-09-15T21:00:00.000Z', detection_type: null };
  fs.writeFileSync(path.join(src, 'events.jsonl'), `${JSON.stringify(rec)}\n${JSON.stringify(rec2)}\n\n`);
  const clipDir = path.join(src, 'data', '639481050');
  fs.mkdirSync(clipDir, { recursive: true });
  fs.writeFileSync(path.join(clipDir, clipFileName(created, 'p1')), 'mp4bytes');
  return { src, dataDir };
}

test('migration imports the probe events and clips, idempotently (spec 5)', () => {
  const { src, dataDir } = probeFixture();
  const db = new Db(':memory:');
  const opts = { eventsJsonl: path.join(src, 'events.jsonl'), clipsDir: path.join(src, 'data'), dataDir };
  const first = migrate(db, opts);
  assert.equal(first.events, 2);
  assert.equal(first.clips, 1);
  assert.equal(db.countEvents(), 2);
  const row = db.getEvent('p1');
  assert.equal(row.source, 'poll');
  assert.equal(row.camera_name, 'Cat Cam');
  assert.equal(row.ring_label, 'animal');
  assert.ok(fs.existsSync(row.clip_path));
  assert.equal(db.getEvent('p2').ring_label, null);

  const second = migrate(db, opts);
  assert.equal(second.events, 0);
  assert.equal(second.skipped, 2);
  assert.equal(second.clips, 0);
  assert.equal(db.countEvents(), 2);
  assert.ok(db.getMeta('migrated_at'));

  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  db.close();
});

test('migration is a no-op when the probe directory is absent', () => {
  const db = new Db(':memory:');
  const r = migrate(db, { eventsJsonl: '/no/such/events.jsonl', clipsDir: '/no/such/data', dataDir: '/tmp' });
  assert.equal(r.ran, false);
  assert.equal(db.countEvents(), 0);
  db.close();
});

test('the add-on waits for the Ring credential files instead of dying (review item 15)', async () => {
  const dir = tmp('creds');
  const tokenFile = path.join(dir, 'ring-token.json');
  const systemFile = path.join(dir, 'system-id');
  let waits = 0;
  const ingest = new RingIngest({
    tokenFile,
    systemIdFile: systemFile,
    tokenWaitMs: 1,
    sleep: async () => {
      waits += 1;
      if (waits === 3) { // the probe finishes writing them on the third attempt
        fs.writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'placeholder', obtained: new Date().toISOString() }));
        fs.writeFileSync(systemFile, 'system-id-value\n');
      }
    },
  });
  const creds = await ingest.readCredentials();
  assert.equal(waits, 3);
  assert.equal(creds.refreshToken, 'placeholder');
  assert.equal(creds.systemId, 'system-id-value');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bounded credential wait still gives up for the test harness', async () => {
  const ingest = new RingIngest({ tokenFile: '/no/such/token.json', systemIdFile: '/no/such/id', tokenWaitMs: 0, tokenWaitTries: 2, sleep: async () => {} });
  await assert.rejects(() => ingest.readCredentials());
});

test('a rejecting push handler is caught, not left unhandled (review 2 item 2)', async () => {
  const dir = tmp('push');
  const tokenFile = path.join(dir, 'ring-token.json');
  const systemFile = path.join(dir, 'system-id');
  fs.writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'placeholder', obtained: new Date().toISOString() }));
  fs.writeFileSync(systemFile, 'system-id-value');

  let subscriber = null;
  const camera = {
    id: 1, name: 'Cat Cam',
    onNewNotification: { subscribe: (fn) => { subscriber = fn; } },
  };
  const ingest = new RingIngest({
    tokenFile, systemIdFile: systemFile,
    apiFactory: async () => ({ onRefreshTokenUpdated: { subscribe: () => {} }, getCameras: async () => [camera] }),
    onPush: async () => { throw new Error('handler blew up'); },
  });
  await ingest.start();
  assert.ok(subscriber, 'the notification subscriber was registered');

  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    subscriber({ data: { event: { ding: { id: 'p1' } } } });
    await new Promise((r) => setTimeout(r, 20)); // past the microtask checkpoint
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], 'no unhandled rejection escaped the subscriber');
  assert.equal(ingest.pushConnected, true);

  // A synchronous throw is caught too.
  ingest.onPush = () => { throw new Error('sync blow up'); };
  assert.doesNotThrow(() => subscriber({}));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('poll walks every camera and survives one failing', async () => {
  const seen = [];
  const good = { id: 1, name: 'good', getEvents: async () => ({ events: [{ event_id: 'a' }, { event_id: 'b' }] }) };
  const bad = { id: 2, name: 'bad', getEvents: async () => { throw new Error('ring 502'); } };
  const ingest = new RingIngest({ onEvent: async (c, e) => seen.push(`${c.name}:${e.event_id}`) });
  ingest.cameras = [good, bad];
  const ok = await ingest.poll(20);
  assert.equal(ok, false);
  assert.deepEqual(seen, ['good:b', 'good:a']); // oldest first after the reverse
  assert.equal(ingest.lastPollOk, false);
  assert.ok(ingest.lastPollAt);
});

test('downloadClip writes the file once and skips a null recording URL', async () => {
  const dataDir = tmp('clips');
  const camera = { id: 639481050, name: 'Cat Cam', getRecordingUrl: async () => 'https://example.invalid/clip.mp4' };
  const ingest = new RingIngest({ dataDir, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('mp4').buffer }) });
  const event = { event_id: 'ev9', ring_created_at: '2026-09-16T01:02:03.000Z', ding_id_str: '1' };
  const p = await ingest.downloadClip(camera, event);
  assert.ok(fs.existsSync(p));
  assert.equal(await ingest.downloadClip(camera, event), p); // second call is a no-op

  const noUrl = new RingIngest({ dataDir, fetchImpl: async () => { throw new Error('should not fetch'); } });
  assert.equal(await noUrl.downloadClip({ id: 1, getRecordingUrl: async () => null }, { event_id: 'ev10', ring_created_at: 'x', ding_id_str: '2' }), null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- v0.4: snapshots are fetched, never captured ---------------------------

test('the push snapshot is fetched by uuid, from the image Ring already took', async () => {
  const dataDir = tmp('uuid');
  const seen = [];
  const camera = {
    id: 1,
    getSnapshotByUuid: async (uuid) => { seen.push(uuid); return Buffer.from('push'); },
    getSnapshot: async () => { throw new Error('getSnapshot must never be called: it forces a new capture'); },
  };
  const ingest = new RingIngest({ dataDir });
  const out = await ingest.saveSnapshot(camera, 'ev6', 'uuid-6');
  assert.equal(out, path.join(dataDir, 'frames', 'ev6_snapshot.jpg'));
  assert.equal(fs.readFileSync(out, 'utf8'), 'push');
  assert.deepEqual(seen, ['uuid-6'], 'the stored-image endpoint, which has no force flag');

  assert.equal(await ingest.saveSnapshot(camera, 'ev7', null), null, 'no uuid means no image to fetch');
  assert.equal(await ingest.saveSnapshot({ id: 1 }, 'ev8', 'uuid-8'), null, 'a camera without the method is skipped');
  assert.equal(await ingest.saveSnapshot({ id: 1, getSnapshotByUuid: async () => { throw new Error('gone'); } }, 'ev9', 'u'), null);
  assert.equal(await ingest.saveSnapshot({ id: 1, getSnapshotByUuid: async () => null }, 'ev10', 'u'), null, 'an empty body writes nothing');
  assert.equal(fs.existsSync(path.join(dataDir, 'frames', 'ev10_snapshot.jpg')), false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('nothing in the add-on can ask a camera to take a new picture', () => {
  const dir = new URL('../src/', import.meta.url);
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    const text = fs.readFileSync(new URL(name, dir), 'utf8');
    // Strip comments, which name the method to explain why it is not used.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    if (/getSnapshot\s*\(/.test(code)) offenders.push(name);
    if (/getNextSnapshot|snapshots\/next|extras=force/.test(code)) offenders.push(`${name} (capture endpoint)`);
  }
  assert.deepEqual(offenders, [], 'only getSnapshotByUuid is allowed: getSnapshot forces a capture');
});

test('fix 4: a human label counts whether it is the scalar or only in the array', () => {
  const camera = { id: 639481050, name: 'Cat Cam' };
  const base = { event_id: 'ev1', created_at: '2026-09-17T04:05:06.000Z', kind: 'motion' };

  // The shape v0.3 already handled.
  const scalar = eventRow(camera, { ...base, cv_properties: { detection_type: 'human', detection_types: [{ detection_type: 'human' }] } }, 'poll');
  assert.equal(scalar.ring_label, 'human');

  // The shape it missed: the array says human, the scalar does not.
  const arrayOnly = eventRow(camera, { ...base, cv_properties: { detection_type: null, detection_types: [{ detection_type: 'human' }] } }, 'poll');
  assert.equal(arrayOnly.ring_label, 'human', 'a person must cost nothing to decide, in either shape');
  assert.deepEqual(JSON.parse(arrayOnly.ring_labels_json), ['human']);

  // Plain strings in the array count too, and so does a mixed list.
  const strings = eventRow(camera, { ...base, cv_properties: { detection_type: 'other_motion', detection_types: ['human'] } }, 'poll');
  assert.equal(strings.ring_label, 'human');
  const mixed = eventRow(camera, { ...base, cv_properties: { detection_type: 'animal', detection_types: [{ detection_type: 'animal' }, { detection_type: 'human' }] } }, 'poll');
  assert.equal(mixed.ring_label, 'human', 'a person in the frame wins over the animal beside them');

  // And nothing else is promoted.
  const animal = eventRow(camera, { ...base, cv_properties: { detection_type: 'animal', detection_types: [{ detection_type: 'animal' }] } }, 'poll');
  assert.equal(animal.ring_label, 'animal');
  assert.equal(eventRow(camera, base, 'poll').ring_label, null);
});
