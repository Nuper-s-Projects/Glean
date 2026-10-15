import assert from 'node:assert/strict';
import { trimInactiveTranscripts } from '../src/features/dm/conversationState.js';

const saved = Object.fromEntries(['document', 'window', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]));
const documentEvents = new EventTarget();
const windowEvents = new EventTarget();
let focused = true;
let now = 0;
let nextId = 0;
const frames = new Map();
const timers = new Map();
globalThis.document = documentEvents;
document.visibilityState = 'visible';
document.hasFocus = () => focused;
globalThis.window = windowEvents;
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = callback => { const id = ++nextId; frames.set(id, callback); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { callback, deadline: now + delay }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
function advance(ms) {
  const end = now + ms;
  while (now < end) {
    now += Math.min(1000 / 120, end - now);
    for (const [id, task] of [...timers]) if (task.deadline <= now) { timers.delete(id); task.callback(); }
    const ready = [...frames];
    frames.clear();
    for (const [, callback] of ready) callback(now);
  }
}
function visibility(hidden) {
  document.visibilityState = hidden ? 'hidden' : 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
}
try {
  const { startVisualLoop } = await import('../src/app/pageActivity.js');
  const { createMemoryCache } = await import('../src/app/memoryCache.js');
  const draws = [];
  const stop = startVisualLoop(time => draws.push(time));
  advance(1000);
  assert.ok(draws.length >= 119, 'foreground rendering retains native 120 Hz cadence');
  focused = false;
  window.dispatchEvent(new Event('blur'));
  const idleStart = draws.length;
  advance(1000);
  const idleFrames = draws.slice(idleStart);
  assert.ok(idleFrames.length > 0 && idleFrames.length <= 30, 'unfocused rendering caps at 30 FPS');
  assert.ok(idleFrames.every((time, index) => !index || time - idleFrames[index - 1] >= 1000 / 30), 'idle frames never burst above the budget');
  visibility(true);
  const hiddenStart = draws.length;
  advance(5000);
  assert.equal(draws.length, hiddenStart, 'hidden tabs do not draw');
  assert.equal(frames.size + timers.size, 0, 'hidden loops leave no scheduled visual work');
  visibility(false);
  focused = true;
  window.dispatchEvent(new Event('focus'));
  advance(1000);
  assert.ok(draws.length - hiddenStart >= 119, 'foreground frame rate restores without catching up missed frames');
  stop(); stop();
  assert.equal(frames.size + timers.size, 0, 'repeated teardown cancels all scheduled work');
  const oneFrame = startVisualLoop(() => false);
  advance(100);
  assert.equal(frames.size + timers.size, 0, 'loops can terminate themselves');
  oneFrame();
  const cache = createMemoryCache({ maxEntries: 2, maxBytes: 16, sizeOf: (_, value) => value.length * 2 });
  cache.set('a', 'aa'); cache.set('b', 'bb'); cache.get('a'); cache.set('c', 'cc');
  assert.equal(cache.has('b'), false, 'least recently used entries are evicted');
  cache.set('d', 'dddddd');
  assert.ok(cache.bytes <= 16 && cache.size <= 2, 'cache respects both entry and byte budgets');
  cache.set('large', 'x'.repeat(100));
  assert.equal(cache.has('large'), false, 'oversized values are not retained');
  visibility(true);
  assert.equal(cache.size, 0, 'hidden tabs release recomputable caches');
  cache.set('late-response', 'aa');
  assert.equal(cache.size, 0, 'late requests cannot refill hidden caches');
  visibility(false);
  cache.set('resumed', 'aa');
  assert.equal(cache.get('resumed'), 'aa', 'caching resumes normally');
  cache.dispose();
  const active = { messages: [{ id: 1 }] };
  const sending = { messages: [{ id: 'pending', status: 'sending' }] };
  const failed = { messages: [{ id: 'failed', status: 'failed' }] };
  const transcripts = new Map([[1, active], [2, { messages: [{ id: 2, status: 'sent' }] }], [3, sending], [4, failed]]);
  trimInactiveTranscripts(transcripts, '1');
  assert.deepEqual([...transcripts.keys()], [1, 3, 4], 'inactive history releases without losing the active transcript or unsent messages');
  assert.equal(transcripts.get(1), active);
  console.log(`Background performance smoke passed: foreground 120 Hz, idle ${idleFrames.length} FPS, hidden zero frames; bounded caches and pending sends preserved.`);
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
