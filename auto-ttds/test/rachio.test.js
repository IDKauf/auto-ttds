// Rachio calls against a mocked fetch. Nothing here reaches the real account and no valve is started
// on hardware (spec 10.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Rachio, readRachioKey, VALVE_BASE, PUBLIC_BASE } from '../src/rachio.js';

function mockFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization });
    const r = handler(url, opts, calls.length) ?? {};
    return { status: r.status ?? 200, ok: (r.status ?? 200) < 400, text: async () => JSON.stringify(r.json ?? {}) };
  };
  return { impl, calls };
}

const rachio = (handler, extra = {}) => {
  const m = mockFetch(handler);
  return { r: new Rachio({ apiKey: 'test-key', fetchImpl: m.impl, sleep: async () => {}, ...extra }), calls: m.calls };
};

test('the API key comes out of the env file and nothing else does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rachio-'));
  const file = path.join(dir, 'rachio.env');
  fs.writeFileSync(file, '# comment\nRACHIO_API_KEY=abc-123\nOTHER=zzz\n');
  assert.equal(readRachioKey(file), 'abc-123');
  fs.writeFileSync(file, 'OTHER=zzz\n');
  assert.throws(() => readRachioKey(file), /RACHIO_API_KEY missing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('endpoints and verbs match spec 1.5', async () => {
  const { r, calls } = rachio(() => ({ json: {} }));
  await r.startWatering('v1', 60);
  await r.stopWatering('v1');
  await r.getValve('v1');
  await r.listBaseStations('u1');
  await r.listValves('b1');
  await r.personInfo();
  await r.getValveDayViews('b1', new Date(2026, 8, 16));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    `PUT ${VALVE_BASE}/valve/startWatering`,
    `PUT ${VALVE_BASE}/valve/stopWatering`,
    `GET ${VALVE_BASE}/valve/getValve/v1`,
    `GET ${VALVE_BASE}/valve/listBaseStations/u1`,
    `GET ${VALVE_BASE}/valve/listValves/b1`,
    `GET ${PUBLIC_BASE}/person/info`,
    `POST ${VALVE_BASE}/summary/getValveDayViews`,
  ]);
  assert.deepEqual(calls[0].body, { valveId: 'v1', durationSeconds: 60 });
  assert.deepEqual(calls[6].body, { resourceId: { baseStationId: 'b1' }, start: { year: 2026, month: 9, day: 16 }, end: { year: 2026, month: 9, day: 16 } });
  assert.equal(calls[0].auth, 'Bearer test-key');
});

test('discover returns the base station and its valves', async () => {
  const { r } = rachio((url) => {
    if (url.endsWith('/person/info')) return { json: { id: 'u1' } };
    if (url.includes('listBaseStations')) return { json: { baseStations: [{ id: 'b1' }] } };
    if (url.includes('listValves')) return { json: { valves: [{ id: 'v1', name: 'Hose Sprinkler 1' }, { id: 'v2', name: 'Hose sprinkler 2' }] } };
    return { json: {} };
  });
  const found = await r.discover();
  assert.equal(found.baseStationId, 'b1');
  assert.deepEqual(found.valves.map((v) => v.name), ['Hose Sprinkler 1', 'Hose sprinkler 2']);
});

test('a 401 is surfaced for the health sensor', async () => {
  const { r } = rachio(() => ({ status: 401, json: {} }));
  const res = await r.getValve('v1');
  assert.equal(res.ok, false);
  assert.equal(r.lastAuthError, 'Rachio HTTP 401');
});

test('programRunning ignores a quick run and catches a program', async () => {
  const quick = rachio(() => ({ json: { valve: { state: { reportedState: { lastWateringAction: { reason: 'QUICK_RUN', durationSeconds: 60 } } } } } }));
  assert.equal(await quick.r.programRunning(['v1']), false);

  const program = rachio(() => ({ json: { valve: { state: { reportedState: { lastWateringAction: { reason: 'SCHEDULE', durationSeconds: 30 } } } } } }));
  assert.equal(await program.r.programRunning(['v1']), true);

  const idle = rachio(() => ({ json: { valve: { state: { reportedState: { lastWateringAction: null } } } } }));
  assert.equal(await idle.r.programRunning(['v1', 'v2']), false);
  assert.equal(await idle.r.programRunning([]), false);
});

test('startAndConfirm records the call, the confirmation and the clear (spec 6.6)', async () => {
  let tick = 0;
  const { r, calls } = rachio((url, opts, n) => {
    if (url.includes('startWatering')) return { json: { ok: true } };
    // getValve: idle on the first poll, watering on the next two, idle again after
    tick += 1;
    const action = tick >= 2 && tick <= 3 ? { reason: 'QUICK_RUN', durationSeconds: 60 } : null;
    return { json: { valve: { state: { reportedState: { lastWateringAction: action } } } } };
  }, { now: (() => { let t = 0; return () => (t += 1000); })() });

  const patches = [];
  const res = await r.startAndConfirm('v1', 60, {
    onCalled: (p) => patches.push(['called', p]),
    onConfirmed: (p) => patches.push(['confirmed', p]),
    onCleared: (p) => patches.push(['cleared', p]),
  });
  assert.equal(res.ok, true);
  assert.equal(res.stoppedBy, 'duration');
  assert.ok(res.confirmedAt);
  assert.ok(res.clearedAt);
  assert.deepEqual(patches.map((p) => p[0]), ['called', 'confirmed', 'cleared']);
  assert.equal(patches[0][1].http_status, 200);
  assert.equal(calls[0].url.endsWith('/valve/startWatering'), true);
});

test('startAndConfirm reports a failed start and polls nothing', async () => {
  const { r, calls } = rachio(() => ({ status: 500, json: {} }));
  const errors = [];
  const res = await r.startAndConfirm('v1', 60, { onCalled: () => {}, onError: (m) => errors.push(m) });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(errors, ['startWatering HTTP 500']);
});

test('shouldStop sends stopWatering and marks the run stopped by a person', async () => {
  const { r, calls } = rachio(() => ({ json: { valve: { state: { reportedState: { lastWateringAction: { reason: 'QUICK_RUN' } } } } } }));
  const cleared = [];
  const res = await r.startAndConfirm('v1', 60, { shouldStop: () => true, onCleared: (p) => cleared.push(p) });
  assert.equal(res.stoppedBy, 'person');
  assert.equal(cleared[0].stopped_by, 'person');
  assert.ok(calls.some((c) => c.url.endsWith('/valve/stopWatering')));
});

test('the stop reason rides through to runs.stopped_by', async () => {
  const { r } = rachio(() => ({ json: { valve: { state: { reportedState: { lastWateringAction: { reason: 'QUICK_RUN' } } } } } }));
  const res = await r.startAndConfirm('v1', 60, { shouldStop: () => 'shutdown' });
  assert.equal(res.stoppedBy, 'shutdown');
});

test('a stop that races startWatering is still sent once the start returns (review 2 item 1)', async () => {
  // The person arrives while the PUT is in flight. The caller's own stop went out before the valve
  // opened, so it did nothing, and only the loop's stop actually closes the water.
  let stopRequested = false;
  const { r, calls } = rachio((url) => {
    if (url.includes('startWatering')) { stopRequested = true; return { json: {} }; }
    return { json: { valve: { state: { reportedState: { lastWateringAction: { reason: 'QUICK_RUN' } } } } } };
  });
  let callerStops = 0;
  const res = await r.startAndConfirm('v1', 60, {
    shouldStop: () => (stopRequested ? 'person' : false),
    onStopNeeded: async () => { callerStops += 1; }, // an old-style hook must not suppress the stop
  });
  const order = calls.map((c) => c.url.split('/').pop());
  assert.equal(order[0], 'startWatering');
  assert.ok(order.includes('stopWatering'), 'a stop PUT is sent after the start returns');
  assert.ok(order.indexOf('stopWatering') > order.indexOf('startWatering'));
  assert.equal(res.stoppedBy, 'person');
  assert.equal(callerStops, 0, 'the loop never delegates its stop away');
});
