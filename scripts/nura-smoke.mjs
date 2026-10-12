import assert from 'node:assert/strict';
import { applyNuraMoodDelta, buildNuraMessages, formatNuraMoodContext, NURA_IMAGE_TYPES, NURA_MAX_IMAGES, NURA_MODEL_ID, requestNuraReply } from '../server/nura.mjs';

assert.equal(NURA_MODEL_ID, 'qwen/qwen3.8-27b');
assert.equal(NURA_MAX_IMAGES, 3);
assert.deepEqual([...NURA_IMAGE_TYPES].sort(), ['image/jpeg', 'image/png', 'image/webp']);

const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } };
const messages = buildNuraMessages([
  { role: 'user', content: 'Earlier question' },
  { role: 'assistant', content: 'Earlier reply' },
  { role: 'user', content: 'What is this?' },
], 'Nuper', [image]);
assert.equal(messages[0].role, 'system');
assert.match(messages[0].content, /emotionally responsive/);
assert.match(messages[0].content, /no.*flirt/i);
assert.equal(messages.at(-1).role, 'user');
assert.deepEqual(messages.at(-1).content, [{ type: 'text', text: 'Message from Nuper: What is this?' }, image]);
assert.equal(messages.some((message) => /video/i.test(JSON.stringify(message))), false);

const mood = { energy: 5, patience: 5, happiness: 5, stress: 3 };
const bond = { trust: 5, affection: 5, annoyance: 0 };
const hurt = applyNuraMoodDelta(mood, bond, 'you are so stupid');
assert.ok(hurt.mood.patience < mood.patience);
assert.ok(hurt.mood.stress > mood.stress);
assert.ok(hurt.bond.annoyance > bond.annoyance);
const kindness = applyNuraMoodDelta(mood, bond, 'thanks, you helped me');
assert.ok(kindness.mood.happiness > mood.happiness);
assert.ok(kindness.bond.affection > bond.affection);
const moodPrompt = buildNuraMessages([{ role: 'user', content: 'hello' }], 'Nuper', [], formatNuraMoodContext(hurt.mood, hurt.bond, 'Nuper'));
assert.match(moodPrompt[0].content, /CURRENT MOOD/);
assert.match(moodPrompt[0].content, /YOUR VIBE WITH NUPER/);

let capturedUrl = '';
let capturedBody;
const reply = await requestNuraReply({
  apiKey: 'test-secret',
  messages,
  fetchImpl: async (url, options) => {
    capturedUrl = url;
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A small blue bird.' } }] }), { status: 200 });
  },
});
assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/chat/completions');
assert.equal(capturedBody.model, 'qwen/qwen3.8-27b');
assert.equal(capturedBody.max_tokens, 2048);
assert.equal(reply, 'a small blue bird.');

await requestNuraReply({
  apiKey: 'test-secret', messages, maxTokens: 512,
  fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).max_tokens, 512);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'quick server reply' } }] }), { status: 200 });
  },
});

await assert.rejects(() => requestNuraReply({ apiKey: '', messages, fetchImpl: () => { throw new Error('must not call network'); } }), /temporarily unavailable/);
await assert.rejects(() => requestNuraReply({
  apiKey: 'test-secret', messages,
  fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'quota details' } }), { status: 429 }),
}), /rate limit/);

console.log('Nura Groq-only text/image smoke test passed.');
