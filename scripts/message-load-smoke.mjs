import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { TERMS_VERSION, CONDUCT_VERSION } from '../src/app/agreements.js';

const dir = await mkdtemp('/tmp/glean-message-load-'), port = 5395, origin = `http://127.0.0.1:${port}`;
let db = new DatabaseSync(dir + '/glean-auth.sqlite');
db.exec("CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; INSERT INTO platform_settings VALUES('allow_school_hours','1')"); db.close();
const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: String(port), GLEAN_DATA_DIR: dir, NODE_ENV: 'production', GROQ_API_KEY: '', GIPHY_API_KEY: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
let logs = '', cookie = ''; const sockets = [], states = [];
server.stderr.on('data', chunk => logs = (logs + chunk).slice(-4000));
const call = async (path, method = 'GET', body, token) => {
  const response = await fetch(origin + '/api/v1' + path, { method, headers: { Origin: origin, Cookie: cookie, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json(); return { status: response.status, data };
};
async function attach(token) {
  const socket = connect(port, '127.0.0.1'); sockets.push(socket);
  const state = { ids: [], packets: [] }; states.push(state);
  let pending = Buffer.alloc(0), upgraded = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('WebSocket connection timed out')), 10000);
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`GET /api/v1/realtime HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nAuthorization: Bearer ${token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
    socket.on('data', chunk => {
      try {
      pending = Buffer.concat([pending, chunk]);
      if (!upgraded) { const end = pending.indexOf('\r\n\r\n'); if (end < 0) return; assert.match(pending.subarray(0, end).toString(), /^HTTP\/1.1 101/); pending = pending.subarray(end + 4); upgraded = true; }
      let offset = 0;
      while (offset + 2 <= pending.length) {
        const marker = pending[offset + 1] & 127, opcode = pending[offset] & 15;
        let length = marker, header = 2;
        if (marker === 126) { if (offset + 4 > pending.length) break; length = pending.readUInt16BE(offset + 2); header = 4; }
        if (marker === 127) { if (offset + 10 > pending.length) break; length = Number(pending.readBigUInt64BE(offset + 2)); header = 10; }
        if (offset + header + length > pending.length) break;
        if (opcode === 1) {
          const packet = JSON.parse(pending.subarray(offset + header, offset + header + length).toString());
          if (packet.event === 'connected') { clearTimeout(timer); resolve(); }
          if (packet.event === 'channel-message') { state.packets.push(packet.payload); if (packet.payload.action === 'created') state.ids.push(packet.payload.message.id); }
        }
        offset += header + length;
      }
      pending = pending.subarray(offset);
      } catch (error) { clearTimeout(timer); reject(error); socket.destroy(); }
    });
  });
}
try {
  for (let attempt = 0; ; attempt++) { try { if ((await fetch(origin + '/api/health')).ok) break; } catch {} if (attempt > 100 || server.exitCode !== null) throw Error(logs); await new Promise(r => setTimeout(r, 100)); }
  const signed = await call('/auth/signup', 'POST', { username: 'Nuper', password: 'load-test-password-123' }); assert.equal(signed.status, 201);
  db = new DatabaseSync(dir + '/glean-auth.sqlite'); const now = new Date().toISOString();
  const accept = db.prepare('INSERT INTO user_agreement_acceptances VALUES(?,?,?,?)'); accept.run(signed.data.account.id, TERMS_VERSION, CONDUCT_VERSION, now);
  const created = await call('/servers', 'POST', { name: 'Local Load Test' }); assert.equal(created.status, 201);
  const serverId = created.data.server.id, details = await call(`/servers/${serverId}`);
  const channelId = details.data.server.channels.find(row => !row.voice).id, role = details.data.server.roles.find(row => row.permissions === 'member');
  const insert = db.prepare('INSERT INTO users(email,username,password_hash,password_salt,created_at,last_visited_at) VALUES(?,?,?,?,?,?)');
  const member = db.prepare('INSERT INTO server_members(server_id,user_id,role_id,joined_at) VALUES(?,?,?,?)'), session = db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)');
  const tokens = []; db.exec('BEGIN');
  for (let index = 1; index <= 1000; index++) {
    const id = Number(insert.run(`load${index}@example.invalid`, `LoadUser${index}`, 'not-a-login', 'not-a-salt', now, now).lastInsertRowid);
    member.run(serverId, id, role.id, now); accept.run(id, TERMS_VERSION, CONDUCT_VERSION, now);
    if (index <= 100) { const token = createHash('sha256').update(`local-load-session-${index}`).digest('hex'); session.run(createHash('sha256').update(token).digest('hex'), id, '2099-01-01T00:00:00.000Z'); tokens.push(token); }
  }
  db.exec('COMMIT');
  const historyRows = Number(process.env.GLEAN_LOAD_HISTORY || 0);
  if (historyRows > 0) {
    const addHistory = db.prepare('INSERT INTO channel_messages(channel_id,user_id,body,created_at) VALUES(?,?,?,?)');
    const authorId = db.prepare("SELECT id FROM users WHERE username = 'LoadUser1000'").get().id;
    const liveAuthorId = db.prepare("SELECT id FROM users WHERE username = 'LoadUser1'").get().id;
    db.exec('BEGIN');
    for (let index = 0; index < historyRows; index++) addHistory.run(channelId, index % 10 === 0 ? liveAuthorId : authorId, 'retained history', now);
    db.exec('COMMIT');
  }
  await Promise.all(tokens.map(attach));
  const times = [], started = performance.now();
  const sent = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const before = performance.now(), result = await call(`/channels/${channelId}/messages`, 'POST', { body: `burst ${index}` }); times.push(performance.now() - before); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.message.id;
  }));
  for (let attempt = 0; states.some(state => state.ids.length < 100); attempt++) { if (attempt > 200) throw Error('Missing message deliveries'); await new Promise(r => setTimeout(r, 50)); }
  const expected = sent.toSorted((a, b) => a - b);
  for (let index = 0; index < states.length; index++) {
    const state = states[index], userId = db.prepare('SELECT id FROM users WHERE username=?').get(`LoadUser${index + 1}`).id;
    const unread = db.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id=? AND user_id != ? AND deleted_at IS NULL').get(channelId, userId).n;
    assert.deepEqual(state.ids, expected); assert.equal(state.packets.at(-1).unreadCount, unread);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id=? AND deleted_at IS NULL').get(channelId).n, historyRows + 100);
  const mention = await call(`/channels/${channelId}/messages`, 'POST', { body: '@LoadUser1 hello' }); assert.equal(mention.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel_message_mentions WHERE message_id=?').get(mention.data.message.id).n, 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(states[0].packets.at(-1).mentionCount, 1);
  assert.equal((await call(`/channels/${channelId}/read`, 'POST', {}, tokens[1])).status, 200);
  const afterRead = await call(`/channels/${channelId}/messages`, 'POST', { body: 'after member read' }); assert.equal(afterRead.status, 201);
  for (let attempt = 0; states[1].ids.at(-1) !== afterRead.data.message.id; attempt++) { if (attempt > 100) throw Error('Missing post-read delivery'); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(states[1].packets.at(-1).unreadCount, 1);
  assert.equal((await call(`/servers/${serverId}/channels/${channelId}`, 'PATCH', { slowmode: 60 })).status, 200);
  const restricted = await Promise.all([call(`/channels/${channelId}/messages`, 'POST', { body: 'slowmode one' }, tokens[1]), call(`/channels/${channelId}/messages`, 'POST', { body: 'slowmode two' }, tokens[1])]);
  assert.deepEqual(restricted.map(row => row.status).sort(), [201, 429]);
  times.sort((a, b) => a - b);
  console.log(`PASS real API/WebSocket load: 1,000 members, 100 connected recipients, 100 concurrent sends, 10,000 ordered deliveries, correct unread totals, mentions and concurrent slowmode. HTTP acknowledgement p95 ${times[94].toFixed(1)} ms; burst ${ (performance.now() - started).toFixed(1) } ms on local loopback, not production latency.`);
} finally { for (const socket of sockets) socket.destroy(); db?.close(); server.kill('SIGTERM'); await new Promise(r => server.exitCode !== null ? r() : server.once('exit', r)); await rm(dir, { recursive: true, force: true }); }
