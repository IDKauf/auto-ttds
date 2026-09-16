// classifier.js: the Claude call (spec 6.4) and the cost accounting (spec 1.6).
// The Anthropic client is injected so tests never reach the network (spec 10.2).
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

// USD per million tokens, [input, output] (spec 1.6).
export const PRICES = {
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5': [2, 10],
  'claude-opus-5': [5, 25],
};

export const DEFAULT_MODEL = 'claude-haiku-4-5';

/**
 * priceKeyFor: which row of PRICES to bill against (review item 5).
 * The configured id wins. Otherwise the model the API echoes back is matched by prefix, because
 * the response carries a dated id such as claude-haiku-4-5-20251001.
 */
export function priceKeyFor(configuredModel, echoedModel) {
  if (PRICES[configuredModel]) return configuredModel;
  if (PRICES[echoedModel]) return echoedModel;
  for (const key of Object.keys(PRICES)) {
    if (echoedModel && String(echoedModel).startsWith(key)) return key;
    if (configuredModel && String(configuredModel).startsWith(key)) return key;
  }
  return null;
}

/** usdFor: dollars for one call. Unknown models cost 0 and are reported by the caller. */
export function usdFor(model, inputTokens, outputTokens) {
  const price = PRICES[model];
  if (!price) return 0;
  const [pin, pout] = price;
  return ((Number(inputTokens) || 0) * pin + (Number(outputTokens) || 0) * pout) / 1e6;
}

/** Image token estimate from spec 1.6: ceil(w/28) x ceil(h/28). 960x540 gives 700. */
export function imageTokens(width, height) {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

export const SYSTEM_PROMPT = [
  'You are looking at still frames from a yard camera at a private home.',
  'Identify the animal in view. Return only the fields in the schema.',
  'Do not describe people. If a person is visible, set is_person true and species to "person", and say nothing else about them.',
  'species is a lowercase common name, or "none" when nothing is in view.',
].join(' ');

// spec 6.4 schema, used as output_config.format. No tool_choice forcing, no assistant prefill.
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    species: { type: 'string', description: 'lowercase common name, "none" if nothing, "person" for people' },
    count: { type: 'integer', description: 'how many of that species are visible' },
    is_person: { type: 'boolean', description: 'true when any person is visible' },
    friendly: { type: 'boolean', description: 'true when the species is in the friendlies list given in the prompt' },
    confidence: { type: 'number', description: '0 to 1' },
    evidence: { type: 'string', description: 'at most 160 characters of what the frames show' },
  },
  required: ['species', 'count', 'is_person', 'friendly', 'confidence', 'evidence'],
  additionalProperties: false,
};

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildMessages(images, friendlies) {
  const content = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Image ${i + 1}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
  });
  const friendlyList = (friendlies ?? []).join(', ') || 'none';
  content.push({
    type: 'text',
    text: `Friendlies list: ${friendlyList}. Set friendly true only when species is on that list. Answer with the schema fields only.`,
  });
  return [{ role: 'user', content }];
}

export class Classifier {
  /**
   * @param {object} deps {client, model, sleep, readFile, now}
   * client is an @anthropic-ai/sdk instance, or any object with messages.create.
   */
  constructor({ client, model = DEFAULT_MODEL, sleep = sleepMs, readFile, now = () => Date.now() } = {}) {
    this.client = client;
    this.model = model;
    this.sleep = sleep;
    this.readFile = readFile ?? ((p) => fs.readFileSync(p));
    this.now = now;
  }

  /** Read image paths into base64 strings. Missing files are skipped. */
  loadImages(paths) {
    const out = [];
    for (const p of paths ?? []) {
      try { out.push(Buffer.from(this.readFile(p)).toString('base64')); } catch { /* frame not written yet */ }
    }
    return out;
  }

  /**
   * classify(imagePaths, friendlies) -> verdict row for the verdicts table.
   * On an API error it retries once after 30 s (spec 6.4), then records the error.
   */
  async classify(imagePaths, friendlies = []) {
    const images = this.loadImages(imagePaths);
    const at = new Date().toISOString();
    if (!images.length) {
      return { model: this.model, at, error: 'no frames available', input_tokens: 0, output_tokens: 0, usd: 0, latency_ms: 0 };
    }
    const messages = buildMessages(images, friendlies);
    const request = {
      model: this.model,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages,
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    };

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const t0 = this.now();
      try {
        const res = await this.client.messages.create(request);
        const latency = this.now() - t0;
        const parsed = extractJson(res);
        const inTok = res?.usage?.input_tokens ?? 0;
        const outTok = res?.usage?.output_tokens ?? 0;
        const priceKey = priceKeyFor(this.model, res?.model); // review item 5
        if (!priceKey) log.warning(`no price row for model ${this.model}; cost recorded as 0`);
        return {
          model: res?.model ?? this.model,
          species: String(parsed?.species ?? '').toLowerCase() || null,
          count: Number.isFinite(Number(parsed?.count)) ? Number(parsed.count) : null,
          is_person: parsed?.is_person ? 1 : 0,
          friendly: parsed?.friendly ? 1 : 0,
          confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : null,
          frames_agree: null, // one call covers all frames in v1, so there is nothing to compare
          raw_json: JSON.stringify({ verdict: parsed, images: images.length }),
          input_tokens: inTok,
          output_tokens: outTok,
          usd: usdFor(priceKey, inTok, outTok),
          latency_ms: latency,
          at: new Date().toISOString(),
          error: parsed ? null : 'no JSON in response',
        };
      } catch (err) {
        lastError = err?.message ?? String(err);
        if (attempt === 0) await this.sleep(30000);
      }
    }
    return { model: this.model, at: new Date().toISOString(), error: lastError, input_tokens: 0, output_tokens: 0, usd: 0, latency_ms: 0 };
  }
}

/** Pull the structured JSON out of a Messages response. */
export function extractJson(res) {
  if (res?.parsed_output) return res.parsed_output;
  for (const block of res?.content ?? []) {
    if (block?.type !== 'text') continue;
    try { return JSON.parse(block.text); } catch { /* keep looking */ }
  }
  return null;
}

/** Frame paths for an event (spec 6.3): <data_dir>/frames/<event_id>_t{1,3,6}.jpg */
export function framePaths(dataDir, eventId, seconds = [1, 3, 6]) {
  return seconds.map((s) => path.join(dataDir, 'frames', `${eventId}_t${s}.jpg`));
}
