import assert from 'node:assert/strict';
const storage = new Map();
let blocked = false, observer;
globalThis.window = new EventTarget();
globalThis.BroadcastChannel = undefined;
window.localStorage = {
  getItem: key => { if (blocked) throw Error('blocked'); return storage.get(key) ?? null; },
  setItem: (key, value) => { if (blocked) throw Error('blocked'); storage.set(key, value); },
};
globalThis.document = new EventTarget();
document.visibilityState = 'visible'; document.hasFocus = () => true;
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; observer = this; }
  observe() {}
  disconnect() { this.disconnected = true; }
  intersect(near) { this.callback([{ isIntersecting: near }]); }
};
const { memorySaverEnabled, saveMemorySaver, subscribeMemorySaver, MEMORY_SAVER_KEY } = await import('../src/app/memorySaver.js');
const { createMemoryCache } = await import('../src/app/memoryCache.js');
const { createLoopCache } = await import('../src/app/loopCache.js');
const { manageMediaMemory } = await import('../src/app/mediaMemory.js');
assert.equal(memorySaverEnabled(), false);
const cache = createMemoryCache({ maxEntries: 8, maxBytes: 80, sizeOf: () => 10 });
for (let i = 0; i < 8; i++) cache.set(i, i);
cache.get(0);
const loop = createLoopCache({ maxEntries: 8, maxBytes: 1000 }); loop.setAccount(1);
const unsubscribe = subscribeMemorySaver(loop.trim);
for (let i = 0; i < 8; i++) await loop.read(String(i), () => ({ value: i }));
assert.equal(cache.size, 8); assert.equal(loop.size, 8);
saveMemorySaver(true);
assert.equal(cache.size, 2); assert.equal(cache.bytes, 20); assert.ok(cache.has(0), 'recent cache entries survive trimming');
assert.equal(loop.size, 2); assert.ok(loop.bytes <= 250);
await loop.read('/large', () => ({ value: 'x'.repeat(200) }));
assert.equal(loop.peek('/large'), null, 'reduced byte limit rejects oversized metadata');
assert.equal((await import('../src/app/memorySaver.js?reload')).memorySaverEnabled(), true, 'reload restores preference');
const media = new EventTarget(), attributes = new Map([['src', 'movie.mp4']]);
media.paused = true; media.currentTime = 12; media.duration = 30; media.loads = 0;
media.setAttribute = (key, value) => attributes.set(key, value);
media.removeAttribute = key => attributes.delete(key);
media.hasAttribute = key => attributes.has(key);
media.load = () => { media.loads++; media.currentTime = 0; };
const manager = manageMediaMemory(media, 'movie.mp4'); manager.setEnabled(true);
observer.intersect(false);
assert.equal(attributes.has('src'), false); assert.equal(media.loads, 1, 'offscreen paused buffer reset');
observer.intersect(false); assert.equal(media.loads, 1, 'no repeated load loops');
observer.intersect(true); assert.equal(attributes.get('src'), 'movie.mp4');
media.dispatchEvent(new Event('loadedmetadata')); assert.equal(media.currentTime, 12, 'position restored');
media.paused = false; observer.intersect(false); assert.equal(attributes.get('src'), 'movie.mp4', 'playing audio/video untouched');
media.paused = true; media.srcObject = {}; media.dispatchEvent(new Event('pause'));
assert.equal(attributes.get('src'), 'movie.mp4', 'live streams untouched');
media.srcObject = null; media.currentTime = 8; media.dispatchEvent(new Event('pause'));
assert.equal(attributes.has('src'), false, 'pausing offscreen releases buffer');
manager.setEnabled(false); assert.equal(attributes.get('src'), 'movie.mp4', 'disabling restores media');
media.dispatchEvent(new Event('loadedmetadata')); assert.equal(media.currentTime, 8);
manager.dispose(); assert.equal(observer.disconnected, true);
saveMemorySaver(false); for (let i = 0; i < 8; i++) cache.set(i, i);
assert.equal(cache.size, 8, 'normal budget restores without reload');
let changes = 0; const stop = subscribeMemorySaver(() => changes++);
storage.set(MEMORY_SAVER_KEY, 'true');
window.dispatchEvent(Object.assign(new Event('storage'), { key: MEMORY_SAVER_KEY }));
assert.equal(changes, 1); assert.equal(cache.size, 2, 'other tabs trim immediately');
blocked = true; assert.throws(() => saveMemorySaver(false), /Could not save/);
assert.equal(changes, 1, 'failed writes do not notify'); assert.equal(memorySaverEnabled(), false);
assert.throws(() => saveMemorySaver('true'), TypeError);
stop(); unsubscribe(); cache.dispose();
console.log('PASS Memory saver: persistence, immediate/cache byte bounds, cross-tab sync, storage errors, offscreen release/position recovery, playing media and live streams preserved.');
