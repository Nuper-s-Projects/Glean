import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createRealtimeHub } from '../server/realtime.mjs';

const hub = createRealtimeHub({ authenticate: request => ({ id: Number(new URL(request.url, 'http://test').searchParams.get('user')) }) });
const server = createServer();
server.on('upgrade', (request, socket, head) => hub.upgrade(request, socket, head));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const clients = [];
const arrivals = [];
let completed;
const done = new Promise(resolve => { completed = resolve; });
let started = 0;
const clientCount = 8;
const messages = 100;
async function client(id) {
  const socket = connect(port, '127.0.0.1');
  clients.push(socket);
  socket.setNoDelay(true);
  const seen = [];
  let pending = Buffer.alloc(0);
  let upgraded = false;
  let ready;
  const connected = new Promise(resolve => { ready = resolve; });
  socket.on('data', chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    if (!upgraded) {
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      assert.match(pending.subarray(0, end).toString(), /^HTTP\/1.1 101/);
      pending = pending.subarray(end + 4);
      upgraded = true;
    }
    let offset = 0;
    while (offset + 2 <= pending.length) {
      const opcode = pending[offset] & 0x0f;
      const marker = pending[offset + 1] & 0x7f;
      let length = marker, header = 2;
      if (marker === 126) { if (offset + 4 > pending.length) break; length = pending.readUInt16BE(offset + 2); header = 4; }
      if (marker === 127) { if (offset + 10 > pending.length) break; length = Number(pending.readBigUInt64BE(offset + 2)); header = 10; }
      if (offset + header + length > pending.length) break;
      const body = pending.subarray(offset + header, offset + header + length);
      offset += header + length;
      if (opcode !== 1) continue;
      const packet = JSON.parse(body.toString());
      if (packet.event === 'connected') ready();
      if (packet.event === 'channel-message') {
        assert.equal(packet.payload.unreadCount, id);
        assert.equal(packet.payload.message.body, 'socket payload 😀'.repeat(100));
        seen.push(packet.payload.message.id);
        arrivals.push(performance.now() - started);
        if (arrivals.length === clientCount * messages) completed();
      }
    }
    pending = pending.subarray(offset);
  });
  socket.on('error', error => { throw error; });
  await once(socket, 'connect');
  socket.write(`GET /api/v1/realtime?user=${id} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  await connected;
  return seen;
}
let timeout;
try {
  const histories = await Promise.all(Array.from({ length: clientCount }, (_, index) => client(index + 1)));
  started = performance.now();
  for (let messageId = 1; messageId <= messages; messageId++) {
    const packet = hub.prepareEvent('channel-message', { channelId: 1, message: { id: messageId, body: 'socket payload 😀'.repeat(100) } });
    for (let id = 1; id <= clientCount; id++) hub.sendPrepared(id, packet, { unreadCount: id });
  }
  await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('TCP fanout timed out')), 5000); })]);
  for (const history of histories) assert.deepEqual(history, Array.from({ length: messages }, (_, index) => index + 1), 'every real TCP client receives ordered messages with no duplicates or loss');
  arrivals.sort((a, b) => a - b);
  console.log(`Realtime TCP smoke passed: ${clientCount} connections, ${arrivals.length} ordered deliveries; whole-burst arrival p95 ${arrivals[Math.floor(arrivals.length * 0.95)].toFixed(2)} ms on loopback (not internet RTT).`);
} finally {
  clearTimeout(timeout);
  hub.close();
  for (const socket of clients) socket.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
