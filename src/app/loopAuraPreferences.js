const SEEN_PREFIX = 'glean.loop.aura.seen';

export function loopAuraSeenKey(userId, date) {
  return `${SEEN_PREFIX}:${Number(userId) || 0}:${date}`;
}

export function clearLoopAuraReminderHistory(userId) {
  if (typeof window === 'undefined' || !userId) return;
  const prefix = `${SEEN_PREFIX}:${Number(userId)}:`;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) window.localStorage.removeItem(key);
    }
  } catch { /* Browser storage may be disabled. */ }
}
