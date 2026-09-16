// ha.js: Home Assistant Core REST through the Supervisor proxy (spec 1.8, 6.7).
// homeassistant_api: true in config.yaml puts SUPERVISOR_TOKEN in the environment.
import { log } from './log.js';

export class Ha {
  constructor({ token = process.env.SUPERVISOR_TOKEN, base = 'http://supervisor/core/api', fetchImpl = globalThis.fetch } = {}) {
    this.token = token;
    this.base = base;
    this.fetchImpl = fetchImpl;
    this.enabled = Boolean(token);
  }

  async call(method, path, body) {
    if (!this.enabled) throw new Error('no SUPERVISOR_TOKEN; HA calls are disabled');
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HA ${method} ${path} HTTP ${res.status}`);
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }

  /** getStates(ids) -> {entity_id: state}. Missing helpers are simply absent (spec 4). */
  async getStates(ids) {
    const out = {};
    for (const id of ids) {
      try {
        const st = await this.call('GET', `/states/${encodeURIComponent(id)}`);
        if (st?.state !== undefined) out[id] = st.state;
      } catch { /* helper not created yet; the default applies */ }
    }
    return out;
  }

  async setState(entityId, state, attributes = {}) {
    try {
      await this.call('POST', `/states/${encodeURIComponent(entityId)}`, { state: String(state), attributes });
    } catch (err) {
      log.debug(`setState ${entityId} failed: ${err.message}`);
    }
  }

  async fireEvent(type, data) {
    try {
      await this.call('POST', `/events/${encodeURIComponent(type)}`, data);
    } catch (err) {
      log.debug(`fireEvent ${type} failed: ${err.message}`);
    }
  }
}

/** Sensor payloads for spec 6.7. Pure, so the test can assert the shape. */
export function healthAttributes({ pushConnected, lastPollOk, ringTokenAgeHours, rachioError, lastPollAt }) {
  return {
    push_connected: Boolean(pushConnected),
    last_poll_ok: Boolean(lastPollOk),
    ring_token_age_hours: ringTokenAgeHours === null || ringTokenAgeHours === undefined ? null : Math.round(ringTokenAgeHours * 10) / 10,
    rachio_error: rachioError ?? null,
    last_poll_at: lastPollAt ?? null,
  };
}

export function healthState(attrs) {
  if (attrs.rachio_error) return 'error';
  if (!attrs.last_poll_ok) return 'error';
  return 'ok';
}
