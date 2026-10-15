export function createMessageFanoutQueue(deliver, { maxMessages = 128, maxBytes = 1024 * 1024, onError } = {}) {
  let pending = [], bytes = 0, handle = null;
  function flush() {
    if (handle) clearImmediate(handle);
    handle = null;
    const batch = pending;
    pending = []; bytes = 0;
    const servers = new Map();
    for (const item of batch) {
      const group = servers.get(item.serverId) || [];
      group.push(item); servers.set(item.serverId, group);
    }
    try { for (const [serverId, items] of servers) deliver(serverId, items); }
    catch (error) { if (onError) onError(error); else throw error; }
  }
  return {
    enqueue(serverId, item) {
      const size = item.prepared.prefix.length;
      if (pending.length && (pending.length >= maxMessages || bytes + size > maxBytes)) flush();
      pending.push({ ...item, serverId }); bytes += size;
      if (bytes >= maxBytes) flush();
      else if (!handle) handle = setImmediate(() => { try { flush(); } catch (error) { if (onError) onError(error); else throw error; } });
    },
    flush,
  };
}
