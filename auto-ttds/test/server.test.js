// The ingress HTTP surface against an in-memory database on an ephemeral port (spec 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, safeJoin, buildMetrics, ingressPrefix } from '../src/server.js';
import { Db } from '../src/db.js';

const iso = (o = 0) => new Date(Date.now() + o).toISOString();

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttds-web-'));
  fs.mkdirSync(path.join(dataDir, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'clips', '639481050'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'frames', 'e1_t1.jpg'), 'jpegbytes');
  fs.writeFileSync(path.join(dataDir, 'clips', '639481050', 'clip.mp4'), 'mp4bytes');

  const db = new Db(':memory:');
  db.insertEvent({ event_id: 'e1', camera_id: '639481050', camera_name: 'Cat Cam', ring_created_at: iso(-1000), first_seen_at: iso(-1000), source: 'poll', kind: 'motion', ring_label: 'animal', recording_status: 'ready', frames_json: '["e1_t1.jpg"]', test: 0, raw_json: '{}' });
  db.upsertDecision({ event_id: 'e1', at: iso(), action: 'fire', reason: 'target', mode: 'immediate', knobs_json: '{}' });
  db.addCost(iso().slice(0, 10), 2200, 120, 0.0028);

  const server = createServer({ db, dataDir, knobStore: { get: () => ({ mode: 'immediate' }), lastRefreshAt: iso() }, healthRef: { value: { state: 'ok' } } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ base, db, dataDir }); } finally {
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('the page is served at the root', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /auto-ttds/);
    assert.ok(!/https?:\/\//i.test(html), 'no external URLs: no CDN, no fonts');
  });
});

test('GET /api/events honors limit and filters', async () => {
  await withServer(async ({ base }) => {
    const all = await (await fetch(`${base}/api/events?limit=200`)).json();
    assert.equal(all.events.length, 1);
    assert.equal(all.events[0].action, 'fire');
    const none = await (await fetch(`${base}/api/events?camera=999`)).json();
    assert.equal(none.events.length, 0);
    const unlabeled = await (await fetch(`${base}/api/events?unlabeled=1`)).json();
    assert.equal(unlabeled.events.length, 1);
  });
});

test('GET /api/metrics carries the tiles and the chart series', async () => {
  await withServer(async ({ base }) => {
    const m = await (await fetch(`${base}/api/metrics`)).json();
    for (const key of ['events_today', 'events_7d', 'runs_today', 'runs_7d', 'spend_month_usd', 'push_count', 'clip_delay_median_s', 'label_rates', 'runs_per_day', 'events_by_hour', 'latencies_s', 'cameras', 'knobs', 'health']) {
      assert.ok(key in m, `metrics has ${key}`);
    }
    assert.equal(m.events_today, 1);
    assert.equal(Number(m.spend_month_usd.toFixed(4)), 0.0028);
    assert.equal(m.knobs.mode, 'immediate');
  });
});

const postLabel = (base, body) => fetch(`${base}/api/label`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('POST /api/label stores and returns the label', async () => {
  await withServer(async ({ base, db }) => {
    const res = await postLabel(base, { event_id: 'e1', actual: 'rabbit', should_have_fired: 0, note: 'small' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.label.should_have_fired, 0);
    assert.equal(db.getLabel('e1').actual, 'rabbit');
    assert.equal(db.getLabel('e1').note, 'small');

    const bad = await fetch(`${base}/api/label`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 400);
  });
});

test('the two labels are posted independently', async () => {
  await withServer(async ({ base, db }) => {
    await postLabel(base, { event_id: 'e1', actual: 'cat', note: null });
    assert.equal(db.getLabel('e1').should_have_fired, null, 'a species alone leaves the question open');

    await postLabel(base, { event_id: 'e1', should_have_fired: 1 });
    assert.equal(db.getLabel('e1').actual, 'cat', 'the yes button does not clear the species');
    assert.equal(db.getLabel('e1').should_have_fired, 1);

    await postLabel(base, { event_id: 'e1', actual: '  bobcat  ', note: ' by the pool ' });
    const row = db.getLabel('e1');
    assert.equal(row.actual, 'bobcat', 'whitespace is trimmed');
    assert.equal(row.note, 'by the pool');
    assert.equal(row.should_have_fired, 1, 'the text fields do not clear the answer');

    await postLabel(base, { event_id: 'e1', should_have_fired: null });
    assert.equal(db.getLabel('e1').should_have_fired, null, 'the answer can be unset again');

    await postLabel(base, { event_id: 'e1', actual: '' });
    assert.equal(db.getLabel('e1').actual, null, 'a blank species clears it');
  });
});

test('an unlabeled filter means no should_have_fired answer', async () => {
  await withServer(async ({ base, db }) => {
    await postLabel(base, { event_id: 'e1', actual: 'cat' });
    let rows = await (await fetch(`${base}/api/events?unlabeled=1`)).json();
    assert.equal(rows.events.length, 1, 'a species alone still counts as unlabeled');
    await postLabel(base, { event_id: 'e1', should_have_fired: 1 });
    rows = await (await fetch(`${base}/api/events?unlabeled=1`)).json();
    assert.equal(rows.events.length, 0);
    assert.equal(db.getLabel('e1').should_have_fired, 1);
  });
});

test('labels export as CSV', async () => {
  await withServer(async ({ base, db }) => {
    db.upsertLabel({ event_id: 'e1', by: 'ingress', should_have_fired: 0, actual: 'rabbit, small', note: null, at: iso() });
    const res = await fetch(`${base}/api/export/labels.csv`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /labels\.csv/);
    const text = await res.text();
    const lines = text.trim().split('\n');
    assert.equal(lines[0], 'event_id,at,camera_name,ring_created_at,ring_label,species,confidence,should_have_fired,actual,note');
    assert.match(lines[1], /,0,"rabbit, small",/);
  });
});

test('deleting test events also deletes their clips and frames (review item 16)', async () => {
  await withServer(async ({ base, db, dataDir }) => {
    const clip = path.join(dataDir, 'clips', '639481050', 'test.mp4');
    const frame = path.join(dataDir, 'frames', 't1_t1.jpg');
    const snapshot = path.join(dataDir, 'frames', 't1_snapshot.jpg');
    const keep = path.join(dataDir, 'frames', 'e1_t1.jpg');
    fs.writeFileSync(clip, 'mp4');
    fs.writeFileSync(frame, 'jpeg');
    fs.writeFileSync(snapshot, 'jpeg');
    db.insertEvent({ event_id: 't1', camera_id: '639481050', ring_created_at: iso(), first_seen_at: iso(), source: 'poll', test: 1, clip_path: clip, frames_json: '["t1_t1.jpg"]', snapshot_path: snapshot });

    const res = await fetch(`${base}/api/delete-tests`, { method: 'POST' });
    assert.deepEqual(await res.json(), { deleted: 1 });
    assert.equal(db.hasEvent('t1'), false);
    assert.equal(fs.existsSync(clip), false, 'clip deleted');
    assert.equal(fs.existsSync(frame), false, 'frame deleted');
    assert.equal(fs.existsSync(snapshot), false, 'snapshot deleted');
    assert.equal(fs.existsSync(keep), true, 'media belonging to a real event is untouched');
  });
});

test('frames and clips are served from the data directory', async () => {
  await withServer(async ({ base }) => {
    const frame = await fetch(`${base}/media/frames/e1_t1.jpg`);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get('content-type'), 'image/jpeg');
    assert.equal(await frame.text(), 'jpegbytes');

    const clip = await fetch(`${base}/media/clips/639481050/clip.mp4`);
    assert.equal(clip.status, 200);
    assert.equal(clip.headers.get('content-type'), 'video/mp4');

    const ranged = await fetch(`${base}/media/clips/639481050/clip.mp4`, { headers: { Range: 'bytes=0-2' } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), 'mp4');

    const missing = await fetch(`${base}/media/frames/nope.jpg`);
    assert.equal(missing.status, 404);
  });
});

test('path traversal out of the media directories is refused', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/media/frames/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    assert.equal(res.status, 403);
  });
  assert.equal(safeJoin('/share/auto-ttds/frames', '../../etc/passwd'), null);
  assert.equal(safeJoin('/share/auto-ttds/frames', 'ok.jpg'), '/share/auto-ttds/frames/ok.jpg');
});

test('unknown routes are 404', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('the page pauses its table refresh while a label is being typed (review item 13)', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /function rowsBusy\(\)/);
  assert.match(html, /data-dirty/);
  assert.match(html, /if \(!force && rowsBusy\(\)\)/);
  assert.match(html, /setInterval\(\(\) => load\(false\), 30000\)/);
  // The metrics fetch happens before the guard, so the tiles keep updating.
  const guardAt = html.indexOf('if (!force && rowsBusy())');
  assert.ok(html.indexOf("await api('api/metrics')") < guardAt, 'tiles refresh even while the table is paused');
});

test('the page offers two independent labels and no correct or wrong toggle', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-actual/);
  assert.match(html, /data-fired="1"/);
  assert.match(html, /data-fired="0"/);
  assert.match(html, /should_have_fired/);
  assert.ok(!/data-mark/.test(html), 'the old Correct and Wrong toggle is gone');
  assert.ok(!/data-friendly/.test(html), 'the old friendly checkbox is gone');
  assert.ok(!/\u2014/.test(html), 'no em dashes in the page');
});

test('the ingress prefix header is read, and links stay relative', () => {
  assert.equal(ingressPrefix({ headers: { 'x-ingress-path': '/api/hassio_ingress/abc' } }), '/api/hassio_ingress/abc');
  assert.equal(ingressPrefix({ headers: {} }), '');
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.ok(!/(src|href)="\//.test(html), 'no root-absolute asset links in the page');
});

test('buildMetrics works on an empty database', () => {
  const db = new Db(':memory:');
  const m = buildMetrics(db);
  assert.equal(m.events_today, 0);
  assert.equal(m.clip_delay_median_s, null);
  assert.equal(m.label_rates.day.falseSprayRate, null);
  db.close();
});
