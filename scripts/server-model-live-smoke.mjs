import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONDUCT_VERSION, TERMS_VERSION } from '../src/app/agreements.js';

if (!process.env.GROQ_API_KEY) throw new Error('A server-side model credential is required for live verification.');
const dataDir = mkdtempSync(join(tmpdir(), 'glean-model-live-'));
const database = new DatabaseSync(join(dataDir, 'glean-auth.sqlite'));
database.exec("CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO platform_settings VALUES ('allow_school_hours','1');");
database.close();
const port = 5199;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, NODE_ENV: 'production', GLEAN_TRUST_PROXY: '', HOST: '127.0.0.1', PORT: String(port), GLEAN_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (data) => { logs += data; }); child.stderr.on('data', (data) => { logs += data; });
function client() {
  let cookie = '';
  return async (path, method = 'GET', body) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = await response.json();
    if (!response.ok) throw new Error(`Verification ${method} ${path}: ${response.status} ${result.error}`);
    return result;
  };
}
async function signup(call, username) {
  const data = await call('/auth/signup', 'POST', { username, password: 'LiveModelQA2026!' });
  const agreements = await call('/account/agreements');
  await new Promise((done) => setTimeout(done, agreements.waitSeconds * 1000 + 50));
  await call('/account/agreements', 'POST', { termsVersion: TERMS_VERSION, conductVersion: CONDUCT_VERSION, termsAccepted: true, conductAccepted: true });
  return data.account;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error('Isolated verification server failed to start.');
    try { if ((await fetch(`${base}/api/v1/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready);
  const owner = client(), member = client();
  await signup(owner, 'model_live_owner');
  const person = await signup(member, 'model_live_member');
  const { server } = await owner('/servers', 'POST', { name: 'Live model verification' });
  await owner(`/servers/${server.id}`, 'PATCH', { moderationEnabled: false });
  const { invite } = await owner(`/servers/${server.id}/invites`, 'POST', {});
  await member(`/invites/${invite.code}/join`, 'POST', {});
  const started = Date.now();
  const { plan } = await owner(`/servers/${server.id}/model`, 'POST', { prompt: 'Make exactly these changes: set my server description to "Built with ML model"; create a member role called Helpers with hex color #35aa77 and no moderator permissions; assign model_live_member to Helpers; create a text channel called support; set support slowmode to 10 seconds and allow anyone to post; create a voice channel called lounge; post "welcome @model_live_member" in support. Keep moderation off. Do not change any other settings.' });
  assert.ok(plan.actions.length >= 5, 'The model should produce the requested server changes.');
  const result = await owner(`/servers/${server.id}/model/${plan.id}/apply`, 'POST', {});
  assert.equal(result.plan.state, 'done', JSON.stringify(result.plan.results));
  const current = (await owner(`/servers/${server.id}`)).server;
  assert.equal(current.description, 'Built with ML model');
  const helpers = current.roles.find((role) => role.name === 'Helpers');
  assert.ok(helpers); assert.equal(helpers.permissions, 'member'); assert.equal(helpers.color, '#35aa77');
  assert.equal(current.members.find((entry) => entry.id === person.id).roleId, helpers.id);
  const support = current.channels.find((entry) => entry.name === 'support');
  assert.ok(support); assert.equal(support.voice, false); assert.equal(support.slowmode, 10); assert.equal(support.locked, false);
  assert.equal(current.channels.find((entry) => entry.name === 'lounge')?.voice, true);
  const messages = await owner(`/channels/${support.id}/messages`);
  assert.ok(messages.messages.some((message) => message.body === 'welcome @model_live_member'));
  const repeated = await owner(`/servers/${server.id}/model/${plan.id}/apply`, 'POST', {});
  assert.equal(repeated.plan.state, 'done');
  assert.equal((await owner(`/channels/${support.id}/messages`)).messages.length, messages.messages.length);
  const { plan: staffPlan } = await owner(`/servers/${server.id}/model`, 'POST', { prompt: 'Create a moderator role called Moderators, color #4d7cff, with exactly manageMessages and manageMembers permission flags. Create an announcement channel called updates and a rules channel called guidelines. Set the server name to "Model configured community", make it public and enable moderation. Do not make any other changes.' });
  const staffResult = await owner(`/servers/${server.id}/model/${staffPlan.id}/apply`, 'POST', {});
  assert.equal(staffResult.plan.state, 'done', JSON.stringify(staffResult.plan.results));
  const staffServer = (await owner(`/servers/${server.id}`)).server;
  assert.equal(staffServer.name, 'Model configured community');
  assert.equal(staffServer.isPublic, true);
  assert.equal(staffServer.moderationEnabled, true);
  const moderator = staffServer.roles.find((role) => role.name === 'Moderators');
  assert.equal(moderator?.permissions, 'moderator');
  assert.deepEqual([...moderator.permissionFlags].sort(), ['manageMembers', 'manageMessages']);
  assert.equal(staffServer.channels.find((channel) => channel.name === 'updates')?.kind, 'announcement');
  assert.equal(staffServer.channels.find((channel) => channel.name === 'guidelines')?.kind, 'rules');
  const { plan: question } = await owner(`/servers/${server.id}/model`, 'POST', { prompt: 'What is my server description? Answer only, do not propose any changes.' });
  assert.equal(question.actions.length, 0, 'A question must not mutate the server.');
  const { server: bulkServer } = await owner('/servers', 'POST', { name: 'Live 200 change verification', moderationEnabled: false });
  const channelNames = Array.from({ length: 200 }, (_, index) => `batch-${index + 1}`);
  const { plan: bulkPlan } = await owner(`/servers/${bulkServer.id}/model`, 'POST', { prompt: `Create exactly 200 text channels with these exact names: ${channelNames.join(', ')}. Do not omit any channel or make any other changes.` });
  assert.equal(bulkPlan.actions.length, 200, 'Live provider must produce all 200 requested actions.');
  assert.ok(bulkPlan.actions.every(action => action.type === 'create_channel' && action.channelType === 'text'));
  assert.deepEqual(bulkPlan.actions.map(action => action.name).sort(), [...channelNames].sort());
  const bulkResult = await owner(`/servers/${bulkServer.id}/model/${bulkPlan.id}/apply`, 'POST', {});
  assert.equal(bulkResult.plan.state, 'done', JSON.stringify(bulkResult.plan.results));
  assert.equal(bulkResult.plan.results.length, 200);
  const bulkCurrent = (await owner(`/servers/${bulkServer.id}`)).server;
  assert.equal(bulkCurrent.channels.filter(channel => channelNames.includes(channel.name)).length, 200);
  console.log('PASS: live Groq generated and applied all 200 requested channel changes with isolated data.');
  console.log(`PASS: live model produced and applied ${plan.actions.length} changes in ${Date.now() - started}ms; roles, member assignment, channel permissions, voice, slowmode, message mention and replay verified using isolated data.`);
  console.log('PASS: live moderator flags, announcement/rules channels, public visibility, moderation, server rename and read-only questions.');
} catch (error) {
  console.error('Isolated server output:', logs.slice(-1500));
  throw error;
} finally {
  child.kill('SIGTERM');
  await new Promise((done) => { if (child.exitCode !== null) done(); else child.once('close', done); });
}
