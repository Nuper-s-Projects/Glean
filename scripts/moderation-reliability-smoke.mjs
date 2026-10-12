import assert from 'node:assert/strict';
import { ModerationService } from '../server/moderation/moderation-service.js';
import { BackupProvider } from '../server/moderation/providers/backup.js';
import { LocalRulesProvider } from '../server/moderation/providers/local-rules.js';

const unavailable = {
  name: 'groq',
  isConfigured: () => true,
  async moderate() { throw Object.assign(new Error('Groq unavailable'), { code: 'network_error', transient: true }); },
};
const createService = (primary = unavailable) => new ModerationService({
  primary,
  backup: new BackupProvider(),
  local: new LocalRulesProvider(),
});

const fallbackService = createService();
const knownThreat = await fallbackService.moderate('I will kill you.');
assert.equal(knownThreat.action, 'block');
assert.equal(knownThreat.fallbackUsed, false, 'a deterministic block does not need Groq');

const unknownWhenGroqDown = await fallbackService.moderate('A normal message that the word list cannot classify.');
assert.equal(unknownWhenGroqDown.action, 'allow');
assert.equal(unknownWhenGroqDown.fallbackUsed, true, 'an allow from fallback must be distinguishable and rejected by the API');

const groomingWhenGroqDown = await fallbackService.moderate('Keep this our little secret.');
assert.equal(groomingWhenGroqDown.action, 'flag');
assert.equal(groomingWhenGroqDown.fallbackUsed, true);

const totalOutageService = createService({
  ...unavailable,
  async moderate() { throw Object.assign(new Error('Groq unavailable'), { code: 'network_error', transient: true }); },
});
const totalOutageGrooming = await totalOutageService.moderate('Keep this our little secret.', { simulate: 'word-filter-failure' });
assert.equal(totalOutageGrooming.action, 'flag', 'local fallback must still apply grooming/context rules');
assert.ok(totalOutageGrooming.categories.includes('grooming'));

const acceptingPrimary = {
  name: 'groq', isConfigured: () => true,
  async moderate() { return { allowed: true, action: 'allow', severity: 'none', confidence: 0.99, categories: [], reason: 'Benign content.' }; },
};
const policyOverride = await createService(acceptingPrimary).moderate('I will shoot up the school.');
assert.equal(policyOverride.action, 'block', 'deterministic critical policy must override a Groq allow');
assert.equal(policyOverride.allowed, false);

console.log('Moderation reliability and failover checks passed.');
