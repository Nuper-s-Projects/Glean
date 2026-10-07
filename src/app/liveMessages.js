export function createLiveMessageJournal(maxEntries = 512) {
  let revision = 0;
  const events = new Map();
  const clears = new Map();

  function clear(scope) {
    if (!scope) return revision;
    for (const [key, event] of events) if (event.scope === scope) events.delete(key);
    const next = ++revision;
    clears.set(scope, next);
    return next;
  }

  function record(scope, action, message, messageId = message?.id) {
    const id = Number(messageId);
    if (!scope || !Number.isSafeInteger(id) || id <= 0) return revision;
    const key = `${scope}:${id}`;
    events.delete(key);
    events.set(key, { scope, id, action, message, revision: ++revision });
    while (events.size > maxEntries) events.delete(events.keys().next().value);
    return revision;
  }

  function mergeSnapshot(scope, current, incoming, snapshotRevision, { isPending = () => false, retainCurrent = false } = {}) {
    const messages = new Map();
    const clearedAfterSnapshot = (clears.get(scope) || 0) > snapshotRevision;
    for (const message of clearedAfterSnapshot ? [] : incoming || []) {
      const id = Number(message?.id);
      if (Number.isSafeInteger(id) && id > 0) messages.set(id, message);
    }
    if (retainCurrent && !clearedAfterSnapshot) {
      for (const message of current || []) {
        const id = Number(message?.id);
        if (Number.isSafeInteger(id) && id > 0 && !messages.has(id)) messages.set(id, message);
      }
    }
    for (const event of events.values()) {
      if (event.scope !== scope || event.revision <= snapshotRevision) continue;
      if (event.action === 'deleted' || !event.message) messages.delete(event.id);
      else messages.set(event.id, event.message);
    }
    const pending = (current || []).filter(isPending);
    return [...messages.values()].sort((a, b) => Number(a.id) - Number(b.id)).concat(pending);
  }

  return {
    revision: () => revision,
    record,
    clear,
    mergeSnapshot,
  };
}
