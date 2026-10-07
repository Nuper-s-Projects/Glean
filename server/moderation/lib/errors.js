export class ProviderError extends Error {
  constructor(message, { status = 0, transient = false, code = 'provider_error' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.transient = transient;
    this.code = code;
  }
}
