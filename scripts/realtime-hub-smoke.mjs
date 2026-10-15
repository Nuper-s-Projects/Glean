import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createRealtimeHub } from '../server/realtime.mjs';
import { createPresenceBatch } from '../server/presenceBatch.mjs';

class Socket extends EventEmitter {
  constructor() { super(); this.writable = true; this.destroyed = false; this.writableLength = 0; this.chunks = []; this.corks = 0; }
  write(data) { this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); return true; }
  cork() { this.corks++; }
  uncork() { this.corks--; }
  setNoDelay(value) { this.noDelay = value; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); }
  end(data) { if (data) this.write(data); this.destroy(); }
  packet() {
    const frame = Buffer.concat(this.chunks);
    const size = frame[1] & 0x7f;
    const start = size < 126 ? 2 : size === 126 ? 4 : 10;
    return JSON.parse(frame.subarray(start).toString());
  }
}
function maskedPacket(event, payload = {}) {
  const body = Buffer.from(JSON.stringify({ event, payload }));
  assert.ok(body.length < 126);
  const frame = Buffer.alloc(6 + body.length);
  frame[0] = 0x81; frame[1] = 0x80 | body.length;
  const mask = Buffer.from([1, 2, 3, 4]); mask.copy(frame, 2);
  for (let i = 0; i < body.length; i++) frame[6 + i] = body[i] ^ mask[i & 3];
  return frame;
}
const incoming = [];
let disconnects = 0;
const hub = createRealtimeHub({ authenticate: request => ({ id: request.id, sessionHash: 'test' }), onClientEvent: (user, message) => incoming.push({ id: user.id, message }), onDisconnect: () => { disconnects++; } });
const sockets = [];
function attach(id, head) {
  const socket = new Socket();
  hub.upgrade({ id, url: '/api/v1/realtime', socket, headers: { host: 'glean.local', origin: 'http://glean.local', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } }, socket, head);
  assert.equal(socket.destroyed, false);
  socket.chunks = [];
  sockets.push(socket);
  return socket;
}
try {
  for (let i = 1; i <= 1000; i++) attach(i);
  let serializations = 0;
  const message = { toJSON() { serializations++; return { id: 42, body: '😀 quoted " text\n'.repeat(1000), attachments: [{ id: 1, name: 'file.png' }] }; } };
  const started = performance.now();
  const prepared = hub.prepareEvent('channel-message', { serverId: 7, channelId: 8, action: 'created', message });
  for (let i = 1; i <= 1000; i++) hub.sendPrepared(i, prepared, { unreadCount: i, mentioned: i === 1 });
  const elapsed = performance.now() - started;
  assert.equal(serializations, 1, 'a 1000-recipient message is serialized once');
  for (let i = 0; i < sockets.length; i++) {
    const packet = sockets[i].packet();
    assert.equal(packet.event, 'channel-message');
    assert.equal(packet.payload.unreadCount, i + 1, 'private fields are not leaked between recipients');
    assert.equal(packet.payload.mentioned, i === 0);
    assert.equal(packet.payload.message.body, '😀 quoted " text\n'.repeat(1000));
    assert.equal(sockets[i].chunks[1], prepared.prefix, 'the same immutable message buffer is reused');
    assert.equal(sockets[i].corks, 0, 'healthy sockets flush immediately');
    sockets[i].chunks = [];
  }
  hub.sendPrepared(1, hub.prepareEvent('empty', {}), {});
  assert.deepEqual(sockets[0].packet(), { event: 'empty', payload: {} });
  sockets[0].chunks = [];
  hub.sendPrepared(1, hub.prepareEvent('empty', {}), { private: 1 });
  assert.deepEqual(sockets[0].packet(), { event: 'empty', payload: { private: 1 } });
  const slow = sockets[0]; slow.chunks = []; slow.writableLength = 65 * 1024;
  hub.send(1, 'channel-typing', { typing: true });
  assert.equal(slow.chunks.length, 0, 'congested sockets discard ephemeral events');
  hub.send(1, 'dm-call-accepted', { conversationId: 1 });
  assert.equal(slow.packet().event, 'dm-call-accepted', 'critical signaling bypasses the soft limit');
  slow.writableLength = 1024 * 1024;
  hub.broadcast([1, 2, 2], 'message', { body: 'still delivered' });
  assert.equal(slow.destroyed, true, 'slow consumers cannot retain an unlimited backlog');
  assert.equal(hub.connectedCount(1), 0);
  assert.equal(sockets[1].packet().payload.body, 'still delivered', 'slow consumers do not block healthy peers or duplicate recipients');
  const initial = attach(1001, maskedPacket('presence-sync-request'));
  assert.equal(incoming.at(-1).message.event, 'presence-sync-request', 'upgrade head data is not lost');
  assert.equal(initial.noDelay, true);
  const split = maskedPacket('typing', { typing: true });
  initial.emit('data', split.subarray(0, 4)); initial.emit('data', split.subarray(4));
  assert.equal(incoming.at(-1).message.event, 'typing', 'split TCP frames decode correctly');
  initial.destroy(); initial.emit('end'); initial.emit('error', new Error('closed'));
  assert.equal(initial.listenerCount('data'), 0, 'teardown releases parser buffers and listeners');
  assert.equal(disconnects, 2, 'disconnect cleanup is idempotent');
  const halfOpen = attach(1002);
  halfOpen.emit('end');
  assert.equal(halfOpen.destroyed, true, 'half-closed peers release their TCP sockets');
  assert.equal(hub.connectedCount(1002), 0);
  const largeBody = 'x'.repeat(70_000);
  sockets[1].chunks = [];
  hub.sendPrepared(2, hub.prepareEvent('large', { body: largeBody }), {});
  assert.equal(sockets[1].packet().payload.body, largeBody, 'large frames encode their 64-bit payload length correctly');
  const sent = [];
  const batch = createPresenceBatch({ audienceFor: () => [2000, 2000, 2001], isConnected: id => id === 2000, send: (...args) => sent.push(args) });
  for (let i = 1; i <= 1000; i++) { batch.enqueue(i, { userId: i, status: 'online' }); batch.enqueue(i, { userId: i, status: 'offline' }); }
  batch.flush();
  assert.equal(sent.length, 1, 'a burst of 2000 presence changes becomes one event per connected recipient');
  assert.equal(sent[0][1], 'presence-sync');
  assert.equal(sent[0][2].users.length, 1000);
  assert.ok(sent[0][2].users.every(user => user.status === 'offline'), 'only the latest presence state is sent');
  batch.close();
  console.log(`Realtime hub smoke passed: 1000 sockets, one shared serialization, ${elapsed.toFixed(2)} ms fanout setup; backpressure, privacy, upgrade data, split frames and presence batching verified.`);
} finally { hub.close(); for (const socket of sockets) socket.destroy(); }
