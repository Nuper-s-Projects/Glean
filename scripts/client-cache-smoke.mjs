import { strict as assert } from 'node:assert';

const saved = { window: globalThis.window, sessionStorage: globalThis.sessionStorage };
const values = new Map();
const events = new Map();
let reads = 0;
let writes = 0;
globalThis.window = { addEventListener: (name, handler) => events.set(name, handler) };
globalThis.sessionStorage = {
  getItem: (key) => { reads += 1; return values.get(key) ?? null; },
  setItem: (key, value) => { writes += 1; values.set(key, value); },
  removeItem: (key) => values.delete(key),
};
const { queueSessionSnapshot, flushSessionSnapshots, removeSessionSnapshot } = await import('../src/app/sessionSnapshots.js');
const { peekCachedDmSidebar, rememberDmSidebar, clearClientCaches } = await import('../src/app/storage.js');
try {
  values.set('glean.dmSidebar', JSON.stringify({ accountId: 1, friends: [], conversations: [] }));
  const first = peekCachedDmSidebar(1);
  for (let i = 0; i < 1000; i += 1) assert.equal(peekCachedDmSidebar(1), first);
  assert.equal(reads, 1, 'render-time sidebar reads do not repeatedly parse session storage');
  assert.equal(peekCachedDmSidebar(2), null, 'cached sidebar is account scoped');
  for (let i = 0; i < 1000; i += 1) rememberDmSidebar(1, { friends: [], conversations: [{ id: i }] });
  assert.equal(writes, 0, 'rapid realtime updates do not synchronously serialize snapshots');
  assert.equal(peekCachedDmSidebar(1).conversations[0].id, 999, 'memory is immediately up to date');
  flushSessionSnapshots();
  assert.equal(writes, 1, 'a burst persists only the latest snapshot');
  assert.equal(JSON.parse(values.get('glean.dmSidebar')).conversations[0].id, 999);
  queueSessionSnapshot('removed', { value: 1 });
  removeSessionSnapshot('removed');
  flushSessionSnapshots();
  assert.equal(values.has('removed'), false, 'removed snapshots cannot reappear after a delayed write');
  queueSessionSnapshot('navigation', { value: 2 });
  events.get('pagehide')();
  assert.equal(JSON.parse(values.get('navigation')).value, 2, 'navigation flushes pending snapshots');
  rememberDmSidebar(1, { friends: [], conversations: [{ id: 5 }] });
  queueSessionSnapshot('glean.servers', { servers: [{ id: 1 }] });
  clearClientCaches();
  flushSessionSnapshots();
  assert.equal(peekCachedDmSidebar(1), null);
  assert.equal(values.has('glean.dmSidebar'), false);
  assert.equal(values.has('glean.servers'), false);
  console.log('Client cache smoke test passed: 1000 updates coalesced into one write; account isolation and logout verified.');
} finally {
  flushSessionSnapshots();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
}
