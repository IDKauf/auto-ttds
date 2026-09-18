// rachio.js: Smart Hose Timer calls (spec 1.5). Plain fetch, no SDK.
// Base URL and fetch are injected so tests never touch the real account (spec 10.2).
import fs from 'node:fs';

export const VALVE_BASE = 'https://cloud-rest.rach.io';
export const PUBLIC_BASE = 'https://api.rach.io/1/public';

/** Read RACHIO_API_KEY from the probe's mode-600 env file. The key is never logged. */
export function readRachioKey(envFile) {
  const text = fs.readFileSync(envFile, 'utf8');
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    if (line.slice(0, i).trim() === 'RACHIO_API_KEY') return line.slice(i + 1).trim();
  }
  throw new Error('RACHIO_API_KEY missing from the Rachio env file');
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * detectFlow is the valve's capability flag, not a reading. All three valves report it false today,
 * so treating it as a measurement would record "no water moved" on every run when the honest answer
 * is that nothing was measured.
 */
export const FLOW_CAPABILITY_KEYS = ['detectflow', 'flowdetectionenabled', 'hasflowmeter'];

/** A flow value, as 1, 0 or null. Strings and numbers are accepted because the shape is unknown. */
function flowValue(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 0 ? 1 : 0) : null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'detected') return 1;
    if (s === 'false' || s === 'no' || s === 'none' || s === 'not_detected') return 0;
    const n = Number(s);
    return Number.isFinite(n) && s !== '' ? (n > 0 ? 1 : 0) : null;
  }
  return null;
}

/**
 * flowDetectedFrom: 1, 0 or null for one valve's getValve payload.
 *
 * Verified 2026-09-16: the Smart Hose Timer has an integrated flow meter, every valve reports
 * detectFlow false, and the valve state carries no flow or volume field at all. So this returns
 * null today, which is what "not reported" on the page means. It is written as a search rather than
 * a fixed path on purpose: the day Rachio starts sending a flow field, under whatever name, the
 * column starts filling in with no code change.
 */
export function flowDetectedFrom(valve) {
  const scopes = [valve?.state?.reportedState?.lastWateringAction, valve?.state?.reportedState, valve?.state, valve];
  for (const scope of scopes) {
    if (!scope || typeof scope !== 'object') continue;
    for (const [key, raw] of Object.entries(scope)) {
      const k = key.toLowerCase();
      if (!k.includes('flow')) continue;
      if (FLOW_CAPABILITY_KEYS.includes(k)) continue;
      const v = flowValue(raw);
      if (v !== null) return v;
    }
  }
  return null;
}

export class Rachio {
  constructor({ apiKey, fetchImpl = globalThis.fetch, valveBase = VALVE_BASE, publicBase = PUBLIC_BASE, sleep = sleepMs, now = () => Date.now() } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.valveBase = valveBase;
    this.publicBase = publicBase;
    this.sleep = sleep;
    this.now = now;
    this.lastAuthError = null; // 401/403 goes to sensor.auto_ttds_health (spec 6.8)
    this.callsToday = 0;
  }

  async call(method, url, body) {
    const t0 = this.now();
    const res = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ms = this.now() - t0;
    this.callsToday += 1;
    const text = await res.text();
    let json = null;
    try { json = text && text.trim().startsWith('{') ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status === 401 || res.status === 403) this.lastAuthError = `Rachio HTTP ${res.status}`;
    else if (res.ok) this.lastAuthError = null;
    return { status: res.status, ok: res.ok, ms, json, text: json ? null : text.slice(0, 200) };
  }

  personInfo() { return this.call('GET', `${this.publicBase}/person/info`); }
  listBaseStations(userId) { return this.call('GET', `${this.valveBase}/valve/listBaseStations/${userId}`); }
  listValves(baseId) { return this.call('GET', `${this.valveBase}/valve/listValves/${baseId}`); }
  getValve(valveId) { return this.call('GET', `${this.valveBase}/valve/getValve/${valveId}`); }
  startWatering(valveId, durationSeconds) { return this.call('PUT', `${this.valveBase}/valve/startWatering`, { valveId, durationSeconds }); }
  stopWatering(valveId) { return this.call('PUT', `${this.valveBase}/valve/stopWatering`, { valveId }); }

  getValveDayViews(baseStationId, date = new Date()) {
    const d = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
    return this.call('POST', `${this.valveBase}/summary/getValveDayViews`, { resourceId: { baseStationId }, start: d, end: d });
  }

  /** Discover base stations and valves once at boot. Returns {baseStationId, valves:[{id,name}]}. */
  async discover() {
    const info = await this.personInfo();
    const userId = info.json?.id;
    if (!userId) return { baseStationId: null, valves: [], error: `person/info HTTP ${info.status}` };
    const bases = await this.listBaseStations(userId);
    const base = (bases.json?.baseStations ?? [])[0];
    if (!base) return { baseStationId: null, valves: [], error: 'no base stations on the account' };
    const valves = await this.listValves(base.id);
    return {
      userId,
      baseStationId: base.id,
      valves: (valves.json?.valves ?? []).map((v) => ({ id: v.id, name: v.name })),
      error: null,
    };
  }

  /**
   * One getValve, read twice: the watering action that says whether the valve is open, and the flow
   * reading if the timer ever sends one. -> {action, flow}
   */
  async valveSnapshot(valveId) {
    const res = await this.getValve(valveId);
    const valve = res.json?.valve ?? res.json;
    return {
      action: valve?.state?.reportedState?.lastWateringAction ?? null,
      flow: flowDetectedFrom(valve),
    };
  }

  /** Current lastWateringAction for a valve, or null when it is idle (spec 1.5). */
  async lastWateringAction(valveId) {
    return (await this.valveSnapshot(valveId)).action;
  }

  /**
   * programRunning: true when any of these valves is mid-run for a reason other than a quick run,
   * which is what a scheduled Rachio program looks like (spec 7.11).
   */
  async programRunning(valveIds) {
    for (const id of valveIds ?? []) {
      let action = null;
      try { action = await this.lastWateringAction(id); } catch { continue; }
      if (!action) continue;
      const reason = String(action.reason ?? '').toUpperCase();
      if (reason && reason !== 'QUICK_RUN') return true;
    }
    return false;
  }

  /**
   * startAndConfirm: start one valve, then poll getValve every 2 s until lastWateringAction appears
   * and then until it clears (spec 6.6). Callbacks let main.js write the runs row as it goes.
   * Never called from tests against a real account.
   */
  async startAndConfirm(valveId, durationSeconds, hooks = {}) {
    const started = await this.startWatering(valveId, durationSeconds);
    hooks.onCalled?.({ http_status: started.status, http_ms: started.ms, called_at: new Date().toISOString() });
    if (!started.ok) {
      hooks.onError?.(`startWatering HTTP ${started.status}`);
      return { ok: false, status: started.status, confirmedAt: null, clearedAt: null };
    }
    const deadline = this.now() + (durationSeconds + 60) * 1000;
    let confirmedAt = null;
    let clearedAt = null;
    // The last flow reading the timer gave us during this run, or null when it gave none (v0.3).
    let flow = null;
    while (this.now() < deadline) {
      await this.sleep(2000);
      const stopReason = hooks.shouldStop?.();
      if (stopReason) {
        // Always send our own stop (review 2 item 1). The caller's immediate stop may have raced the
        // startWatering call and landed before the valve opened, in which case it did nothing. A
        // duplicate stopWatering is harmless, an ignored one leaves the water running.
        await this.stopWatering(valveId);
        clearedAt = new Date().toISOString();
        const by = typeof stopReason === 'string' ? stopReason : 'person';
        hooks.onCleared?.({ cleared_at: clearedAt, stopped_by: by, flow_detected: flow });
        return { ok: true, status: started.status, confirmedAt, clearedAt, stoppedBy: by, flow };
      }
      let snap = null;
      try { snap = await this.valveSnapshot(valveId); } catch { continue; }
      if (snap.flow !== null) flow = snap.flow;
      if (snap.action && !confirmedAt) {
        confirmedAt = new Date().toISOString();
        hooks.onConfirmed?.({ confirmed_at: confirmedAt, flow_detected: flow });
      } else if (!snap.action && confirmedAt) {
        clearedAt = new Date().toISOString();
        hooks.onCleared?.({ cleared_at: clearedAt, stopped_by: 'duration', flow_detected: flow });
        return { ok: true, status: started.status, confirmedAt, clearedAt, stoppedBy: 'duration', flow };
      }
    }
    hooks.onCleared?.({ cleared_at: new Date().toISOString(), stopped_by: null, flow_detected: flow });
    return { ok: true, status: started.status, confirmedAt, clearedAt: null, stoppedBy: null, flow };
  }
}
