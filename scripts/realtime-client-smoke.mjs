import assert from 'node:assert/strict';
import { createServer } from 'vite';

let timerId = 0;
const sockets = [];
const windowListeners = new Map();
const timeouts = new Map();
const intervals = new Map();
const realNow = Date.now;
const realBroadcastChannel = globalThis.BroadcastChannel;
// Browser metadata channels are outside this transport test. Node's native
// BroadcastChannel otherwise keeps the mock-browser test process alive.
globalThis.BroadcastChannel = class { postMessage() {} close() {} };
let now = realNow();
Date.now = () => now;

globalThis.window = {
  location: { protocol: 'http:', host: 'glean.local' },
  addEventListener(name, handler) { windowListeners.set(name, handler); },
  removeEventListener(name) { windowListeners.delete(name); },
  setInterval(callback, delay) { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
  clearInterval(id) { intervals.delete(id); },
  setTimeout(callback, delay) { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
  clearTimeout(id) { timeouts.delete(id); },
};
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    this.bufferedAmount = 0;
    sockets.push(this);
  }

  addEventListener(name, listener) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(listener);
    this.listeners.set(name, handlers);
  }

  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }

  send(value) { this.sent.push(value); }
  close(code) {
    if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) throw new Error('Invalid browser WebSocket close code');
    this.closeCode = code;
    this.readyState = FakeWebSocket.CLOSING;
  }
}
globalThis.WebSocket = FakeWebSocket;

const vite = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true, ws: false }, appType: 'custom' });
let connection;
let secondary;
try {
  const { subscribeToDmEvents } = await vite.ssrLoadModule('/src/app/dmApi.js');
  const received = [];
  connection = subscribeToDmEvents((event, payload, metadata) => received.push({ event, payload, ...(metadata ? { metadata } : {}) }), () => {}, 42);

  assert.equal(sockets.length, 1, 'realtime subscription must open a WebSocket');
  assert.equal(sockets[0].url, 'ws://glean.local/api/v1/realtime');
  connection.send('channel-typing', { channelId: 7, typing: true });
  connection.send('dm-call-invite', { conversationId: 6 });
  sockets[0].readyState = FakeWebSocket.OPEN;
  sockets[0].dispatch('open');
  assert.equal(timeouts.size, 0, 'opening the socket cancels its handshake deadline');
  assert.equal(sockets[0].sent.some(value => JSON.parse(value).event === 'channel-typing'), false, 'offline typing must not replay after reconnect');
  assert.equal(JSON.parse(sockets[0].sent.at(-1)).event, 'dm-call-invite', 'durable queued signaling still sends on connection');
  sockets[0].bufferedAmount = 65 * 1024;
  const congestedCount = sockets[0].sent.length;
  connection.send('typing', { conversationId: 8, typing: true });
  assert.equal(sockets[0].sent.length, congestedCount, 'ephemeral events drop rather than extend a congested socket backlog');
  sockets[0].bufferedAmount = 0;
  sockets[0].dispatch('message', {
    data: JSON.stringify({ event: 'channel-message', payload: { action: 'created', channelId: 7 } }),
  });
  assert.deepEqual(received.at(-1), { event: 'channel-message', payload: { action: 'created', channelId: 7 } });
  const secondaryEvents = [];
  sockets[0].dispatch('message', { data: JSON.stringify({ event: 'connected', payload: { userId: 42 } }) });
  assert.equal(received.at(-1).metadata,undefined,'live connection events are not marked as replayed');
  let replayMetadata;
  secondary = subscribeToDmEvents((event, payload, metadata) => { secondaryEvents.push(event); if(event === 'connected')replayMetadata=metadata; });
  await Promise.resolve();
  assert.deepEqual(replayMetadata,{replayed:true},'late subscribers can distinguish cached readiness from a genuine reconnect');
  assert.equal(sockets.length, 1, 'an unkeyed helper subscription must reuse the signed-in WebSocket');
  connection.send('dm-call-invite', { conversationId: 8 });
  assert.equal(JSON.parse(sockets[0].sent.at(-1)).event, 'dm-call-invite', 'call signaling must keep using the live socket');
  sockets[0].dispatch('message', { data: JSON.stringify({ event: 'dm-call-accepted', payload: { conversationId: 8 } }) });
  assert.equal(received.at(-1).event, 'dm-call-accepted');
  assert.equal(secondaryEvents.at(-1), 'dm-call-accepted');
  secondary.close();
  secondary = null;
  connection.send('dm-call-hangup', { conversationId: 8 });
  assert.equal(JSON.parse(sockets[0].sent.at(-1)).event, 'dm-call-hangup', 'closing a helper must not close the call socket');
  windowListeners.get('offline')();
  assert.equal(sockets[0].closeCode, 4001, 'network loss uses a browser-valid application close code');
  windowListeners.get('online')();
  assert.equal(sockets.length, 2, 'network restoration opens a fresh socket');
  sockets[1].readyState = FakeWebSocket.OPEN;
  sockets[1].dispatch('open');
  windowListeners.get('online')();
  assert.equal(sockets[1].closeCode, undefined, 'duplicate online events must preserve healthy sockets and calls');
  assert.equal(sockets.length, 2);
  now += 35_000;
  sockets[1].dispatch('message', { data: JSON.stringify({ event: 'message', payload: { conversationId: 8 } }) });
  now += 10_000;
  const watchdog = [...intervals.values()].find(task => task.delay === 5000);
  watchdog.callback();
  assert.equal(sockets[1].closeCode, undefined, 'ordinary traffic counts as proof of a live connection');
  now += 41_000;
  watchdog.callback();
  assert.equal(sockets[1].closeCode, 4000, 'stale sockets retire without waiting indefinitely for close');
  const retry = [...timeouts].find(([, task]) => task.delay < 1000);
  assert.ok(retry[1].delay >= 250 && retry[1].delay < 400, 'the first reconnect attempt uses a short jittered delay');
  timeouts.delete(retry[0]); retry[1].callback();
  assert.equal(sockets.length, 3);
  const deadline = [...timeouts].find(([, task]) => task.delay === 10_000);
  timeouts.delete(deadline[0]); deadline[1].callback();
  assert.equal(sockets[2].closeCode, 4000, 'stuck CONNECTING sockets hit a handshake deadline');
  sockets[2].dispatch('open');
  assert.equal(sockets[2].sent.length, 0, 'late events from a retired socket cannot affect the live session');
  windowListeners.get('offline')();
  assert.equal(timeouts.size, 0, 'offline state cancels all reconnect and handshake timers');
} finally {
  secondary?.close();
  connection?.close();
  await vite.close();
  Date.now = realNow;
  globalThis.BroadcastChannel = realBroadcastChannel;
}

console.log('Realtime client smoke passed: shared delivery, call signaling, bounded ephemeral traffic, fast reconnect, stale and stuck socket recovery.');
