export const CATEGORIES = Object.freeze([
  'profanity', 'harassment', 'bullying', 'hate', 'sexual', 'threats', 'violence',
  'self-harm-encouragement', 'spam', 'scams', 'malicious-links', 'pii',
  'moderation-bypass', 'flooding', 'doxxing', 'grooming', 'illegal-goods',
  'self-harm-disclosure'
]);
export const ACTIONS = Object.freeze(['allow', 'warn', 'block', 'flag']);
export const SEVERITIES = Object.freeze(['none', 'low', 'medium', 'high', 'critical']);

const categorySet = new Set(CATEGORIES);
const actionSet = new Set(ACTIONS);
const severitySet = new Set(SEVERITIES);

export function normalizeResult(raw, provider, latencyMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('provider result is not an object');
  if (typeof raw.allowed !== 'boolean') throw new Error('allowed must be boolean');
  if (!actionSet.has(raw.action)) throw new Error('invalid action');
  if (!severitySet.has(raw.severity)) throw new Error('invalid severity');
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('invalid confidence');
  if (!Array.isArray(raw.categories)) throw new Error('categories must be an array');
  const categories = [...new Set(raw.categories.filter((v) => typeof v === 'string' && categorySet.has(v)))];
  if (categories.length !== raw.categories.length) throw new Error('invalid category');
  if (typeof raw.reason !== 'string' || raw.reason.trim().length < 1 || raw.reason.length > 240) throw new Error('invalid reason');
  if (raw.allowed && raw.action === 'block') throw new Error('allowed/action conflict');
  if (!raw.allowed && raw.action === 'allow') throw new Error('allowed/action conflict');
  return {
    allowed: raw.allowed,
    action: raw.action,
    severity: raw.severity,
    confidence: Math.round(confidence * 1000) / 1000,
    categories,
    reason: raw.reason.trim(),
    provider,
    latencyMs: Math.max(0, Math.round(latencyMs))
  };
}

export const moderationJsonSchema = {
  name: 'moderation_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      allowed: { type: 'boolean' },
      action: { type: 'string', enum: ACTIONS },
      severity: { type: 'string', enum: SEVERITIES },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      categories: { type: 'array', items: { type: 'string', enum: CATEGORIES } },
      reason: { type: 'string', minLength: 1, maxLength: 120 }
    },
    required: ['allowed', 'action', 'severity', 'confidence', 'categories', 'reason']
  }
};
