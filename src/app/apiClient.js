import { estimateBodyBytes, isDeveloperModeEnabled, recordDeveloperTraffic } from './developerMode.js';
import { reportNetworkActivity } from './pwa.js';

export const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  constructor(message, { status = null, requestId = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
  }
}

async function readPayload(response) {
  const body = await response.text();
  const downloaded = isDeveloperModeEnabled() ? new TextEncoder().encode(body).byteLength : 0;
  if (!body) return { payload: {}, downloaded };
  try {
    return { payload: JSON.parse(body), downloaded };
  } catch {
    return { payload: {}, downloaded };
  }
}

function isRetryable(error, method) {
  return method === 'GET' && (!error.status || error.status >= 500);
}

export async function apiRequest(path, options = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('API paths must be relative to the Glean API.');
  }

  const { timeoutMs, retries, signal, ...fetchOptions } = options;
  const isFormData = typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const maxRetries = retries ?? (method === 'GET' ? 1 : 0);
  const timeout = timeoutMs ?? (isFormData ? 175_000 : 30_000);

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);

    try {
      const uploadBytes = isDeveloperModeEnabled() ? estimateBodyBytes(fetchOptions.body) : 0;
      const response = await fetch(`${API_PREFIX}${path}`, {
        credentials: 'same-origin',
        ...fetchOptions,
        cache: method === 'GET' ? 'no-store' : fetchOptions.cache,
        headers: {
          ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
          ...fetchOptions.headers,
        },
        signal: controller.signal,
      });
      reportNetworkActivity(true);
      const { payload, downloaded } = await readPayload(response);
      recordDeveloperTraffic('http', { uploaded: uploadBytes, downloaded });
      if (!response.ok) {
        throw new ApiError(payload.error || `Request failed (${response.status}).`, {
          status: response.status,
          requestId: payload.requestId || response.headers.get('x-request-id'),
        });
      }
      return payload;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (timedOut || error instanceof TypeError) reportNetworkActivity(false);
      if (timedOut) {
        throw new ApiError('The request timed out. Check your connection and try again.', { cause: error });
      }
      if (attempt < maxRetries && isRetryable(error, method)) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError('Could not reach Glean. Check your connection and try again.', { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}
