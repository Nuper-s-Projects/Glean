import { ProviderError } from '../lib/errors.js';

export class ModerationProvider {
  constructor(name) {
    if (new.target === ModerationProvider) throw new TypeError('ModerationProvider is abstract');
    this.name = name;
    this.last = { status: 'unknown', at: null, latencyMs: null, error: null };
  }

  isConfigured() { return true; }
  async moderate() { throw new Error('Not implemented'); }

  mark(status, latencyMs = null, error = null) {
    this.last = { status, at: new Date().toISOString(), latencyMs, error };
  }

  health() {
    return { name: this.name, configured: this.isConfigured(), ...this.last };
  }

  simulate(mode) {
    if (!mode) return;
    if (mode === `${this.name}-failure`) throw new ProviderError('simulated failure', { status: 503, transient: true, code: 'simulated_failure' });
  }
}
