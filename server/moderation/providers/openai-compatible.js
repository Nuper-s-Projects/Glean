import { ModerationProvider } from './base.js';
import { ProviderError } from '../lib/errors.js';
import { moderationJsonSchema, normalizeResult } from '../lib/schema.js';
import { MODERATION_SYSTEM_PROMPT, moderationUserMessage } from '../lib/prompt.js';
import { nowMs, sleep } from '../lib/utils.js';

export class OpenAICompatibleProvider extends ModerationProvider {
  constructor(opts) {
    super(opts.name);
    Object.assign(this, opts);
  }

  isConfigured() {
    return Boolean(this.apiKey && this.model && this.url);
  }

  async moderate(text, context = {}) {
    if (!this.isConfigured()) throw new ProviderError(`${this.name} is not configured`, { code: 'not_configured' });
    const started = nowMs();
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const result = await this.#request(text, context);
        const latencyMs = nowMs() - started;
        const normalized = normalizeResult(result, this.name, latencyMs);
        this.mark('healthy', latencyMs);
        return normalized;
      } catch (error) {
        lastError = error instanceof ProviderError ? error : new ProviderError(error.message, { code: 'invalid_response' });
        if (!lastError.transient || attempt >= this.retries) break;
        await sleep(this.retryBaseMs * (2 ** attempt));
      }
    }
    const latencyMs = nowMs() - started;
    this.mark('unhealthy', latencyMs, lastError.code || 'provider_error');
    throw lastError;
  }

  async #request(text, context) {
    const sim = context.simulate;
    if (sim === `${this.name}-timeout`) throw new ProviderError(`${this.name} timed out`, { transient: true, code: 'timeout' });
    if (sim === `${this.name}-failure`) throw new ProviderError('simulated failure', { status: 503, transient: true, code: 'simulated_failure' });
    if (sim === `${this.name}-invalid`) return { nope: true };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: MODERATION_SYSTEM_PROMPT },
        { role: 'user', content: moderationUserMessage(text, context.conversation) }
      ],
      temperature: 0,
      max_completion_tokens: this.maxCompletionTokens || 768
    };
    if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;
    if (this.responseFormat === 'json_schema') body.response_format = { type: 'json_schema', json_schema: moderationJsonSchema };
    else if (this.responseFormat === 'json_object') body.response_format = { type: 'json_object' };

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const raw = await res.text();
      if (!res.ok) {
        const transient = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
        throw new ProviderError(`${this.name} HTTP ${res.status}`, { status: res.status, transient, code: `http_${res.status}` });
      }
      let envelope;
      try { envelope = JSON.parse(raw); }
      catch { throw new ProviderError('provider returned non-JSON envelope', { code: 'invalid_envelope' }); }
      const content = envelope?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new ProviderError('provider returned empty content', { code: 'empty_content' });
      try { return JSON.parse(content); }
      catch { throw new ProviderError('provider returned malformed moderation JSON', { code: 'malformed_json' }); }
    } catch (error) {
      if (error?.name === 'AbortError') throw new ProviderError(`${this.name} timed out`, { transient: true, code: 'timeout' });
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`${this.name} network error`, { transient: true, code: 'network_error' });
    } finally {
      clearTimeout(timer);
    }
  }
}
