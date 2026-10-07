import assert from 'node:assert/strict';

process.env.GROQ_API_KEY = '';
const { moderateServerMessage } = await import('../server/moderation/index.mjs');

const blocked = await moderateServerMessage('I will kill you.');
assert.equal(blocked.action, 'block');

const flagged = await moderateServerMessage('Keep this our little secret.');
assert.equal(flagged.action, 'flag');
assert.ok(flagged.categories.includes('grooming'));

const allowed = await moderateServerMessage('Good morning, everyone!');
assert.equal(allowed.action, 'allow');

console.log('Server message moderation smoke tests passed.');
