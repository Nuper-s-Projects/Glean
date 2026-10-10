import assert from 'node:assert/strict';
import { createServer } from 'vite';

let timerId = 0;
const sockets = [];
const windowListeners = new Map();

globalThis.window = {
  location: { protocol: 'http:', host: 'glean.local' },
  addEventListener(name, handler) { windowListeners.set(name, handler); },
  removeEventListener(name) { windowListeners.delete(name); },
  setInterval() { return ++timerId; },
  clearInterval() {},
  setTimeout() { return ++timerId; },
  clearTimeout() {},
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
  connection = subscribeToDmEvents((event, payload) => received.push({ event, payload }), () => {}, 42);

  assert.equal(sockets.length, 1, 'realtime subscription must open a WebSocket');
  assert.equal(sockets[0].url, 'ws://glean.local/api/v1/realtime');
  sockets[0].readyState = FakeWebSocket.OPEN;
  sockets[0].dispatch('open');
  sockets[0].dispatch('message', {
    data: JSON.stringify({ event: 'channel-message', payload: { action: 'created', channelId: 7 } }),
  });
  assert.deepEqual(received.at(-1), { event: 'channel-message', payload: { action: 'created', channelId: 7 } });
  const secondaryEvents = [];
  secondary = subscribeToDmEvents((event) => secondaryEvents.push(event));
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
  assert.equal(sockets[1].closeCode, 4001, 'restoring an already-open connection also uses a valid code');
} finally {
  secondary?.close();
  connection?.close();
  await vite.close();
}

console.log('Realtime client WebSocket URL and event delivery smoke test passed.');
