import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import webpush from 'web-push';
import { createNotificationPreferences, DEFAULT_NOTIFICATIONS } from '../server/notificationPreferences.mjs';
import { createPushService } from '../server/push.mjs';
import { TERMS_VERSION, CONDUCT_VERSION } from '../src/app/agreements.js';

const dir = await mkdtemp('/tmp/glean-notification-preferences-'), origin = 'http://127.0.0.1:5397';
const seed = new DatabaseSync(join(dir, 'glean-auth.sqlite'));
seed.exec("CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; INSERT INTO platform_settings VALUES('allow_school_hours','1')"); seed.close();
let logs = '', db;
const start = () => {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, GLEAN_DATA_DIR: dir, PORT: '5397', NODE_ENV: 'production', GROQ_API_KEY: '', GIPHY_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-6000); }); child.stdout.on('data', () => {}); return child;
};
let server = start();
const sockets = [];
const connectRealtime = cookie => new Promise((resolve, reject) => {
  const req = httpRequest(origin + '/api/v1/realtime', { headers: { Cookie: cookie, Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64') } });
  req.setTimeout(5000, () => req.destroy(new Error('Realtime connection timed out')));
  req.on('error', reject); req.on('response', response => { response.resume(); reject(new Error(`WebSocket ${response.statusCode}`)); });
  req.on('upgrade', (_response, connection, head) => {
    sockets.push(connection); const events = []; let pending = Buffer.alloc(0);
    const parse = chunk => {
      pending = Buffer.concat([pending, chunk]); let offset = 0;
      while (offset + 2 <= pending.length) {
        let length = pending[offset + 1] & 127, cursor = offset + 2;
        if (length === 126) { if (cursor + 2 > pending.length) break; length = pending.readUInt16BE(cursor); cursor += 2; }
        if (length === 127) { if (cursor + 8 > pending.length) break; length = Number(pending.readBigUInt64BE(cursor)); cursor += 8; }
        if (cursor + length > pending.length) break;
        if ((pending[offset] & 15) === 1) events.push(JSON.parse(pending.subarray(cursor, cursor + length).toString()));
        offset = cursor + length;
      }
      pending = pending.subarray(offset);
    };
    connection.on('error', () => {}); connection.on('data', parse); if (head.length) parse(head); connection.resume(); resolve(events);
  }); req.end();
});
const stop = async () => { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = async () => { for (let i = 0; ; i++) { try { if ((await fetch(origin + '/api/health')).ok) return; } catch {} if (i > 100 || server.exitCode !== null) throw Error(logs || 'Server did not start'); await pause(100); } };
const originalSend = webpush.sendNotification;
try {
  await ready(); db = new DatabaseSync(join(dir, 'glean-auth.sqlite')); db.exec('PRAGMA busy_timeout=5000');
  const clients = [];
  for (const username of ['NotifyOwnerQA', 'NotifyMemberQA', 'NotifyThirdQA', 'NotifyOutsiderQA']) {
    let cookie = '';
    const call = async (path, method = 'GET', input, expected = 200) => {
      const response = await fetch(origin + '/api/v1' + path, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const result = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`); return result;
    };
    const { account } = await call('/auth/signup', 'POST', { username, password: 'notification-local-password-123' }, 201);
    db.prepare('INSERT INTO user_agreement_acceptances(user_id,terms_version,conduct_version,accepted_at) VALUES(?,?,?,?)').run(account.id, TERMS_VERSION, CONDUCT_VERSION, new Date().toISOString());
    clients.push({ id: account.id, call, get cookie() { return cookie; } });
  }
  const [owner, member, third, outsider] = clients, now = new Date().toISOString();
  for (const friend of [member, third]) db.prepare('INSERT INTO friendships VALUES(?,?,?)').run(Math.min(owner.id, friend.id), Math.max(owner.id, friend.id), now);
  const group = (await owner.call('/conversations/groups', 'POST', { name: 'Notification QA group', memberIds: [member.id, third.id] }, 201)).conversation;
  const direct = Number(db.prepare("INSERT INTO conversations(kind,created_at) VALUES('direct',?)").run(now).lastInsertRowid);
  for (const user of [owner, member]) db.prepare('INSERT INTO conversation_members(conversation_id,user_id,joined_at) VALUES(?,?,?)').run(direct, user.id, now);
  for (const id of [group.id, direct]) db.prepare('INSERT INTO messages(conversation_id,sender_id,body,created_at) VALUES(?,?,?,?)').run(id, owner.id, 'Fixture unread message', now);
  const sid = Number(db.prepare("INSERT INTO servers(name,owner_id,created_at,is_public) VALUES('Notification QA',?,?,1)").run(owner.id, now).lastInsertRowid);
  const role = Number(db.prepare("INSERT INTO server_roles(server_id,name,permissions) VALUES(?,'Member','member')").run(sid).lastInsertRowid);
  for (const user of [owner, member, third]) db.prepare('INSERT INTO server_members(server_id,user_id,role_id,joined_at) VALUES(?,?,?,?)').run(sid, user.id, role, now);
  const channel = Number(db.prepare("INSERT INTO server_channels(server_id,name) VALUES(?,'general')").run(sid).lastInsertRowid);
  const hidden = Number(db.prepare("INSERT INTO server_channels(server_id,name) VALUES(?,'restricted')").run(sid).lastInsertRowid);
  const message = Number(db.prepare("INSERT INTO channel_messages(channel_id,user_id,body,created_at) VALUES(?,?,'hello @NotifyMemberQA',?)").run(channel, owner.id, now).lastInsertRowid);
  db.prepare('INSERT INTO channel_message_mentions(message_id,user_id) VALUES(?,?)').run(message, member.id);
  assert.equal((await fetch(origin + '/api/v1/account/notifications')).status, 401);
  assert.equal((await fetch(origin + `/api/v1/conversations/${group.id}/mute`, { method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"muted":true}' })).status, 401);
  assert.deepEqual((await member.call('/account/notifications')).settings, DEFAULT_NOTIFICATIONS);
  assert.equal((await member.call('/account/notifications')).settings.serverMessages, 'all', 'accounts without saved preferences default to all messages');
  for (const input of [[], null, {}, { unknown: true }, { serverMessages: 'bad' }, { groupMessages: 'false' }]) await member.call('/account/notifications', 'PATCH', input, 400);
  const mutePath = `/conversations/${group.id}/mute`;
  await outsider.call(mutePath, 'PATCH', { muted: true }, 404); await member.call(mutePath, 'PATCH', { muted: 1 }, 400);
  const memberEvents = await connectRealtime(member.cookie), thirdEvents = await connectRealtime(third.cookie);
  await member.call(mutePath, 'PATCH', { muted: true }); await member.call(mutePath, 'PATCH', { muted: true });
  for (let i = 0; i < 50 && !memberEvents.some(item => item.event === 'notification-settings'); i++) await pause(10);
  assert.ok(memberEvents.some(item => item.event === 'notification-settings' && item.payload.conversationId === group.id && item.payload.muted === true), 'other devices receive the saved mute');
  assert.ok(memberEvents.some(item => item.event === 'unread' && item.payload.homeUnread === 1), 'home badge synchronizes immediately');
  assert.equal(thirdEvents.some(item => item.event === 'notification-settings'), false, 'personal settings are not broadcast to other members');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_conversation_mutes WHERE user_id=?').get(member.id).n, 1);
  assert.equal((await member.call('/account/notifications')).groups[0].muted, true);
  assert.equal((await third.call('/account/notifications')).groups[0].muted, false, 'mute is personal, not group-wide');
  const inbox = await member.call('/conversations');
  assert.equal(inbox.conversations.find(item => item.id === group.id).muted, true); assert.equal(inbox.dmUnread, 1, 'only unmuted direct message contributes badge');
  await member.call(`/servers/${sid}/mute`, 'PATCH', { muted: true });
  assert.equal((await member.call('/account/notifications')).servers.find(item => item.id === sid).muted, true);
  await outsider.call(`/servers/${sid}/mute`, 'PATCH', { muted: true }, 403);
  await Promise.all([member.call('/account/notifications', 'PATCH', { friendRequests: false }), member.call('/account/notifications', 'PATCH', { dailyGreetings: false })]);
  assert.equal((await member.call('/account/notifications')).settings.friendRequests, false);
  await third.call('/account/notifications', 'PATCH', { serverMessages: 'mentions' });
  for (const connection of sockets) connection.destroy();
  server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); server = start(); await ready();
  const restored = await member.call('/account/notifications'); assert.equal(restored.settings.dailyGreetings, false); assert.equal(restored.groups[0].muted, true); assert.equal(restored.servers.find(item => item.id === sid).muted, true);
  assert.equal(restored.settings.serverMessages, 'all', 'saving another preference retains the default');
  assert.equal((await third.call('/account/notifications')).settings.serverMessages, 'mentions', 'explicit choices survive restart');
  const policy = createNotificationPreferences({ database: db, channelVisible: (_user, id) => id === channel });
  const payload = { kind: 'channel', serverId: sid, channelId: channel, messageId: message };
  assert.equal(policy.canNotify(owner.id, payload), true, 'all-messages default permits unmentioned channel alerts');
  assert.equal(policy.canNotify(member.id, payload), false, 'server mute wins over mentions');
  await member.call(`/servers/${sid}/mute`, 'PATCH', { muted: false });
  assert.equal(policy.canNotify(member.id, payload), true); assert.equal(policy.canNotify(third.id, payload), false, 'unmentioned public channel stays quiet');
  assert.equal(policy.canNotify(outsider.id, payload), false);
  await third.call('/account/notifications', 'PATCH', { serverMessages: 'all' });
  assert.equal(policy.canNotify(third.id, payload), true);
  assert.equal(policy.canNotify(third.id, { ...payload, channelId: hidden }), false, 'channel access remains required');
  await third.call('/account/notifications', 'PATCH', { serverMessages: 'off' }); assert.equal(policy.canNotify(third.id, payload), false);
  assert.equal(policy.canNotify(member.id, { kind: 'friends' }), false);
  assert.equal(policy.canNotify(member.id, { kind: 'announcement', tag: 'glean-scheduled-morning' }), false);
  assert.equal(policy.canNotify(member.id, { kind: 'announcement', tag: 'admin-announcement' }), true);
  assert.equal(policy.canNotify(member.id, { kind: 'dm', conversationId: group.id }), false);
  await member.call(mutePath, 'PATCH', { muted: false });
  assert.equal(policy.canNotify(member.id, { kind: 'dm', conversationId: group.id }), true);
  await member.call('/account/notifications', 'PATCH', { directMessages: false, groupMessages: false });
  assert.equal(policy.canNotify(member.id, { kind: 'dm', conversationId: direct }), false);
  assert.equal(policy.canNotify(member.id, { kind: 'dm-call', conversationId: direct }), false);
  assert.equal(policy.canNotify(member.id, { kind: 'dm', conversationId: group.id }), false);
  assert.equal(policy.canNotify(member.id, { kind: 'loop', conversationId: direct }), true, 'Loop preferences stay independent');
  const sent = []; webpush.sendNotification = async (subscription, body) => { sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) }); };
  const push = createPushService({ database: db, dataDirectory: dir, canNotify: policy.canNotify });
  push.subscribe(member.id, { endpoint: 'https://push.example.test/member', keys: { p256dh: 'fixture-key', auth: 'fixture-auth' } }, now);
  push.notifyUsers([member.id], payload); await pause(25); assert.equal(sent.length, 1, 'allowed notification reaches push transport');
  push.notifyUsers([member.id], payload);
  db.prepare('INSERT INTO user_server_mutes(user_id,server_id,muted_at) VALUES(?,?,?)').run(member.id, sid, now);
  await pause(25); assert.equal(sent.length, 1, 'queued push rechecks preferences at dispatch');
  push.notifyUsers([member.id], { kind: 'dm', conversationId: group.id }); await pause(25); assert.equal(sent.length, 1);
  push.notifyUsers([member.id], { kind: 'loop', title: 'Loop' }); await pause(25); assert.equal(sent.length, 2);
  await member.call(mutePath, 'PATCH', { muted: true });
  await member.call(`/conversations/${group.id}/group/leave`, 'POST', {});
  assert.equal((await member.call('/account/notifications')).groups.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_conversation_mutes WHERE user_id=? AND conversation_id=?').get(member.id, group.id).n, 0);
  await member.call(mutePath, 'PATCH', { muted: true }, 404);
  assert.equal(policy.canNotify(member.id, { kind: 'dm', conversationId: group.id }), false);
  assert.equal((await third.call(`/conversations/${group.id}/group`)).conversation.members.length, 2, 'leaving preserves remaining members');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log('PASS notification preferences: authenticated personal settings, validation, concurrent patches, cross-device/restart persistence, server/group mute, unread badges, mention-only/all/off delivery, permissions, queued push filtering, Loop independence and group leave cleanup.');
} finally { for (const connection of sockets) connection.destroy(); webpush.sendNotification = originalSend; db?.close(); await stop(); await rm(dir, { recursive: true, force: true }); }
