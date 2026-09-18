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

/**
 * The constrained species set (v0.3). The classifier decides whether water runs, so the answer has
 * to be a value decide() can act on rather than free text. Anything the model wants to add about
 * the animal goes in detail, which nothing acts on.
 */
export const SPECIES = [
  'person',
  'none',
  'animal_unknown',
  'eyes_unknown',
  'cat', 'dog', 'raccoon', 'opossum', 'skunk', 'rabbit', 'rat', 'bird', 'deer', 'coyote', 'squirrel',
];

export const SYSTEM_PROMPT = [
  'You are looking at still images from a yard camera at a private home.',
  'Say what is in view. Return only the fields in the schema.',
  'species must be one of the allowed values, and nothing else.',
  'Use "person" when a person is visible. Do not describe people: say nothing else about them.',
  'Use "none" when no animal is present, for example moving shade, blowing plants, rain, a passing car or an empty yard.',
  'Use a specific common name only when you can actually tell the species apart.',
  'Use "animal_unknown" when an animal is clearly present but you cannot tell which species it is.',
  'Use "eyes_unknown" when all you can see is eyeshine, the bright reflected eyes typical of night infrared.',
  'Eyeshine at night means an animal is there, so it is never "none".',
  'Guessing a species you cannot see costs more than answering animal_unknown or eyes_unknown.',
].join(' ');

// Structured output schema, used as output_config.format. No tool_choice forcing, no prefill.
// is_person is not asked for: it is derived from species === 'person'.
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    species: { type: 'string', enum: SPECIES, description: 'one of the allowed values, nothing else' },
    detail: { type: 'string', description: 'free text about the animal, at most 160 characters, empty when there is nothing to add' },
    count: { type: 'integer', description: 'how many of that species are visible' },
    confidence: { type: 'number', description: '0 to 1' },
    evidence: { type: 'string', description: 'at most 160 characters of what the images show' },
  },
  required: ['species', 'detail', 'count', 'confidence', 'evidence'],
  additionalProperties: false,
};

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildMessages(images) {
  const content = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Image ${i + 1}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
  });
  content.push({
    type: 'text',
    text: `Allowed species values: ${SPECIES.join(', ')}. Answer with the schema fields only.`,
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
   * On an API error it retries once after 30 s, then records the error.
   * friendlies is recorded on the row for the page. It is not sent to the model and it is not what
   * suppresses a run: decide() reads the knob itself.
   */
  async classify(imagePaths, friendlies = []) {
    const images = this.loadImages(imagePaths);
    const at = new Date().toISOString();
    if (!images.length) {
      return { model: this.model, at, error: 'no frames available', input_tokens: 0, output_tokens: 0, usd: 0, latency_ms: 0 };
    }
    const friendlyList = (friendlies ?? []).map((f) => String(f).trim().toLowerCase());
    const messages = buildMessages(images);
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
        const species = String(parsed?.species ?? '').trim().toLowerCase() || null;
        // The classification decides whether water runs, so a species outside the allowed set is an
        // error rather than a guess to act on. The caller skips with classifier_error.
        const bad = species && !SPECIES.includes(species) ? `species "${species}" is not in the allowed set` : null;
        return {
          model: res?.model ?? this.model,
          species: bad ? null : species,
          count: Number.isFinite(Number(parsed?.count)) ? Number(parsed.count) : null,
          is_person: species === 'person' ? 1 : 0, // derived, never asked for
          friendly: species && friendlyList.includes(species) ? 1 : 0,
          confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : null,
          frames_agree: null, // one call covers all images, so there is nothing to compare
          raw_json: JSON.stringify({ verdict: parsed, images: images.length }),
          input_tokens: inTok,
          output_tokens: outTok,
          usd: usdFor(priceKey, inTok, outTok),
          latency_ms: latency,
          at: new Date().toISOString(),
          error: parsed ? bad : 'no JSON in response',
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
