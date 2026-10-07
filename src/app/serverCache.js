const SERVERS_KEY = 'glean.servers';
const SERVERS_TTL_MS = 12_000;
let serversCached = null;
let serversCachedAt = 0;
let serversInFlight = null;
let serversEpoch = 0;

export function rememberServers(payload) {
  serversCached = payload;
  serversCachedAt = Date.now();
  try { sessionStorage.setItem(SERVERS_KEY, JSON.stringify(payload)); } catch { /* ignore */ }
}

export function peekCachedServers() {
  if (serversCached) return serversCached;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SERVERS_KEY) || '');
    if (!parsed || !Array.isArray(parsed.servers)) return null;
    serversCached = parsed;
    serversCachedAt = 0;
    return parsed;
  } catch {
    return null;
  }
}

export function getFreshCachedServers() {
  return serversCached && Date.now() - serversCachedAt < SERVERS_TTL_MS ? serversCached : null;
}

export function getServersRequest() { return serversInFlight; }
export function getServersCacheEpoch() { return serversEpoch; }
export function setServersRequest(request) { serversInFlight = request; }
export function clearServersRequest(request) {
  if (serversInFlight === request) serversInFlight = null;
}

export function patchServerUnreadSummary(servers, payload) {
  const serverId = Number(payload?.serverId);
  if (!Array.isArray(servers) || !Number.isInteger(serverId) || serverId <= 0) return servers;
  const hasUnreadState = payload.serverUnread != null
    || payload.serverUnreadCount != null
    || payload.serverMentionCount != null;
  if (!hasUnreadState) return servers;
  let changed = false;
  const next = servers.map((server) => {
    if (Number(server.id) !== serverId) return server;
    changed = true;
    return {
      ...server,
      ...(payload.serverUnread != null ? { unread: Boolean(payload.serverUnread) } : {}),
      ...(payload.serverUnreadCount != null ? { unreadCount: Number(payload.serverUnreadCount) || 0 } : {}),
      ...(payload.serverMentionCount != null ? { mentionCount: Number(payload.serverMentionCount) || 0 } : {}),
    };
  });
  return changed ? next : servers;
}

export function patchCachedServerUnreadSummary(payload) {
  const cached = peekCachedServers();
  if (!cached?.servers?.length) return false;
  const servers = patchServerUnreadSummary(cached.servers, payload);
  if (servers === cached.servers) return false;
  // Prevent an older in-flight server-list response from overwriting this event.
  serversEpoch += 1;
  rememberServers({ ...cached, servers });
  return true;
}

export function invalidateServersCache() {
  serversEpoch += 1;
  serversCached = null;
  serversCachedAt = 0;
  serversInFlight = null;
  try { sessionStorage.removeItem(SERVERS_KEY); } catch { /* ignore */ }
}
