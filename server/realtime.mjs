import { createHash } from 'node:crypto';
import { hasBearerAuthorization, isSameOriginOrigin } from './security.mjs';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const EPHEMERAL_EVENTS = new Set(['typing', 'channel-typing', 'presence']);
const SOFT_BUFFER_LIMIT = 64 * 1024;
const HARD_BUFFER_LIMIT = 1024 * 1024;

function frameHeader(opcode, length) {
  const header = Buffer.allocUnsafe(length < 126 ? 2 : length <= 0xffff ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (header.length === 2) header[1] = length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  return header;
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const isBuffer = Buffer.isBuffer(payload);
  const bodyLength = isBuffer ? payload.length : Buffer.byteLength(payload);
  const headerLength = bodyLength < 126 ? 2 : bodyLength <= 0xffff ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLength + bodyLength);
  frame[0] = 0x80 | opcode;
  if (headerLength === 2) {
    frame[1] = bodyLength;
  } else if (headerLength === 4) {
    frame[1] = 126;
    frame.writeUInt16BE(bodyLength, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(bodyLength), 2);
  }
  if (isBuffer) payload.copy(frame, headerLength);
  else frame.write(payload, headerLength, bodyLength, 'utf8');
  return frame;
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > 125) throw new Error('WebSocket control frame too large.');
  return encodeFrame(opcode, body);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor); cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      const big = buffer.readBigUInt64BE(cursor); cursor += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large.');
      length = Number(big);
    }
    if (!masked) throw new Error('Client WebSocket frames must be masked.');
    if (length > 64 * 1024) throw new Error('WebSocket frame too large.');
    if (cursor + 4 + length > buffer.length) break;
    const mask = buffer.subarray(cursor, cursor + 4); cursor += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) payload[i] = buffer[cursor + i] ^ mask[i & 3];
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

export function createRealtimeHub({ authenticate, onClientEvent, onConnect, onDisconnect }) {
  const clients = new Map();

  function write(socket, frame, event, length = frame.length) {
    if (socket.destroyed || !socket.writable || socket.writableEnded) return false;
    const buffered = socket.writableLength || 0;
    if (EPHEMERAL_EVENTS.has(event) && buffered + length > SOFT_BUFFER_LIMIT) return false;
    if (buffered + length > HARD_BUFFER_LIMIT) {
      // Reconnection resyncs durable state instead of retaining an unlimited backlog.
      socket.destroy();
      return false;
    }
    try {
      if (Array.isArray(frame)) {
        socket.cork();
        try { for (const part of frame) socket.write(part); }
        finally { socket.uncork(); }
      } else socket.write(frame);
      return true;
    } catch {
      socket.destroy();
      return false;
    }
  }

  function prepareEvent(event, payload = {}) {
    const json = JSON.stringify(payload);
    if (!json || json[0] !== '{') throw new TypeError('Realtime payload must be an object.');
    return {
      event,
      payload,
      prefix: Buffer.from(`{"event":${JSON.stringify(event)},"payload":${json.slice(0, -1)}`),
      hasFields: json.length > 2,
    };
  }

  function sendPrepared(userId, prepared, extra = {}) {
    const set = clients.get(Number(userId));
    if (!set?.size) return;
    // The large message/attachment payload is serialized and retained once for
    // the whole fanout. Only small, private unread fields vary per recipient.
    const fields = JSON.stringify(extra).slice(1, -1);
    const suffix = Buffer.from(`${fields ? `${prepared.hasFields ? ',' : ''}${fields}` : ''}}}`);
    const length = prepared.prefix.length + suffix.length;
    const header = frameHeader(0x1, length);
    const parts = [header, prepared.prefix, suffix];
    for (const socket of set) write(socket, parts, prepared.event, header.length + length);
  }

  function add(userId, socket, sessionHash) {
    socket.gleanSessionHash = sessionHash || '';
    socket.gleanAlive = true;
    const set = clients.get(userId) || new Set();
    set.add(socket);
    clients.set(userId, set);
  }

  function remove(userId, socket) {
    const set = clients.get(userId);
    if (!set) return;
    set.delete(socket);
    if (!set.size) clients.delete(userId);
  }

  function send(userId, event, payload = {}) {
    const set = clients.get(Number(userId));
    if (!set) return;
    const frame = encodeFrame(0x1, JSON.stringify({ event, payload }));
    for (const socket of set) write(socket, frame, event);
  }

  function broadcast(userIds, event, payload = {}) {
    const frame = encodeFrame(0x1, JSON.stringify({ event, payload }));
    const sent = new Set();
    for (const value of userIds) {
      const userId = Number(value);
      if (!Number.isSafeInteger(userId) || sent.has(userId)) continue;
      sent.add(userId);
      const set = clients.get(userId);
      if (!set) continue;
      for (const socket of set) {
        write(socket, frame, event);
      }
    }
  }

  function broadcastAll(event, payload = {}) {
    broadcast(clients.keys(), event, payload);
  }

  function closeAll(code = 1008, reason = 'Connection closed by server') {
    const reasonBytes = Buffer.from(String(reason), 'utf8').subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    const frame = encodeControlFrame(0x8, payload);
    for (const set of clients.values()) {
      for (const socket of [...set]) {
        if (!socket.destroyed && socket.writable) socket.end(frame);
      }
    }
  }

  function dropSession(sessionHash) {
    if (!sessionHash) return;
    for (const set of clients.values()) {
      for (const socket of [...set]) {
        if (socket.gleanSessionHash === sessionHash && !socket.destroyed) socket.destroy();
      }
    }
  }

  function dropUserExcept(userId, keepHash) {
    const set = clients.get(Number(userId));
    if (!set) return;
    for (const socket of [...set]) {
      if (socket.gleanSessionHash !== keepHash && !socket.destroyed) socket.destroy();
    }
  }

  function connectedCount(userId) {
    return clients.get(Number(userId))?.size || 0;
  }

  function upgrade(request, socket, head = Buffer.alloc(0)) {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname !== '/api/v1/realtime' && url.pathname !== '/api/realtime') return socket.destroy();
      const hasOrigin = typeof request.headers.origin === 'string' && request.headers.origin.length > 0;
      if (hasOrigin ? !isSameOriginOrigin(request) : !hasBearerAuthorization(request)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      const user = authenticate(request);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      const key = request.headers['sec-websocket-key'];
      if (!key || String(request.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();
      const accept = createHash('sha1').update(`${key}${MAGIC}`).digest('base64');
      socket.setNoDelay?.(true);
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'));
      add(Number(user.id), socket, user.sessionHash);
      socket.write(encodeFrame(0x1, JSON.stringify({ event: 'connected', payload: { userId: Number(user.id) } })));
      let pending = Buffer.alloc(0);
      const receive = (chunk) => {
        try {
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          const decoded = decodeFrames(pending);
          pending = decoded.remaining;
          for (const frame of decoded.frames) {
            if (!frame.fin) throw new Error('Fragmented WebSocket frames are not supported.');
            if (frame.opcode === 0x8) {
              socket.end(encodeFrame(0x8));
              return;
            }
            if (frame.opcode === 0x9) {
              write(socket, encodeControlFrame(0xA, frame.payload));
              continue;
            }
            if (frame.opcode === 0xA) {
              socket.gleanAlive = true;
              continue;
            }
            if (frame.opcode !== 0x1 || frame.payload.length > 64 * 1024) continue;
            let message;
            try { message = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
            onClientEvent?.(user, message, (event, payload) => send(user.id, event, payload), socket);
          }
        } catch {
          socket.destroy();
        }
      };
      socket.on('data', receive);
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        pending = Buffer.alloc(0);
        socket.removeListener('data', receive);
        remove(Number(user.id), socket);
        // Upgraded HTTP sockets can remain half-open after the peer sends FIN.
        if (!socket.destroyed) socket.destroy();
        onDisconnect?.(user, socket);
      };
      socket.on('close', cleanup);
      socket.on('end', cleanup);
      socket.on('error', cleanup);
      onConnect?.(user, socket);
      if (head.length && !socket.destroyed) receive(head);
    } catch {
      socket.destroy();
    }
  }

  const heartbeat = setInterval(() => {
    const ping = encodeFrame(0x9, Buffer.from('glean'));
    const state = encodeFrame(0x1, JSON.stringify({ event: 'heartbeat', payload: { at: Date.now() } }));
    for (const set of clients.values()) {
      for (const socket of [...set]) {
        if (socket.destroyed || !socket.writable) continue;
        if (!socket.gleanAlive) {
          socket.destroy();
          continue;
        }
        socket.gleanAlive = false;
        write(socket, ping);
        write(socket, state, 'heartbeat');
      }
    }
  }, 15_000);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    for (const set of clients.values()) for (const socket of [...set]) socket.destroy();
  };
  return { send, prepareEvent, sendPrepared, broadcast, broadcastAll, closeAll, upgrade, dropSession, dropUserExcept, connectedCount, close };
}
