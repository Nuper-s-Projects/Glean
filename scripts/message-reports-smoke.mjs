import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { TERMS_VERSION, CONDUCT_VERSION } from '../src/app/agreements.js';

const dir = await mkdtemp('/tmp/glean-reports-smoke-'), origin = 'http://127.0.0.1:5396';
const seed = new DatabaseSync(join(dir, 'glean-auth.sqlite'));
seed.exec("CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; INSERT INTO platform_settings VALUES('allow_school_hours','1')"); seed.close();
let logs = '', db;
const start = () => {
  const processHandle = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, GLEAN_DATA_DIR: dir, PORT: '5396', NODE_ENV: 'production', GROQ_API_KEY: '', GIPHY_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  processHandle.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8000); }); processHandle.stdout.on('data', () => {}); return processHandle;
};
let server = start(), socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = async () => { for (let i = 0; ; i++) { try { if ((await fetch(origin + '/api/health')).ok) break; } catch {} if (i > 100 || server.exitCode !== null) throw Error(logs || 'Server did not start'); await pause(100); } };
const connectRealtime = cookie => new Promise((resolve, reject) => {
  const req = httpRequest(origin + '/api/v1/realtime', { headers: { Cookie: cookie, Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64') } });
  req.on('error', reject); req.on('response', response => reject(new Error(`WebSocket ${response.statusCode}`)));
  req.on('upgrade', (response, connection, head) => {
    socket = connection; const events = []; let pending = Buffer.alloc(0);
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
    socket.on('data', parse); if (head.length) parse(head); socket.resume();
    resolve({ events, send(event, payload) {
      const body = Buffer.from(JSON.stringify({ event, payload })); assert.ok(body.length < 126);
      const mask = Buffer.from([1, 2, 3, 4]), masked = Buffer.from(body); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([Buffer.from([129, 128 | body.length]), mask, masked]));
    } });
  }); req.end();
});
try {
  await ready();
  db = new DatabaseSync(join(dir, 'glean-auth.sqlite')); db.exec('PRAGMA busy_timeout=5000');
  const clients = [];
  for (const username of ['Nuper', 'ReporterQA', 'TargetQA', 'ReviewerQA', 'UnrelatedModeratorQA']) {
    let cookie = '';
    const call = async (path, method = 'GET', body, expected = 200) => {
      const response = await fetch(origin + '/api/v1' + path, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`); return data;
    };
    const { account } = await call('/auth/signup', 'POST', { username, password: 'local-reports-password-123' }, 201);
    db.prepare('INSERT INTO user_agreement_acceptances(user_id,terms_version,conduct_version,accepted_at) VALUES(?,?,?,?)').run(account.id, TERMS_VERSION, CONDUCT_VERSION, new Date().toISOString());
    clients.push({ account, call, get cookie() { return cookie; } });
  }
  const [owner, reporter, target, reviewer, outsider] = clients, now = new Date().toISOString();
  const official = JSON.parse(db.prepare("SELECT value FROM platform_settings WHERE key='official_announcements_server_id'").get().value).id;
  const role = Number(db.prepare("INSERT INTO server_roles(server_id,name,permissions) VALUES(?,'Reviewers','moderator')").run(official).lastInsertRowid);
  db.prepare('UPDATE server_members SET role_id=? WHERE server_id=? AND user_id=?').run(role, official, reviewer.account.id);
  db.prepare('DELETE FROM server_members WHERE server_id=? AND user_id=?').run(official, target.account.id);
  const otherServer = Number(db.prepare("INSERT INTO servers(name,owner_id,created_at) VALUES('Glean',?,?)").run(outsider.account.id, now).lastInsertRowid);
  const memberRole = Number(db.prepare("INSERT INTO server_roles(server_id,name,permissions) VALUES(?,'Member','member')").run(otherServer).lastInsertRowid);
  const otherModRole = Number(db.prepare("INSERT INTO server_roles(server_id,name,permissions) VALUES(?,'Moderator','moderator')").run(otherServer).lastInsertRowid);
  for (const client of [reporter, target, outsider]) db.prepare('INSERT INTO server_members(server_id,user_id,role_id,joined_at) VALUES(?,?,?,?)').run(otherServer, client.account.id, client === outsider ? otherModRole : memberRole, now);
  const channel = Number(db.prepare("INSERT INTO server_channels(server_id,name) VALUES(?,'general')").run(otherServer).lastInsertRowid);
  const message = Number(db.prepare('INSERT INTO channel_messages(channel_id,user_id,body,created_at) VALUES(?,?,?,?)').run(channel, target.account.id, 'Actual server evidence', now).lastInsertRowid);
  const input = { source: 'channel', messageId: message, reason: 'Harassment or bullying', details: '', blockSender: false, messageText: 'Forged text must be ignored', targetId: owner.account.id };
  assert.equal((await fetch(origin + '/api/v1/moderation/reports')).status, 401);
  await reporter.call('/moderation/reports', 'GET', undefined, 403); await outsider.call('/moderation/reports', 'GET', undefined, 403);
  await reviewer.call('/message-reports', 'POST', input, 404);
  const report = await reporter.call('/message-reports', 'POST', input, 201);
  assert.equal((await reporter.call('/message-reports', 'POST', { ...input, blockSender: true })).id, report.id);
  assert.ok(db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(reporter.account.id, target.account.id));
  let queue = await reviewer.call('/moderation/reports'); assert.equal(queue.reports.length, 1);
  assert.equal(queue.reports[0].targetId, target.account.id); assert.equal(queue.reports[0].evidence, 'Actual server evidence');
  assert.equal((await reviewer.call('/auth/me')).account.canReviewReports, true);
  assert.equal((await outsider.call('/auth/me')).account.canReviewReports, false);
  await reviewer.call('/moderation/reports?before=bad', 'GET', undefined, 400);
  const conversation = Number(db.prepare("INSERT INTO conversations(kind,created_at) VALUES('direct',?)").run(now).lastInsertRowid);
  for (const client of [reporter, target]) db.prepare('INSERT INTO conversation_members(conversation_id,user_id,joined_at) VALUES(?,?,?)').run(conversation, client.account.id, now);
  const dm = Number(db.prepare("INSERT INTO messages(conversation_id,sender_id,body,ciphertext,created_at) VALUES(?,?,'','encrypted-private-data',?)").run(conversation, target.account.id, now).lastInsertRowid);
  const privateInput = { ...input, source: 'dm', messageId: dm, messageText: 'Selected decrypted evidence' };
  await reporter.call('/message-reports', 'POST', privateInput, 400);
  await outsider.call('/message-reports', 'POST', { ...privateInput, shareMessage: true }, 404);
  const privateReport = await reporter.call('/message-reports', 'POST', { ...privateInput, shareMessage: true }, 201);
  queue = await reviewer.call('/moderation/reports'); assert.equal(queue.reports[0].id, privateReport.id);
  assert.equal(queue.reports[0].evidence, 'Selected decrypted evidence'); assert.match(queue.reports[0].evidenceKind, /reporter-provided/);
  db.prepare('UPDATE conversation_members SET joined_after_message_id=? WHERE conversation_id=? AND user_id=?').run(dm, conversation, reporter.account.id);
  await reporter.call('/message-reports', 'POST', { ...privateInput, shareMessage: true }, 404);
  db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(now, dm);
  await target.call('/message-reports', 'POST', { ...privateInput, shareMessage: true }, 404);
  const restrictPath = `/moderation/reports/${report.id}/restrict`;
  await outsider.call(restrictPath, 'POST', { durationSeconds: 3600, reason: 'Harassment' }, 403);
  for (const durationSeconds of [0, 59, -1, 60.5, 315360001]) await reviewer.call(restrictPath, 'POST', { durationSeconds, reason: 'Harassment' }, 400);
  const realtime = await connectRealtime(target.cookie);
  const restricted = await reviewer.call(restrictPath, 'POST', { durationSeconds: 604800, reason: 'Repeated harassment' });
  for (let i = 0; !realtime.events.some(event => event.event === 'account-restricted'); i++) { assert.ok(i < 50, 'restriction delivered on existing socket'); await pause(20); }
  realtime.events.length = 0; realtime.send('typing', { conversationId: conversation, typing: true });
  for (let i = 0; !realtime.events.some(event => event.event === 'account-restricted'); i++) { assert.ok(i < 50, 'restricted realtime activity rejected'); await pause(20); }
  socket.destroy(); socket = null;
  assert.ok(Date.parse(restricted.restrictedUntil) > Date.now() + 604790000);
  assert.equal((await reviewer.call(restrictPath, 'POST', { durationSeconds: 60, reason: 'Repeated harassment' })).restrictedUntil, restricted.restrictedUntil, 'cannot shorten an existing restriction');
  assert.equal((await target.call('/account/restriction')).restriction.reason, 'Repeated harassment');
  for (const path of [`/channels/${channel}/messages`, `/conversations/${conversation}/messages`, '/conversations/groups', '/loop/posts', '/auth/username']) await target.call(path, 'POST', { body: 'Blocked', username: 'RenamedTarget' }, 403);
  await target.call('/message-reports', 'POST', { ...input, reason: 'Other' }, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_restriction_audit').get().n, 2);
  const dismissPath = `/moderation/reports/${privateReport.id}/dismiss`;
  assert.equal((await fetch(origin + '/api/v1' + dismissPath, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  await reporter.call(dismissPath, 'POST', {}, 403);
  await outsider.call(dismissPath, 'POST', {}, 403);
  await reviewer.call(dismissPath, 'GET', undefined, 405);
  await reviewer.call('/moderation/reports/999999/dismiss', 'POST', {}, 404);
  await reviewer.call('/moderation/reports/9007199254740992/dismiss', 'POST', {}, 400);
  const evidenceBefore = db.prepare('SELECT * FROM message_reports WHERE id=?').get(privateReport.id);
  const restrictionBefore = db.prepare('SELECT * FROM account_restrictions WHERE user_id=?').get(target.account.id);
  const dismissed = await reviewer.call(dismissPath, 'POST', {});
  assert.equal(dismissed.id, privateReport.id); assert.ok(Date.parse(dismissed.dismissedAt));
  assert.deepEqual(await owner.call(dismissPath, 'POST', {}), dismissed, 'dismissal is idempotent across reviewers');
  assert.equal(db.prepare('SELECT reviewer_id FROM message_report_dismissals WHERE report_id=?').get(privateReport.id).reviewer_id, reviewer.account.id, 'original reviewer retained');
  assert.deepEqual(db.prepare('SELECT * FROM message_reports WHERE id=?').get(privateReport.id), evidenceBefore, 'dismissal preserves evidence');
  assert.deepEqual(db.prepare('SELECT * FROM account_restrictions WHERE user_id=?').get(target.account.id), restrictionBefore, 'dismissal never changes restrictions');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_restriction_audit').get().n, 2);
  queue = await reviewer.call('/moderation/reports');
  assert.deepEqual(queue.reports.map(item => item.id), [report.id], 'only selected report leaves queue');
  await reviewer.call(`/moderation/reports/${privateReport.id}/restrict`, 'POST', { durationSeconds: 3600, reason: 'Stale UI' }, 409);
  db.prepare('UPDATE messages SET deleted_at=NULL WHERE id=?').run(dm);
  db.prepare('UPDATE conversation_members SET joined_after_message_id=0 WHERE conversation_id=? AND user_id=?').run(conversation, reporter.account.id);
  assert.equal((await reporter.call('/message-reports', 'POST', { ...privateInput, shareMessage: true })).id, privateReport.id);
  assert.equal((await reviewer.call('/moderation/reports')).reports.length, 1, 'duplicate submission does not reopen dismissed report');
  server.kill('SIGTERM'); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve)); server = start(); await ready();
  assert.equal((await target.call('/account/restriction')).restriction.until, restricted.restrictedUntil, 'restriction survives restart');
  assert.equal((await reviewer.call('/moderation/reports')).reports.length, 1, 'dismissal survives restart');
  assert.deepEqual(await reviewer.call(dismissPath, 'POST', {}), dismissed);
  db.prepare('UPDATE account_restrictions SET until=? WHERE user_id=?').run('2020-01-01T00:00:00.000Z', target.account.id);
  assert.equal((await target.call('/account/restriction')).restriction, null);
  await target.call(`/channels/${channel}/messages`, 'POST', { body: 'Restriction expired' }, 201);
  const insert = db.prepare('INSERT INTO message_reports(reporter_id,target_id,source,message_id,location_id,reason,details,evidence,evidence_kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 51; i++) insert.run(reporter.account.id, target.account.id, 'channel', message + 1000 + i, channel, 'Spam', '', 'pagination evidence', 'server-recorded message', now);
  queue = await reviewer.call('/moderation/reports'); assert.equal(queue.reports.length, 50); assert.ok(queue.nextCursor);
  const rest = await reviewer.call(`/moderation/reports?before=${queue.nextCursor}`); assert.equal(rest.reports.length, 2); assert.equal(rest.nextCursor, null);
  assert.ok(![...queue.reports, ...rest.reports].some(item => item.id === privateReport.id), 'pagination excludes dismissed reports');
  await reporter.call('/message-reports', 'POST', { ...input, messageId: message + 1 }, 429);
  db.prepare('UPDATE server_members SET role_id=(SELECT id FROM server_roles WHERE server_id=? AND permissions=\'member\' LIMIT 1) WHERE server_id=? AND user_id=?').run(official, official, reviewer.account.id);
  await reviewer.call('/moderation/reports', 'GET', undefined, 403); await reviewer.call(restrictPath, 'POST', { durationSeconds: 60, reason: 'No longer allowed' }, 403);
  await reviewer.call(dismissPath, 'POST', {}, 403);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log('PASS reports: official-role authorization/revocation, selected DM consent/evidence, deleted/pre-join protection, duplicate/block, rate limit, active cursor pagination, audited restrictions/expiration, idempotent audited dismissals, preserved evidence/restrictions, stale-action rejection and restart persistence.');
} finally {
  socket?.destroy(); db?.close(); server.kill('SIGTERM'); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve)); await rm(dir, { recursive: true, force: true });
}
