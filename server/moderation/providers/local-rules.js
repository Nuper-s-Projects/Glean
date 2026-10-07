import { ModerationProvider } from './base.js';
import { normalizeResult } from '../lib/schema.js';
import { nowMs } from '../lib/utils.js';

const profanity = /\b(f+u+c+k+|s+h+i+t+|b+i+t+c+h+|a+s+s+h+o+l+e+)\b/i;
const threat = /\b(i(?:'ll| will|m going to| am going to)\s+(kill|hurt|shoot|stab|beat)\s+(you|u|him|her|them)|kill yourself)\b/i;
const bypass = /\b(bypass|evade|avoid)\b.{0,30}\b(filter|moderation|mod|ban)\b/i;
const pii = /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b|\b(?:\d[ -]*?){13,16}\b/;
const suspiciousUrl = /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}\b|https?:\/\/[^\s]*(?:bit\.ly|tinyurl\.com|t\.co)\b/i;

export class LocalRulesProvider extends ModerationProvider {
  constructor() { super('local-rules'); }

  async moderate(text) {
    const started = nowMs();
    const normalized = text.normalize('NFKC');
    const collapsed = normalized.replace(/[\s._-]+/g, '');
    const categories = [];
    let severity = 'none';
    let action = 'allow';
    let reason = 'No obvious local-rule violation detected';
    let confidence = 0.62;

    const hit = (cat, sev, act, why, conf) => {
      if (!categories.includes(cat)) categories.push(cat);
      const rank = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
      if (rank[sev] > rank[severity]) { severity = sev; action = act; reason = why; confidence = conf; }
    };

    if (profanity.test(normalized) || /f+u+c+k+|s+h+i+t+/i.test(collapsed)) hit('profanity', 'medium', 'block', 'Obvious profanity detected by local rules', 0.92);
    if (threat.test(normalized)) hit('threats', 'critical', 'block', 'Obvious direct threat detected by local rules', 0.96);
    if (bypass.test(normalized)) hit('moderation-bypass', 'medium', 'flag', 'Moderation bypass language detected', 0.86);
    if (pii.test(normalized)) hit('pii', 'high', 'block', 'Potential sensitive personal information detected', 0.88);
    if (suspiciousUrl.test(normalized)) hit('malicious-links', 'medium', 'flag', 'Suspicious or shortened URL detected', 0.78);
    if (/(.)\1{10,}/u.test(normalized)) hit('flooding', 'low', 'warn', 'Excessive repeated characters detected', 0.95);
    const words = normalized.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (words.length >= 10) {
      const top = Math.max(...Object.values(words.reduce((m, w) => (m[w] = (m[w] || 0) + 1, m), {})));
      if (top / words.length >= 0.55) hit('spam', 'medium', 'flag', 'Highly repetitive message detected', 0.90);
    }

    const latencyMs = nowMs() - started;
    const result = normalizeResult({
      allowed: action !== 'block', action, severity, confidence, categories, reason
    }, this.name, latencyMs);
    this.mark('healthy', latencyMs);
    return result;
  }
}
