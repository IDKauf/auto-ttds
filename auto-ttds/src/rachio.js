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

  /** Current lastWateringAction for a valve, or null when it is idle (spec 1.5). */
  async lastWateringAction(valveId) {
    const res = await this.getValve(valveId);
    const valve = res.json?.valve ?? res.json;
    return valve?.state?.reportedState?.lastWateringAction ?? null;
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
        hooks.onCleared?.({ cleared_at: clearedAt, stopped_by: by });
        return { ok: true, status: started.status, confirmedAt, clearedAt, stoppedBy: by };
      }
      let action = null;
      try { action = await this.lastWateringAction(valveId); } catch { continue; }
      if (action && !confirmedAt) {
        confirmedAt = new Date().toISOString();
        hooks.onConfirmed?.({ confirmed_at: confirmedAt });
      } else if (!action && confirmedAt) {
        clearedAt = new Date().toISOString();
        hooks.onCleared?.({ cleared_at: clearedAt, stopped_by: 'duration' });
        return { ok: true, status: started.status, confirmedAt, clearedAt, stoppedBy: 'duration' };
      }
    }
    hooks.onCleared?.({ cleared_at: new Date().toISOString(), stopped_by: null });
    return { ok: true, status: started.status, confirmedAt, clearedAt: null, stoppedBy: null };
  }
}
