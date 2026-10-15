// Presence is ephemeral. Messages and call signaling never enter this batch.
export function createPresenceBatch({ audienceFor, isConnected, send, delayMs = 250 }) {
  const pending = new Map();
  let timer = null;
  function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!pending.size) return;
    const changes = [...pending];
    pending.clear();
    const memberCache = new Map();
    const recipients = new Map();
    for (const [userId, payload] of changes) {
      for (const recipient of audienceFor(userId, memberCache)) {
        const id = Number(recipient);
        if (id === Number(userId) || !isConnected(id)) continue;
        let users = recipients.get(id);
        if (!users) { users = new Map(); recipients.set(id, users); }
        users.set(Number(userId), payload);
      }
    }
    for (const [id, users] of recipients) {
      const values = [...users.values()];
      if (values.length === 1) send(id, 'presence', values[0]);
      else send(id, 'presence-sync', { users: values });
    }
  }
  return {
    enqueue(userId, payload) {
      pending.set(Number(userId), payload);
      if (timer === null) { timer = setTimeout(flush, delayMs); timer.unref?.(); }
    },
    flush,
    close() { if (timer !== null) clearTimeout(timer); timer = null; pending.clear(); },
  };
}
