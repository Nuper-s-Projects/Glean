import { pageActivity, subscribePageActivity } from './pageActivity.js';
import { memorySaverLimits, subscribeMemorySaver } from './memorySaver.js';

// Recomputable values only. Never use this cache for credentials or user drafts.
export function createMemoryCache({ maxEntries = 128, maxBytes = Infinity, sizeOf = () => 1 } = {}) {
  const entries = new Map();
  let bytes = 0;
  const clear = () => { entries.clear(); bytes = 0; };
  const trim = () => {
    const limits = memorySaverLimits(maxEntries, maxBytes);
    while (entries.size > limits.maxEntries || bytes > limits.maxBytes) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest).size;
      entries.delete(oldest);
    }
  };
  const unsubscribeSaver = subscribeMemorySaver(trim);
  const unsubscribe = subscribePageActivity(activity => { if (activity === 'hidden') clear(); });
  return {
    get size() { return entries.size; },
    get bytes() { return bytes; },
    has: key => entries.has(key),
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      const size = sizeOf(key, value);
      if (entries.has(key)) { bytes -= entries.get(key).size; entries.delete(key); }
      if (pageActivity() === 'hidden' || size > memorySaverLimits(maxEntries, maxBytes).maxBytes) return;
      entries.set(key, { value, size });
      bytes += size;
      trim();
    },
    clear,
    dispose() { unsubscribe(); unsubscribeSaver(); clear(); },
  };
}
