const pending = new Map();
let timer = null;
let bound = false;

export function flushSessionSnapshots() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  for (const [key, value] of pending) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* in-memory caches remain available */ }
  }
  pending.clear();
}

export function queueSessionSnapshot(key, value) {
  pending.set(key, value);
  if (typeof window === 'undefined') { flushSessionSnapshots(); return; }
  if (!bound) {
    bound = true;
    window.addEventListener('pagehide', flushSessionSnapshots);
  }
  if (timer === null) timer = setTimeout(flushSessionSnapshots, 150);
}

export function removeSessionSnapshot(key) {
  pending.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* storage can be unavailable */ }
}
