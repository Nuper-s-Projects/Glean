const STORAGE_KEY = 'glean.developer-mode.enabled';
const encoder = new TextEncoder();
const listeners = new Set();
const traffic = {
  http: { requests: 0, uploaded: 0, downloaded: 0 },
  websocket: { sent: 0, received: 0, uploaded: 0, downloaded: 0 },
};

function readEnabled() {
  try { return window.localStorage.getItem(STORAGE_KEY) === 'true'; } catch { return false; }
}

let enabled = readEnabled();

export function isDeveloperModeEnabled() { return enabled; }

export function setDeveloperModeEnabled(value) {
  enabled = Boolean(value);
  try { window.localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* Storage may be unavailable. */ }
  for (const listener of listeners) listener(enabled);
  return enabled;
}

export function subscribeDeveloperMode(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordDeveloperTraffic(kind, { uploaded = 0, downloaded = 0 } = {}) {
  if (!enabled) return;
  const bytesUp = Math.max(0, Number(uploaded) || 0);
  const bytesDown = Math.max(0, Number(downloaded) || 0);
  if (kind === 'http') {
    traffic.http.requests += 1;
    traffic.http.uploaded += bytesUp;
    traffic.http.downloaded += bytesDown;
  } else if (kind === 'websocket') {
    traffic.websocket.sent += bytesUp > 0 ? 1 : 0;
    traffic.websocket.received += bytesDown > 0 ? 1 : 0;
    traffic.websocket.uploaded += bytesUp;
    traffic.websocket.downloaded += bytesDown;
  }
}

export function getDeveloperTraffic() {
  return { http: { ...traffic.http }, websocket: { ...traffic.websocket } };
}

export function estimateBodyBytes(body) {
  if (body == null) return 0;
  if (typeof body === 'string') return encoder.encode(body).byteLength;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return encoder.encode(body.toString()).byteLength;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    let size = 0;
    for (const [, value] of body.entries()) size += typeof value === 'string' ? encoder.encode(value).byteLength : value.size;
    return size;
  }
  return 0;
}

function getObservedThirdParties() {
  if (typeof performance === 'undefined' || typeof location === 'undefined') return [];
  const origins = new Map();
  for (const entry of performance.getEntriesByType('resource')) {
    let url;
    try { url = new URL(entry.name, location.href); } catch { continue; }
    if (url.origin === location.origin || url.protocol === 'data:' || url.protocol === 'blob:') continue;
    const record = origins.get(url.origin) || { origin: url.origin, count: 0, bytes: 0, types: new Set() };
    record.count += 1;
    record.bytes += Math.max(0, Number(entry.transferSize) || 0);
    if (entry.initiatorType) record.types.add(entry.initiatorType);
    origins.set(url.origin, record);
  }
  return [...origins.values()]
    .map(({ types, ...record }) => ({ ...record, types: [...types].slice(0, 4) }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 20);
}

export function getBrowserDiagnostics() {
  const memory = typeof performance !== 'undefined' ? performance.memory : null;
  const navigation = typeof performance !== 'undefined' ? performance.getEntriesByType('navigation')[0] : null;
  const connection = typeof navigator !== 'undefined' ? navigator.connection : null;
  return {
    route: typeof location === 'undefined' ? '' : location.pathname,
    memory: memory ? { used: memory.usedJSHeapSize, limit: memory.jsHeapSizeLimit } : null,
    pageLoadMs: navigation?.loadEventEnd > 0 ? Math.round(navigation.loadEventEnd) : null,
    connection: connection ? {
      type: connection.effectiveType || 'unknown',
      downlink: Number.isFinite(connection.downlink) ? connection.downlink : null,
      rtt: Number.isFinite(connection.rtt) ? connection.rtt : null,
      saveData: Boolean(connection.saveData),
    } : null,
    thirdParties: getObservedThirdParties(),
    traffic: getDeveloperTraffic(),
  };
}
