import { ModerationProvider } from './base.js';
import { ProviderError } from '../lib/errors.js';
import { normalizeResult } from '../lib/schema.js';
import { BAD_WORD_COUNT, scan, verdict } from '../data/bad-words.js';
import { nowMs } from '../lib/utils.js';

const rank = Object.freeze({ none: 0, low: 1, medium: 2, high: 3, critical: 4 });
export class BackupProvider extends ModerationProvider {
  constructor() {
    super('word-filter');
  }

  async moderate(text, context = {}) {
    const started = nowMs();
    const simulation = context.simulate;
    if (simulation === 'word-filter-failure' || simulation === `${this.name}-failure`) {
      this.mark('unhealthy', 0, 'simulated_failure');
      throw new ProviderError('simulated word-filter failure', { status: 503, transient: false, code: 'simulated_failure' });
    }

    const matches = scan(text);

    let action = 'allow';
    let severity = 'none';
    let confidence = 0.86;
    let reason = `No blocked dictionary terms found across ${BAD_WORD_COUNT} entries`;
    const categories = [];

    if (matches.length) {
      let strongest = matches[0];
      for (const match of matches) {
        if (!categories.includes(match.category)) categories.push(match.category);
        if (rank[match.severity] > rank[strongest.severity]) strongest = match;
      }
      action = verdict(matches);
      severity = strongest.severity;
      confidence = 0.97;
      reason = `Matched ${matches.length} blocked dictionary entr${matches.length === 1 ? 'y' : 'ies'}`;
    }

    const latencyMs = nowMs() - started;
    const result = normalizeResult({
      allowed: action !== 'block',
      action,
      severity,
      confidence,
      categories,
      reason
    }, this.name, latencyMs);
    this.mark('healthy', latencyMs);
    return result;
  }

  health() {
    return { ...super.health(), termCount: BAD_WORD_COUNT, type: 'deterministic-dictionary' };
  }
}
