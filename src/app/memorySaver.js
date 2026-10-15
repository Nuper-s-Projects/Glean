export const MEMORY_SAVER_KEY = 'glean.memory-saver.v1';
const listeners = new Set();

export function memorySaverEnabled() {
  try { return window.localStorage.getItem(MEMORY_SAVER_KEY) === 'true'; }
  catch { return false; }
}

function changed() {
  for (const listener of listeners) listener();
}

const storageChanged = event => {
  if (event.key === MEMORY_SAVER_KEY || event.key === null) changed();
};

export function subscribeMemorySaver(listener) {
  if (!listeners.size && typeof window !== 'undefined') window.addEventListener('storage', storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', storageChanged);
  };
}

export function saveMemorySaver(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Expected an enabled or disabled preference.');
  try { window.localStorage.setItem(MEMORY_SAVER_KEY, String(enabled)); }
  catch { throw new Error('Could not save Memory saver. Allow browser storage and try again.'); }
  changed();
}

export function memorySaverLimits(maxEntries, maxBytes) {
  return memorySaverEnabled()
    ? { maxEntries: Math.max(1, Math.floor(maxEntries / 4)), maxBytes: maxBytes / 4 }
    : { maxEntries, maxBytes };
}
