import { apiRequest } from '../../app/apiClient';
import { loopCache } from '../../app/loopCache';

export function loopRequest(path, options = {}) {
  const { force, signal, ...rest } = options;
  // Only explicitly opted-in, read-only metadata endpoints are cached.
  if (rest.method || (typeof navigator !== 'undefined' && navigator.onLine === false)
    || !/^\/(loop\/(posts(?:\/\d+)?|profiles\/\d+|users|trending)|users\/[^/?]+)(\?|$)/.test(path)) {
    return apiRequest(path, { signal, ...rest });
  }
  return loopCache.read(path, sharedSignal => apiRequest(path, { ...rest, signal: sharedSignal }), { signal, force });
}
