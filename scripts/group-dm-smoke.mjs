import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { TERMS_VERSION, CONDUCT_VERSION } from '../src/app/agreements.js';
import { apiRoutes } from '../src/app/apiRoutes.js';

const root = new URL('../', import.meta.url).pathname, dir = await mkdtemp('/tmp/glean-group-dm-smoke-');
const origin = 'http://127.0.0.1:5392';
const boot = new DatabaseSync(join(dir, 'glean-auth.sqlite'));
boot.exec("CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; INSERT INTO platform_settings VALUES('allow_school_hours','1')"); boot.close();
let logs = '', db;
const startServer = () => {
  const processHandle = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, GLEAN_DATA_DIR: dir, PORT: '5392', NODE_ENV: 'production', GROQ_API_KEY: '', GIPHY_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  processHandle.stderr.on('data', c => { logs = (logs + c).slice(-6000); }); processHandle.stdout.on('data', () => {});
  return processHandle;
};
let server = startServer();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = async () => {
  for (let i = 0; ; i++) { try { if ((await fetch(origin + '/api/health')).ok) break; } catch {} if (i > 80 || server.exitCode !== null) throw Error(logs || 'Server did not start'); await pause(100); }
};
try {
  await ready();
  db = new DatabaseSync(join(dir, 'glean-auth.sqlite'));
  const clients = [];
  for (const username of ['GroupOwnerQA', 'GroupMemberQA', 'GroupThirdQA', 'GroupLaterQA', 'GroupOutsiderQA']) {
    let cookie = '';
    const call = async (path, method = 'GET', body, expected = 200) => {
      const response = await fetch(origin + '/api/v1' + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`); return data;
    };
    const { account } = await call('/auth/signup', 'POST', { username, password: 'local-group-password-123' }, 201);
    db.prepare('INSERT INTO user_agreement_acceptances(user_id,terms_version,conduct_version,accepted_at) VALUES(?,?,?,?)').run(account.id, TERMS_VERSION, CONDUCT_VERSION, new Date().toISOString());
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    const fingerprint = createHash('sha256').update(JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y })).digest('hex').slice(0, 32);
    await call('/e2ee/key', 'PUT', { publicKey, fingerprint });
    clients.push({ account, call, identity: { accountId: account.id, publicKey, privateKey: pair.privateKey, fingerprint }, get cookie() { return cookie; } });
  }
  const [owner, member, third, later, outsider] = clients;
  const malformed = await fetch(origin + '/api/v1/conversations/groups', { method: 'POST', headers: { Origin: origin, Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400, 'malformed JSON is a client error');
  for (const target of [member, third, later]) db.prepare('INSERT INTO friendships(user_one_id,user_two_id,created_at) VALUES(?,?,?)').run(Math.min(owner.account.id, target.account.id), Math.max(owner.account.id, target.account.id), new Date().toISOString());
  const source = (await readFile(join(root, 'src/app/e2ee.js'), 'utf8')).replace("import { prepareUploadFiles } from './imageUpload';", 'const prepareUploadFiles = async files => files;').replace("import { apiRequest } from './apiClient';", 'const apiRequest = async () => {};');
  // The test has no browser vault: decryption uses the explicitly supplied account key.
  globalThis.indexedDB = { open() { const req = {}; queueMicrotask(() => { req.result = { objectStoreNames: { contains: () => true }, close() {}, transaction: () => ({ objectStore: () => ({ getAll: () => { const r = {}; queueMicrotask(() => { r.result = []; r.onsuccess?.(); }); return r; } }) }) }; req.onsuccess?.(); }); return req; } };
  const { prepareEncryptedMessage, decryptMessage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  await owner.call('/conversations/groups', 'POST', { name: '', memberIds: [member.account.id, third.account.id] }, 400);
  await owner.call('/conversations/groups', 'POST', { name: 'Invalid', memberIds: [member.account.id, member.account.id] }, 400);
  await owner.call('/conversations/groups', 'POST', { name: 'Invalid', memberIds: [member.account.id, outsider.account.id] }, 403);
  const { conversation } = await owner.call('/conversations/groups', 'POST', { name: 'Group test', memberIds: [member.account.id, third.account.id] }, 201);
  const id = conversation.id, path = `/conversations/${id}`;
  assert.equal(conversation.kind, 'group'); assert.equal(conversation.members.length, 3);
  const direct = (await owner.call(apiRoutes.directConversation(member.account.username), 'POST')).conversation;
  assert.notEqual(direct.id, id, 'group does not replace the existing one-to-one chat');
  for (const client of [owner, member, third]) assert.equal((await client.call('/conversations')).conversations.filter(c => c.id === id).length, 1);
  await outsider.call(path + '/group', 'GET', undefined, 404);
  await member.call(path + '/group', 'PATCH', { name: 'Not allowed' }, 403);
  await member.call(path + '/group/members', 'POST', { userId: later.account.id }, 403);
  await owner.call(path + '/messages', 'POST', { body: 'plaintext rejected' }, 409);
  const encrypted = await prepareEncryptedMessage(owner.identity, conversation, 'group secret one');
  const input = { envelope: encrypted.envelope, attachmentMeta: encrypted.attachmentMeta };
  const { message } = await owner.call(path + '/messages', 'POST', input, 201);
  assert.equal(message.crypto.version, 2); assert.equal(message.body, null);
  assert.equal(db.prepare('SELECT body FROM messages WHERE id=?').get(message.id).body, '');
  assert.equal((await owner.call(path + '/messages', 'POST', input)).message.id, message.id, 'idempotent retry');
  for (const client of [owner, member, third]) {
    const loaded = (await client.call(path + '/messages?limit=50')).messages;
    assert.equal((await decryptMessage(client.identity, loaded[0], id)).body, 'group secret one');
  }
  await outsider.call(path + '/messages', 'GET', undefined, 404);
  const uploaded = await prepareEncryptedMessage(owner.identity, conversation, 'private file', [new File(['secret attachment contents'], 'group-secret.txt', { type: 'text/plain' })]);
  const form = new FormData(); form.append('envelope', JSON.stringify(uploaded.envelope)); form.append('attachmentMeta', JSON.stringify(uploaded.attachmentMeta)); form.append('files', uploaded.encryptedFiles[0]);
  const fileMessage = (await owner.call(path + '/messages', 'POST', form, 201)).message;
  const attachmentId = fileMessage.attachments[0].id;
  const download = client => fetch(origin + `/api/v1/attachments/${attachmentId}`, { headers: { Cookie: client.cookie } });
  assert.equal((await download(member)).status, 200); assert.equal((await download(outsider)).status, 404);
  const fileBytes = Buffer.from(await (await download(member)).arrayBuffer()); assert.ok(!fileBytes.toString().includes('secret attachment contents'));
  const replyPayload = await prepareEncryptedMessage(third.identity, conversation, 'encrypted reply');
  const replyMessage = (await third.call(path + '/messages', 'POST', { envelope: replyPayload.envelope, replyToMessageId: message.id }, 201)).message;
  assert.equal((await decryptMessage(member.identity, replyMessage, id)).replyTo.body, 'group secret one');
  server.kill('SIGTERM'); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  server = startServer(); await ready();
  assert.equal((await member.call(path + '/group')).conversation.name, 'Group test');
  assert.equal((await decryptMessage(member.identity, (await member.call(path + '/messages?limit=50')).messages.at(-1), id)).body, 'encrypted reply', 'encrypted history survives server restart');
  const added = (await owner.call(path + '/group/members', 'POST', { userId: later.account.id })).conversation;
  assert.equal(added.revision, 2); assert.equal((await later.call(path + '/messages?limit=50')).messages.length, 0);
  assert.equal((await download(later)).status, 404, 'new member cannot fetch pre-join attachments');
  await owner.call(path + '/messages', 'POST', input, 409);
  const next = await prepareEncryptedMessage(owner.identity, added, 'after joining');
  const joined = (await owner.call(path + '/messages', 'POST', { envelope: next.envelope, replyToMessageId: message.id }, 201)).message;
  const visible = (await later.call(path + '/messages?limit=50')).messages; assert.equal(visible.length, 1); assert.equal(visible[0].id, joined.id);
  assert.equal((await decryptMessage(later.identity, visible[0], id)).body, 'after joining');
  assert.equal(visible[0].replyTo.crypto, undefined, 'pre-join reply content stays hidden');
  assert.equal((await decryptMessage(third.identity, joined, id)).replyTo.body, 'group secret one', 'original members retain encrypted reply access');
  await owner.call(path + `/group/members/${member.account.id}`, 'DELETE');
  await member.call(path + '/messages', 'GET', undefined, 404); assert.equal((await download(member)).status, 404);
  await member.call(path + '/messages', 'POST', input, 404);
  await owner.call(path + '/group', 'PATCH', { name: 'Renamed group' });
  assert.equal((await third.call(path + '/group')).conversation.name, 'Renamed group');
  await owner.call(path + '/messages/' + message.id, 'DELETE');
  await owner.call('/account', 'DELETE', { password: 'local-group-password-123' });
  const transferred = (await third.call(path + '/group')).conversation; assert.equal(transferred.ownerId, third.account.id, 'account deletion transfers ownership and preserves shared group');
  const afterDelete = await prepareEncryptedMessage(third.identity, transferred, 'history after account deletion');
  const finalMessage = (await third.call(path + '/messages', 'POST', { envelope: afterDelete.envelope }, 201)).message;
  assert.ok(finalMessage.id > joined.id, 'message IDs remain monotonic after deletion');
  const finalHistory = (await later.call(path + '/messages?limit=50')).messages;
  assert.equal((await decryptMessage(later.identity, finalHistory.at(-1), id)).body, 'history after account deletion');
  const lastFile = await prepareEncryptedMessage(third.identity, transferred, 'cleanup file', [new File(['delete when the group is empty'], 'cleanup.txt', { type: 'text/plain' })]);
  const lastForm = new FormData(); lastForm.append('envelope', JSON.stringify(lastFile.envelope)); lastForm.append('attachmentMeta', JSON.stringify(lastFile.attachmentMeta)); lastForm.append('files', lastFile.encryptedFiles[0]);
  const lastUpload = (await third.call(path + '/messages', 'POST', lastForm, 201)).message;
  const storedPath = join(dir, 'uploads', db.prepare('SELECT storage_name FROM message_attachments WHERE id=?').get(lastUpload.attachments[0].id).storage_name);
  await access(storedPath);
  await third.call(path + '/group/leave', 'POST', {});
  assert.equal((await later.call(path + '/group')).conversation.ownerId, later.account.id);
  await later.call(path + '/group/leave', 'POST', {});
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM group_conversations WHERE conversation_id=?').get(id).count, 0);
  await assert.rejects(access(storedPath), { code: 'ENOENT' }, 'empty groups do not leak orphaned upload files');
  console.log('PASS group DM API: additive schema, friendship/owner/member authorization, encrypted messages/files, retries, join-history isolation, removal revocation, rename, account deletion, ownership transfer and leave.');
} finally {
  db?.close(); server.kill('SIGTERM'); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve)); await rm(dir, { recursive: true, force: true });
}
