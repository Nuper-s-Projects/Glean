import { memorySaverLimits, subscribeMemorySaver } from './memorySaver.js';
// Session-only metadata. Never store messages, credentials, or upload blobs here.
export function createLoopCache({ ttl = 10_000, maxEntries = 80, maxBytes = 8 * 1024 * 1024, now = Date.now } = {}) {
  const entries = new Map();
  const pending = new Map();
  let account = null, session = 0, bytes = 0;
  const trim = () => {
    const limits = memorySaverLimits(maxEntries, maxBytes);
    while (entries.size > limits.maxEntries || bytes > limits.maxBytes) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest).bytes; entries.delete(oldest);
    }
  };
  const invalidate = (matches = () => true) => {
    for (const [key, entry] of entries) if (matches(key)) { bytes -= entry.bytes; entries.delete(key); }
    // Old responses cannot repopulate the cache or win over a newer request.
    for (const key of pending.keys()) if (matches(key)) pending.delete(key);
  };
  const setAccount = id => {
    const next = id == null ? null : String(id);
    if (next !== account) { session++; account = next; invalidate(); }
  };
  const peek = key => {
    const entry = entries.get(key);
    if (!account || !entry) return null;
    if (now() - entry.time >= ttl) { bytes -= entry.bytes; entries.delete(key); return null; }
    entries.delete(key); entries.set(key, entry);
    return entry.value;
  };
  const read = async (key, fetcher, { signal, force = false, attempt = 0 } = {}) => {
    signal?.throwIfAborted();
    if (!account) return fetcher(signal);
    const cached = !force && peek(key);
    if (cached) return cached;
    const requestedAccount = account;
    let task = pending.get(key);
    if (!task) {
      const version = session;
      task = Promise.resolve().then(() => fetcher()).then(value => {
        if (account !== requestedAccount || session !== version) throw new DOMException('Account changed.', 'AbortError');
        if (pending.get(key) !== task) {
          if (attempt >= 2) throw new Error('Loop updated while loading. Please try again.');
          return read(key, fetcher, { attempt: attempt + 1 });
        }
        const size = JSON.stringify(value).length * 2;
        if (size <= memorySaverLimits(maxEntries, maxBytes).maxBytes) {
          const old = entries.get(key); if (old) bytes -= old.bytes;
          entries.delete(key); entries.set(key, { value, bytes: size, time: now() }); bytes += size;
          trim();
        }
        return value;
      }).finally(() => { if (pending.get(key) === task) pending.delete(key); });
      pending.set(key, task);
    }
    // Aborting one reader must not cancel another reader's shared request.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason || new DOMException('Aborted.', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      task.then(value => { if (!signal?.aborted) resolve(value); }, reject)
        .finally(() => signal?.removeEventListener('abort', abort));
    });
  };
  return { read, peek, invalidate, setAccount, trim, get size() { return entries.size; }, get bytes() { return bytes; } };
}

export const loopCache = createLoopCache();
const unsubscribeSaver = subscribeMemorySaver(loopCache.trim);

// Other tabs can change the same cookie/session and the same posts.
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('glean-loop-metadata') : null;
if (channel) channel.onmessage = event => {
  if (event.data === 'account') loopCache.setAccount(null);
  else if (event.data === 'invalidate') loopCache.invalidate();
};
const resumed = () => { if (document.visibilityState === 'visible') loopCache.invalidate(); };
if (typeof window !== 'undefined') {
  window.addEventListener('online', resumed);
  document.addEventListener('visibilitychange', resumed);
}
if (import.meta.hot) import.meta.hot.dispose(() => {
  unsubscribeSaver();
  channel?.close(); window.removeEventListener('online', resumed); document.removeEventListener('visibilitychange', resumed);
});

export function invalidateLoopMutation(path) {
  if (/^\/auth\/(signin|signup|signout)/.test(path)) { loopCache.setAccount(null); channel?.postMessage('account'); return; }
  if (/^\/loop\/(posts|comments|users|profiles|connection)(\/|$)/.test(path)
    || path === '/auth/username' || /^\/(account|users|friends|blocks)(\/|$)/.test(path)) { loopCache.invalidate(); channel?.postMessage('invalidate'); }
}

export function invalidateLoopEvent(event, payload) {
  if (['connected', 'friends', 'account-privacy-settings', 'user-updated', 'user-verification-updated', 'account-updated'].includes(event)) loopCache.invalidate();
  else if (/^loop-(post-|comment-|follow-)/.test(event)) {
    const id = Number(payload?.postId);
    loopCache.invalidate(key => key.startsWith('/loop/posts?') || key === '/loop/posts'
      || (id && key === `/loop/posts/${id}`) || key.startsWith('/loop/trending')
      || (event === 'loop-follow-updated' && key.startsWith('/loop/profiles')));
  }
}
