// Cost math, prompt shape and the Claude call with a mocked client (spec 11.1, 10.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICES, usdFor, priceKeyFor, imageTokens, buildMessages, extractJson, framePaths, Classifier, VERDICT_SCHEMA, SYSTEM_PROMPT } from '../src/classifier.js';

test('price table matches spec 1.6', () => {
  assert.deepEqual(PRICES['claude-haiku-4-5'], [1, 5]);
  assert.deepEqual(PRICES['claude-sonnet-5'], [2, 10]);
  assert.deepEqual(PRICES['claude-opus-5'], [5, 25]);
});

test('cost math per model', () => {
  assert.equal(usdFor('claude-haiku-4-5', 1_000_000, 0), 1);
  assert.equal(usdFor('claude-haiku-4-5', 0, 1_000_000), 5);
  assert.equal(usdFor('claude-sonnet-5', 1_000_000, 1_000_000), 12);
  assert.equal(usdFor('claude-opus-5', 1_000_000, 1_000_000), 30);
  // A typical call: three 960x540 frames plus prompt, 2200 in and 120 out on Haiku.
  assert.equal(Number(usdFor('claude-haiku-4-5', 2200, 120).toFixed(6)), 0.0028);
  assert.equal(usdFor('not-a-model', 1000, 1000), 0);
  assert.equal(usdFor('claude-haiku-4-5', undefined, null), 0);
});

test('the dated model id the API echoes back is still priced (review item 5)', () => {
  assert.equal(priceKeyFor('claude-haiku-4-5', 'claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(priceKeyFor('claude-haiku-4-5-20251001', undefined), 'claude-haiku-4-5');
  assert.equal(priceKeyFor('claude-sonnet-5-20260101', 'claude-sonnet-5-20260101'), 'claude-sonnet-5');
  assert.equal(priceKeyFor('claude-opus-5', 'claude-opus-5'), 'claude-opus-5');
  assert.equal(priceKeyFor('some-other-model', 'some-other-model'), null);
  // The configured id wins even when the response echoes something else entirely.
  assert.equal(priceKeyFor('claude-haiku-4-5', 'claude-opus-5'), 'claude-haiku-4-5');
});

test('image token estimate from spec 1.6', () => {
  assert.equal(imageTokens(960, 540), 700);
  assert.equal(imageTokens(28, 28), 1);
});

test('frame paths follow the naming rule', () => {
  assert.deepEqual(framePaths('/share/auto-ttds', 'abc123'), [
    '/share/auto-ttds/frames/abc123_t1.jpg',
    '/share/auto-ttds/frames/abc123_t3.jpg',
    '/share/auto-ttds/frames/abc123_t6.jpg',
  ]);
});

test('three image blocks then the text, in order (spec 6.4)', () => {
  const msgs = buildMessages(['a', 'b', 'c'], ['rabbit']);
  assert.equal(msgs.length, 1);
  const c = msgs[0].content;
  assert.equal(c.length, 7);
  assert.equal(c[0].text, 'Image 1');
  assert.equal(c[1].type, 'image');
  assert.equal(c[1].source.media_type, 'image/jpeg');
  assert.equal(c[1].source.type, 'base64');
  assert.equal(c[2].text, 'Image 2');
  assert.equal(c[4].text, 'Image 3');
  assert.equal(c[6].type, 'text');
  assert.match(c[6].text, /Friendlies list: rabbit/);
  // Never an assistant prefill (spec 10.4)
  assert.ok(msgs.every((m) => m.role === 'user'));
});

test('schema matches spec 6.4', () => {
  assert.deepEqual(Object.keys(VERDICT_SCHEMA.properties).sort(), ['confidence', 'count', 'evidence', 'friendly', 'is_person', 'species']);
  assert.equal(VERDICT_SCHEMA.additionalProperties, false);
  assert.match(SYSTEM_PROMPT, /yard camera/);
  assert.match(SYSTEM_PROMPT, /Do not describe people/);
});

test('extractJson reads parsed_output or a text block', () => {
  assert.deepEqual(extractJson({ parsed_output: { species: 'cat' } }), { species: 'cat' });
  assert.deepEqual(extractJson({ content: [{ type: 'text', text: '{"species":"deer"}' }] }), { species: 'deer' });
  assert.equal(extractJson({ content: [{ type: 'text', text: 'not json' }] }), null);
  assert.equal(extractJson(null), null);
});

function mockClient(impl) {
  const calls = [];
  return { calls, messages: { create: async (req) => { calls.push(req); return impl(req, calls.length); } } };
}

test('classify returns a verdict row with usage and dollars', async () => {
  const client = mockClient(() => ({
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: JSON.stringify({ species: 'Coyote', count: 1, is_person: false, friendly: false, confidence: 0.82, evidence: 'four legs, bushy tail' }) }],
    usage: { input_tokens: 2200, output_tokens: 120 },
  }));
  let t = 0;
  const c = new Classifier({ client, model: 'claude-haiku-4-5', readFile: () => Buffer.from('jpegbytes'), now: () => (t += 250) });
  const v = await c.classify(['/f/a_t1.jpg', '/f/a_t3.jpg', '/f/a_t6.jpg'], ['rabbit']);
  assert.equal(v.species, 'coyote');
  assert.equal(v.is_person, 0);
  assert.equal(v.friendly, 0);
  assert.equal(v.input_tokens, 2200);
  assert.equal(v.output_tokens, 120);
  assert.equal(Number(v.usd.toFixed(6)), 0.0028);
  assert.equal(v.latency_ms, 250);
  assert.equal(v.error, null);
  const req = client.calls[0];
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.equal(req.max_tokens, 400);
  assert.deepEqual(req.output_config, { format: { type: 'json_schema', schema: VERDICT_SCHEMA } });
  assert.equal(req.tool_choice, undefined); // spec 10.4
  assert.equal(req.tools, undefined);
});

test('a dated echoed model id still costs money (review item 5)', async () => {
  const client = mockClient(() => ({
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: '{"species":"cat","count":1,"is_person":false,"friendly":false,"confidence":0.9,"evidence":"x"}' }],
    usage: { input_tokens: 2200, output_tokens: 120 },
  }));
  const c = new Classifier({ client, model: 'claude-haiku-4-5', readFile: () => Buffer.from('x') });
  const v = await c.classify(['/f/a_t1.jpg']);
  assert.ok(v.usd > 0, 'usd must not collapse to zero on a dated model id');
  assert.equal(Number(v.usd.toFixed(6)), 0.0028);
  assert.equal(v.model, 'claude-haiku-4-5-20251001'); // the echo is still what gets recorded
});

test('classify retries once after an API error, then reports it', async () => {
  let slept = 0;
  const client = mockClient(() => { throw new Error('overloaded'); });
  const c = new Classifier({ client, readFile: () => Buffer.from('x'), sleep: async (ms) => { slept += ms; } });
  const v = await c.classify(['/f/a_t1.jpg']);
  assert.equal(client.calls.length, 2);
  assert.equal(slept, 30000);
  assert.equal(v.error, 'overloaded');
  assert.equal(v.usd, 0);
});

test('a retry that succeeds returns the verdict', async () => {
  const client = mockClient((req, n) => {
    if (n === 1) throw new Error('529');
    return { model: 'claude-haiku-4-5', content: [{ type: 'text', text: '{"species":"rabbit","count":1,"is_person":false,"friendly":true,"confidence":0.7,"evidence":"ears"}' }], usage: { input_tokens: 10, output_tokens: 5 } };
  });
  const c = new Classifier({ client, readFile: () => Buffer.from('x'), sleep: async () => {} });
  const v = await c.classify(['/f/a_t1.jpg'], ['rabbit']);
  assert.equal(v.species, 'rabbit');
  assert.equal(v.friendly, 1);
});

test('no readable frames means no API call', async () => {
  const client = mockClient(() => { throw new Error('should not be called'); });
  const c = new Classifier({ client, readFile: () => { throw new Error('missing'); } });
  const v = await c.classify(['/f/nope.jpg']);
  assert.equal(client.calls.length, 0);
  assert.equal(v.error, 'no frames available');
});
