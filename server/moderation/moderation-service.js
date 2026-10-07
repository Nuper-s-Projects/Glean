import { ProviderError } from './lib/errors.js';
import { safeLog } from './lib/utils.js';
import { groomingSignals, normalizedPolicySignals, scan, verdict } from './data/bad-words.js';
import { normalizeResult } from './lib/schema.js';

const severityRank = Object.freeze({ none: 0, low: 1, medium: 2, high: 3, critical: 4 });

export class ModerationService {
  constructor({ primary, backup, local }) {
    this.primary = primary;
    this.backup = backup;
    this.local = local;
    this.lastDecision = null;
  }

  async moderate(text, { requestId, simulate = null, conversation = [] } = {}) {
    const failures = [];

    // ── fast path ──────────────────────────────────────────────────────────
    // #applyDeterministicPolicy can only ever RAISE the action, never lower it.
    // So when the deterministic layer already resolves to `block`, the model's
    // verdict is discarded by that merge and the round trip is pure latency:
    // ~380ms spent to produce an answer that is then thrown away.
    //
    // Solving it locally returns the SAME action in single-digit milliseconds.
    // Only `block` short-circuits — a local `flag` still consults the model,
    // because the model may escalate it to `block`, and that is information we
    // would be discarding to save time on a message that is not being stopped
    // anyway.
    if (!simulate) {
      const fast = this.#fastPath(text, conversation);
      if (fast) {
        this.lastDecision = { provider: 'local-rules', fallbackUsed: false, at: new Date().toISOString() };
        const response = { ...fast, fallbackUsed: false, fastPath: true, failures };
        return response;
      }
    }

    const providers = [this.primary, this.backup];

    for (const provider of providers) {
      if (!provider?.isConfigured()) {
        failures.push({ provider: provider?.name || 'unknown', code: 'not_configured' });
        continue;
      }
      try {
        const providerSim = this.#simulationFor(provider, simulate);
        const result = await provider.moderate(text, { simulate: providerSim, conversation });
        const policyResult = this.#applyDeterministicPolicy(result, text, conversation);
        this.lastDecision = {
          provider: policyResult.provider,
          fallbackUsed: provider !== this.primary,
          at: new Date().toISOString()
        };
        if (provider !== this.primary) safeLog('warn', 'failover succeeded', { requestId, provider: provider.name });
        const response = { ...policyResult, fallbackUsed: provider !== this.primary, failures };
        return response;
      } catch (error) {
        const e = error instanceof ProviderError ? error : new ProviderError(error.message);
        failures.push({ provider: provider.name, code: e.code, status: e.status || undefined });
        safeLog('warn', 'provider failed', { requestId, provider: provider.name, code: e.code, status: e.status || undefined });
      }
    }

    const result = await this.local.moderate(text, { simulate, conversation });
    this.lastDecision = { provider: result.provider, fallbackUsed: true, at: new Date().toISOString() };
    safeLog('warn', 'local fail-safe activated', { requestId, failures: failures.map((f) => `${f.provider}:${f.code}`) });
    const response = { ...result, fallbackUsed: true, failures };
    return response;
  }

  /**
   * Decide locally when the model's opinion provably cannot change the outcome.
   *
   * Returns null whenever the answer is not already settled, so this can only
   * ever skip work that would have been discarded.
   */
  #fastPath(text, conversation) {
    const started = performance.now();
    const policySignals = normalizedPolicySignals(text);

    // A contextReview signal forces `flag` in the merge below, overriding even
    // a local `block`. Rare, but it means `block` is not provably final here.
    if (policySignals.some((signal) => signal.contextReview)) return null;

    const hits = [...scan(text), ...policySignals];
    if (verdict(hits) !== 'block') return null;

    const severity = hits.reduce(
      (strongest, hit) => (severityRank[hit.severity] > severityRank[strongest] ? hit.severity : strongest),
      'none'
    );
    const categories = [...new Set(hits.map((hit) => hit.category))];
    if (categories.length === 0) return null;

    return normalizeResult(
      {
        allowed: false,
        action: 'block',
        severity,
        confidence: 0.99,
        categories,
        reason: 'Deterministic moderation rule matched.'
      },
      'local-rules',
      performance.now() - started
    );
  }

  #applyDeterministicPolicy(result, text, conversation) {
    const hits = scan(text);
    const grooming = groomingSignals(text, conversation);
    const policySignals = normalizedPolicySignals(text);
    const allSignals = [...hits, ...policySignals];
    const categories = [...new Set([...result.categories, ...allSignals.map((hit) => hit.category), ...grooming])];
    const localAction = verdict(allSignals);
    const groomingFlag = grooming.length > 0 || policySignals.some((signal) => signal.contextReview);
    const contextReview = policySignals.some((signal) => signal.contextReview);
    const action = contextReview
      ? 'flag'
      : localAction === 'block'
      ? 'block'
      : localAction === 'flag' || groomingFlag
        ? 'flag'
        : result.action;
    const severity = allSignals.reduce((strongest, hit) => severityRank[hit.severity] > severityRank[strongest] ? hit.severity : strongest, result.severity);
    const finalSeverity = groomingFlag && severityRank[severity] < severityRank.critical ? 'critical' : severity;
    if (action === result.action && categories.length === result.categories.length && finalSeverity === result.severity) return result;
    const reason = contextReview
      ? 'Context-sensitive phrase requires human review.'
      : groomingFlag
      ? 'Potential grooming pattern requires human review.'
      : action === 'flag'
        ? 'Potential harassment or borderline content requires human review.'
        : 'Deterministic moderation rule matched.';
    return {
      ...result,
      allowed: action !== 'block',
      action,
      severity: finalSeverity,
      confidence: action === 'flag' ? 0.97 : result.confidence,
      categories,
      reason
    };
  }

  health() {
    return {
      route: [this.primary.name, this.backup.name, this.local.name],
      providers: [this.primary.health(), this.backup.health(), this.local.health()],
      lastDecision: this.lastDecision
    };
  }

  #simulationFor(provider, scenario) {
    if (!scenario) return null;
    if (scenario === 'groq-failure' && provider === this.primary) return `${provider.name}-failure`;
    if (scenario === 'groq-timeout' && provider === this.primary) return `${provider.name}-timeout`;
    if (scenario === 'groq-invalid' && provider === this.primary) return `${provider.name}-invalid`;
    if (scenario === 'word-filter-failure') {
      if (provider === this.primary) return `${provider.name}-failure`;
      if (provider === this.backup) return 'word-filter-failure';
    }
    return null;
  }
}
