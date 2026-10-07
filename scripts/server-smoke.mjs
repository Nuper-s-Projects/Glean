import { parseInviteInput } from '../src/app/invite.js';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { CONDUCT_VERSION, TERMS_VERSION } from '../src/app/agreements.js';

const port = 5300 + Math.floor(Math.random() * 500);
const dataDir = mkdtempSync(join(tmpdir(), 'glean-test-'));
const testDatabase = new DatabaseSync(join(dataDir, 'glean-auth.sqlite'));
testDatabase.exec("CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO platform_settings (key, value) VALUES ('allow_school_hours', '1');");
testDatabase.close();
const base = `http://127.0.0.1:${port}/api/v1`;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, GROQ_API_KEY: '', NODE_ENV: 'production', PORT: String(port), GLEAN_DATA_DIR: dataDir, GLEAN_TURN_URLS: 'turn:turn.example.test:3478?transport=udp,turn:turn.example.test:3478?transport=tcp', GLEAN_TURN_SECRET: 'smoke-test-turn-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function fingerprint(jwk) {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('hex').slice(0, 32);
}
async function publicKey() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return webcrypto.subtle.exportKey('jwk', pair.publicKey);
}
async function makeClient(accessToken = '') {
  let cookie = '';
  const call = async (path, options = {}) => {
    const { omitOrigin = false, ...fetchOptions } = options;
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const method = String(options.method || 'GET').toUpperCase();
    const response = await fetch(`${base}${path}`, {
      ...fetchOptions,
      headers: {
        ...(!omitOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { Origin: new URL(base).origin } : {}),
        ...(isForm ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(payload)}`);
    return payload;
  };
  call.raw = async (path, options = {}) => {
    const { omitOrigin = false, ...fetchOptions } = options;
    const method = String(options.method || 'GET').toUpperCase();
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const response = await fetch(`${base}${path}`, {
      ...fetchOptions,
      headers: {
        ...(!omitOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { Origin: new URL(base).origin } : {}),
        ...(isForm ? {} : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  Object.defineProperty(call, 'cookie', { get: () => cookie });
  return call;
}

async function acceptCurrentAgreements(client) {
  const challenge = await client('/account/agreements');
  await new Promise((resolve) => setTimeout(resolve, challenge.waitSeconds * 1000 + 50));
  return client('/account/agreements', {
    method: 'POST',
    body: JSON.stringify({ termsVersion: TERMS_VERSION, conductVersion: CONDUCT_VERSION, termsAccepted: true, conductAccepted: true }),
  });
}

function encodeClientFrame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | body.length;
    mask.copy(header, 2);
  } else {
    header = Buffer.alloc(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
    mask.copy(header, 4);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, masked]);
}

function openRealtime(auth, useBearer = false, { origin = true } = {}) {
  return new Promise((resolve, reject) => {
    const key = Buffer.alloc(16, 7).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/v1/realtime',
      headers: {
        ...(useBearer ? { Authorization: `Bearer ${auth}` } : { Cookie: auth }),
        ...(origin ? { Origin: origin === true ? `http://127.0.0.1:${port}` : origin } : {}),
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    req.on('upgrade', (_res, socket, head) => {
      const inbox = [];
      const waiters = [];
      let pending = Buffer.alloc(0);
      const take = (event, predicate = () => true) => {
        const index = inbox.findIndex((item) => item.event === event && predicate(item));
        if (index < 0) return null;
        return inbox.splice(index, 1)[0];
      };
      const onChunk = (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        let offset = 0;
        while (offset + 2 <= pending.length) {
          const second = pending[offset + 1];
          const opcode = pending[offset] & 0x0f;
          let length = second & 0x7f;
          let cursor = offset + 2;
          if (length === 126) {
            if (cursor + 2 > pending.length) break;
            length = pending.readUInt16BE(cursor);
            cursor += 2;
          } else if (length === 127) {
            if (cursor + 8 > pending.length) break;
            length = Number(pending.readBigUInt64BE(cursor));
            cursor += 8;
          }
          if (cursor + length > pending.length) break;
          const frameBody = pending.subarray(cursor, cursor + length);
          const payload = frameBody.toString('utf8');
          offset = cursor + length;
          if (opcode === 0x9) {
            socket.write(encodeClientFrame(frameBody, 0xA));
            continue;
          }
          if (opcode !== 0x1) continue;
          let message;
          try { message = JSON.parse(payload); } catch { continue; }
          const waiter = waiters.find((item) => item.event === message.event && item.predicate(message));
          if (waiter) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          } else inbox.push(message);
        }
        pending = pending.subarray(offset);
      };
      socket.on('data', onChunk);
      if (head?.length) onChunk(head);
      socket.resume();
      resolve({
        send(event, payload) {
          socket.write(encodeClientFrame(JSON.stringify({ event, payload })));
        },
        async sendFragmented(event, payload) {
          const frame = encodeClientFrame(JSON.stringify({ event, payload }));
          const splitAt = Math.max(1, Math.floor(frame.length / 2));
          socket.write(frame.subarray(0, splitAt));
          await new Promise((resolve) => setTimeout(resolve, 10));
          socket.write(frame.subarray(splitAt));
        },
        wait(event, timeout = 2500, predicate = () => true) {
          const existing = take(event, predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((ok, fail) => {
            const timer = setTimeout(() => fail(new Error(`timeout waiting for ${event}`)), timeout);
            waiters.push({ event, predicate, resolve: (message) => { clearTimeout(timer); ok(message); } });
          });
        },
        close() { socket.end(encodeClientFrame(Buffer.alloc(0), 0x8)); },
      });
    });
    req.on('error', reject);
    req.on('response', (res) => reject(new Error(`realtime http ${res.statusCode}`)));
    req.end();
  });
}
async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Glean server did not start.');
}

let bobServerRealtime = null;
try {
  await waitForServer();
  const apiRoot = await fetch(base);
  const apiMetadata = await apiRoot.json();
  if (!apiRoot.ok || apiMetadata.baseUrl !== '/api/v1' || apiMetadata.routes?.servers !== '/api/v1/servers') throw new Error('API root metadata is not routable.');
  const alice = await makeClient();
  const bob = await makeClient();
  const aliceSignup = await alice('/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'alice_test', password: 'correct-horse-123' }) });
  await acceptCurrentAgreements(alice);
  const voiceIce = await alice('/voice/ice-servers');
  const turnServer = voiceIce.iceServers?.find((item) => item.urls?.some((url) => url.startsWith('turn:')));
  const turnExpiry = Number(turnServer?.username?.split(':')[0]);
  const turnCredential = createHmac('sha1', 'smoke-test-turn-secret').update(turnServer?.username || '').digest('base64');
  if (!turnServer || !turnServer.username.endsWith(`:${aliceSignup.account.id}`) || turnServer.credential !== turnCredential || turnExpiry <= Math.floor(Date.now() / 1000) || turnExpiry > Math.floor(Date.now() / 1000) + 3601) throw new Error('Authenticated short-lived TURN credentials were not returned for voice.');
  const originlessSignOut = await alice.raw('/auth/signout', { method: 'POST', omitOrigin: true });
  if (originlessSignOut.status !== 403) throw new Error('Cookie-authenticated originless mutation was not blocked.');
  const crossOriginSignOut = await alice.raw('/auth/signout', { method: 'POST', headers: { Origin: 'https://attacker.example' } });
  if (crossOriginSignOut.status !== 403) throw new Error('Cross-origin cookie mutation was not blocked.');
  if (!(await alice('/auth/me')).account) throw new Error('Rejected sign-out attempts invalidated Alice’s session.');
  if (!aliceSignup.accessToken || aliceSignup.tokenType !== 'Bearer' || !aliceSignup.expiresAt) throw new Error('Bearer sign-in token is missing.');
  const bearerAlice = await makeClient(aliceSignup.accessToken);
  const bearerMe = await bearerAlice('/auth/me');
  if (bearerMe.account?.username !== 'alice_test') throw new Error('Bearer REST authentication failed.');
  const badgeSave = await alice('/account/custom-badges', { method: 'POST', body: JSON.stringify({ customBadges: [{ label: 'OM', color: '#C65A13' }] }) });
  if (badgeSave.account?.customBadges?.[0]?.label !== 'OM' || badgeSave.account.customBadges[0].color !== '#C65A13') throw new Error('Custom badge save failed.');
  const invalidBadge = await alice.raw('/account/custom-badges', { method: 'POST', body: JSON.stringify({ customBadges: [{ label: 'Bad', color: 'orange' }] }) });
  if (invalidBadge.status !== 400) throw new Error('Invalid custom badge color should fail.');
  if (aliceSignup.account?.accessibility?.theme !== 'system' || aliceSignup.account?.accessibility?.contrast !== 100 || aliceSignup.account?.accessibility?.saturation !== 100 || aliceSignup.account?.accessibility?.glassDepth !== 20 || aliceSignup.account?.accessibility?.glassRefraction !== 100) throw new Error('Accessibility defaults missing from account.');
  const savedAccessibility = await alice('/account/accessibility', { method: 'POST', body: JSON.stringify({ contrast: 125, saturation: 65, reduceMotion: true, glassFrost: 60, glassDepth: 35, glassRefraction: 72, theme: 'dark' }) });
  if (savedAccessibility.account?.accessibility?.theme !== 'dark' || savedAccessibility.account?.accessibility?.contrast !== 125 || savedAccessibility.account?.accessibility?.saturation !== 65 || savedAccessibility.account?.accessibility?.reduceMotion !== true || savedAccessibility.account?.accessibility?.glassDepth !== 35 || savedAccessibility.account?.accessibility?.glassRefraction !== 72) throw new Error('Accessibility preferences did not save.');
  const reloadedAlice = await makeClient();
  await reloadedAlice('/auth/signin', { method: 'POST', body: JSON.stringify({ username: 'alice_test', password: 'correct-horse-123' }) });
  const reloadedPreferences = await reloadedAlice('/auth/me');
  if (reloadedPreferences.account?.accessibility?.theme !== 'dark' || reloadedPreferences.account?.accessibility?.contrast !== 125 || reloadedPreferences.account?.accessibility?.saturation !== 65 || reloadedPreferences.account?.accessibility?.reduceMotion !== true || reloadedPreferences.account?.accessibility?.glassDepth !== 35 || reloadedPreferences.account?.accessibility?.glassRefraction !== 72) throw new Error('Accessibility preferences did not persist through sign-in.');
  const invalidAccessibility = await alice.raw('/account/accessibility', { method: 'POST', body: JSON.stringify({ contrast: 151, saturation: 65, reduceMotion: true }) });
  if (invalidAccessibility.status !== 400) throw new Error('Out-of-range accessibility settings should be rejected.');
  const invalidGlassOptics = await alice.raw('/account/accessibility', { method: 'POST', body: JSON.stringify({ contrast: 100, saturation: 100, reduceMotion: false, glassDepth: 101, glassRefraction: 50 }) });
  if (invalidGlassOptics.status !== 400) throw new Error('Out-of-range glass optics settings should be rejected.');
  const invalidTheme = await alice.raw('/account/accessibility', { method: 'POST', body: JSON.stringify({ contrast: 100, saturation: 100, reduceMotion: false, theme: 'sepia' }) });
  if (invalidTheme.status !== 400) throw new Error('Unsupported accessibility theme should be rejected.');
  if (aliceSignup.account?.grade != null || aliceSignup.account?.school != null) throw new Error('Signup should omit grade and school.');
  if (aliceSignup.account?.programAnswered) throw new Error('Signup should leave programs unanswered.');
  if (aliceSignup.account?.discordUsername) throw new Error('Signup should omit Discord username.');
  try {
    await alice('/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'alice_dup', password: 'correct-horse-123', grade: '11', school: 'united-ms' }) });
    throw new Error('High-school grade with middle school should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const aliceGrade = await alice('/account/grade', { method: 'POST', body: JSON.stringify({ grade: '11' }) });
  if (aliceGrade.account?.grade !== '11' || aliceGrade.account?.gradeLabel !== '11th grade') throw new Error('Post-signup grade missing.');
  const aliceSchool = await alice('/account/school', { method: 'POST', body: JSON.stringify({ school: 'united-hs' }) });
  if (aliceSchool.account?.school !== 'united-hs' || aliceSchool.account?.schoolLabel !== 'United High' || aliceSchool.account?.schoolHex?.[0] !== '#E87722') throw new Error('Post-signup school badge missing.');
  await bob('/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'bob_test', password: 'correct-horse-456' }) });
  await acceptCurrentAgreements(bob);
  const badgeProfile = await bob('/users/alice_test');
  if (badgeProfile.user?.customBadges?.[0]?.label !== 'OM') throw new Error('Custom badge missing from public profile.');
  const badgePeople = await bob('/people');
  if (!badgePeople.people?.find((item) => item.username === 'alice_test')?.customBadges?.length) throw new Error('Custom badge missing from people list.');
  await bob('/account/grade', { method: 'POST', body: JSON.stringify({ grade: 'below_hs' }) });
  await bob('/account/school', { method: 'POST', body: JSON.stringify({ school: 'no_response' }) });
  const unicodeUsername = 'Nuper✨';
  const unicode = await makeClient();
  const unicodeSignup = await unicode('/auth/signup', { method: 'POST', body: JSON.stringify({ username: unicodeUsername, password: 'correct-horse-emoji' }) });
  await acceptCurrentAgreements(unicode);
  if (unicodeSignup.account?.username !== unicodeUsername) throw new Error('Unicode username signup failed.');
  const unicodeSignin = await makeClient();
  await unicodeSignin('/auth/signin', { method: 'POST', body: JSON.stringify({ username: unicodeUsername, password: 'correct-horse-emoji' }) });
  const unicodeMe = await unicodeSignin('/auth/me');
  if (unicodeMe.account?.username !== unicodeUsername) throw new Error('Unicode username sign-in failed.');
  const invalidUsernameClient = await makeClient();
  try {
    await invalidUsernameClient('/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'bad name', password: 'correct-horse-invalid' }) });
    throw new Error('Username with spaces should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const unicodeProfile = await alice(`/users/${encodeURIComponent(unicodeUsername)}`);
  if (unicodeProfile.user?.username !== unicodeUsername) throw new Error('Unicode username profile lookup failed.');
  await alice('/friends/requests', { method: 'POST', body: JSON.stringify({ username: unicodeUsername }) });
  const unicodeFriends = await unicode('/friends');
  const unicodeRequest = unicodeFriends.requests?.find((item) => item.user?.username === 'alice_test');
  if (!unicodeRequest) throw new Error('Unicode username friend request missing.');
  await unicode(`/friends/requests/${unicodeRequest.id}/accept`, { method: 'POST', body: '{}' });
  const unicodeConversation = await alice(`/conversations/direct/${encodeURIComponent(unicodeUsername)}`, { method: 'POST', body: '{}' });
  if (unicodeConversation.conversation?.user?.username !== unicodeUsername) throw new Error('Unicode username DM lookup failed.');
  await alice(`/friends/${encodeURIComponent(unicodeUsername)}`, { method: 'DELETE' });
  const aliceKey = await publicKey();
  const bobPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bobKey = await webcrypto.subtle.exportKey('jwk', bobPair.publicKey);
  const bobPrivateKey = await webcrypto.subtle.exportKey('jwk', bobPair.privateKey);
  const aliceKeyRegistration = await alice('/e2ee/key', { method: 'PUT', body: JSON.stringify({ publicKey: aliceKey, fingerprint: fingerprint(aliceKey) }) });
  if (aliceKeyRegistration.changed) throw new Error('First encryption key registration must not report a key change.');
  const reorderedAliceKey = Object.fromEntries(Object.entries(aliceKey).reverse());
  const stableAliceKeyRegistration = await alice('/e2ee/key', { method: 'PUT', body: JSON.stringify({ publicKey: reorderedAliceKey, fingerprint: fingerprint(aliceKey) }) });
  if (stableAliceKeyRegistration.changed) throw new Error('Re-registering the same encryption key in a different property order must not report a change.');
  await bob('/e2ee/key', { method: 'PUT', body: JSON.stringify({ publicKey: bobKey, fingerprint: fingerprint(bobKey) }) });
  const vaultKeyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const vaultKey = await webcrypto.subtle.importKey('raw', vaultKeyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const vaultIV = webcrypto.getRandomValues(new Uint8Array(12));
  const bobID = (await bob('/auth/me')).account.id;
  const vaultAAD = new TextEncoder().encode(`glean-key-sync-v1:${bobID}`);
  const vaultClear = JSON.stringify({ activeFingerprint: fingerprint(bobKey), identities: [{ fingerprint: fingerprint(bobKey), publicKey: bobKey, privateJwk: bobPrivateKey }] });
  const vaultCiphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: vaultIV, additionalData: vaultAAD }, vaultKey, new TextEncoder().encode(vaultClear));
  const vaultEnvelope = { version: 1, iv: Buffer.from(vaultIV).toString('base64url'), ciphertext: Buffer.from(vaultCiphertext).toString('base64url') };
  if ((await bob('/e2ee/sync')).revision !== 0) throw new Error('New account has a key vault.');
  const synced = await bob('/e2ee/sync', { method: 'PUT', body: JSON.stringify({ revision: 0, publicKey: bobKey, envelope: vaultEnvelope }) });
  if (synced.revision !== 1) throw new Error('Key vault creation failed.');
  const secondBobDevice = await makeClient();
  await secondBobDevice('/auth/signin', { method: 'POST', body: JSON.stringify({ username: 'bob_test', password: 'correct-horse-456' }) });
  const fetchedVault = await secondBobDevice('/e2ee/sync');
  if (fingerprint(fetchedVault.publicKey) !== fingerprint(bobKey)) throw new Error('Key vault omitted the active public key needed to restore existing devices.');
  const restoredVault = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(fetchedVault.envelope.iv, 'base64url'), additionalData: vaultAAD }, vaultKey, Buffer.from(fetchedVault.envelope.ciphertext, 'base64url'));
  if (new TextDecoder().decode(restoredVault) !== vaultClear) throw new Error('Cross-device encrypted vault restore failed.');
  if ((await alice('/e2ee/sync')).envelope !== null) throw new Error('Key vault leaked across accounts.');
  const staleVault = await bob.raw('/e2ee/sync', { method: 'PUT', body: JSON.stringify({ revision: 0, publicKey: bobKey, envelope: vaultEnvelope }) });
  if (staleVault.status !== 409) throw new Error('Concurrent key vault updates were not protected.');
  const savedRevision = await secondBobDevice('/e2ee/sync', { method: 'PUT', body: JSON.stringify({ revision: 1, publicKey: bobKey, envelope: vaultEnvelope }) });
  if (savedRevision.revision !== 2) throw new Error('Key vault merge revision failed.');
  const replacementKey = await publicKey();
  const incompatibleKey = await bob.raw('/e2ee/key', { method: 'PUT', body: JSON.stringify({ publicKey: replacementKey }) });
  if (incompatibleKey.status !== 409) throw new Error('Unlinked device replaced synced encryption key.');
  const badVault = await bob.raw('/e2ee/sync', { method: 'PUT', body: JSON.stringify({ revision: 1, publicKey: bobKey, envelope: { version: 1, iv: 'bad', ciphertext: 'bad' } }) });
  if (badVault.status !== 400) throw new Error('Invalid encrypted vault was accepted.');
  await alice('/friends/requests', { method: 'POST', body: JSON.stringify({ username: 'bob_test' }) });
  const aliceFriends = await alice('/friends');
  if (!aliceFriends.sent?.some((item) => item.user?.username === 'bob_test')) throw new Error('Sent friend requests missing.');
  const directory = await alice('/people');
  const bobRow = directory.people?.find((item) => item.username === 'bob_test');
  if (!bobRow || bobRow.relation !== 'outgoing') throw new Error('Discover people list missing outgoing request.');
  const requests = await bob('/friends');
  await bob(`/friends/requests/${requests.requests[0].id}/accept`, { method: 'POST', body: '{}' });
  const { conversation } = await alice('/conversations/direct/bob_test', { method: 'POST', body: '{}' });
  const envelope = {
    version: 1,
    clientMessageId: 'smoketestmessageid1234567890',
    ciphertext: 'AAECAwQFBgcICQoLDA0ODw',
    iv: 'AAECAwQFBgcICQoL',
    salt: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    senderPublicKey: aliceKey,
    recipientPublicKey: bobKey,
  };
  await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ envelope, attachmentMeta: [] }) });
  const bobUnread = await bob('/conversations');
  const bobThread = bobUnread.conversations?.find((item) => item.id === conversation.id);
  if (!bobThread || bobThread.unreadCount !== 1) throw new Error('DM unread missing.');
  const aliceUnread = await alice('/conversations');
  if (aliceUnread.conversations?.find((item) => item.id === conversation.id)?.unreadCount) throw new Error('Sender DM unread should be 0.');
  const result = await bob(`/conversations/${conversation.id}/messages?limit=50`);
  const message = result.messages[0];
  if (!message?.encrypted || message.body !== null || message.crypto?.ciphertext !== envelope.ciphertext) throw new Error('Encrypted DM contract failed.');
  const rotatedAliceKey = await publicKey();
  const rotatedAliceKeyRegistration = await alice('/e2ee/key', { method: 'PUT', body: JSON.stringify({ publicKey: rotatedAliceKey, fingerprint: fingerprint(rotatedAliceKey) }) });
  if (!rotatedAliceKeyRegistration.changed) throw new Error('A genuinely rotated encryption key must still report a key change.');
  const bobAfterOpen = await bob('/conversations');
  if (bobAfterOpen.conversations?.find((item) => item.id === conversation.id)?.unreadCount) throw new Error('Opening a DM should mark it read.');
  await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'second ping' }) });
  const bobSecond = await bob('/conversations');
  if (bobSecond.conversations?.find((item) => item.id === conversation.id)?.unreadCount !== 1) throw new Error('DM unread did not increment.');
  await bob(`/conversations/${conversation.id}/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: 999999 }) });
  const bobClearedDm = await bob('/conversations');
  if (bobClearedDm.conversations?.find((item) => item.id === conversation.id)?.unreadCount) throw new Error('DM mark-read failed.');
  const bobVaultBeforeReset = await bob('/e2ee/sync');
  const resetBobKey = await publicKey();
  const resetBobIV = webcrypto.getRandomValues(new Uint8Array(12));
  const resetBobEnvelope = { version: 1, iv: Buffer.from(resetBobIV).toString('base64url'), ciphertext: Buffer.from(webcrypto.getRandomValues(new Uint8Array(48))).toString('base64url') };
  const resetPayload = { password: 'correct-horse-456', revision: bobVaultBeforeReset.revision, publicKey: resetBobKey, fingerprint: fingerprint(resetBobKey), envelope: resetBobEnvelope };
  const wrongResetPassword = await bob.raw('/e2ee/reset', { method: 'POST', body: JSON.stringify({ ...resetPayload, password: 'wrong-password' }) });
  if (wrongResetPassword.status !== 401) throw new Error('DM key reset did not require the current password.');
  if ((await bob('/e2ee/sync')).revision !== bobVaultBeforeReset.revision) throw new Error('Rejected DM key reset changed the active vault.');
  const resetResult = await bob('/e2ee/reset', { method: 'POST', body: JSON.stringify(resetPayload) });
  const bobVaultAfterReset = await bob('/e2ee/sync');
  if (!resetResult.ok || resetResult.revision !== bobVaultBeforeReset.revision + 1 || fingerprint(bobVaultAfterReset.publicKey) !== fingerprint(resetBobKey)) throw new Error('Authenticated DM key reset did not activate the new key.');
  const historyDb = new DatabaseSync(join(dataDir, 'glean-auth.sqlite'));
  const archivedBobVault = historyDb.prepare('SELECT fingerprint, public_key, envelope FROM e2ee_key_history WHERE user_id = ? ORDER BY id DESC LIMIT 1').get((await bob('/auth/me')).account.id);
  historyDb.close();
  if (!archivedBobVault || fingerprint(JSON.parse(archivedBobVault.public_key)) !== fingerprint(bobKey) || archivedBobVault.envelope !== JSON.stringify(bobVaultBeforeReset.envelope)) throw new Error('DM key reset did not preserve the previous encrypted key vault.');
  const messagesAfterReset = await bob(`/conversations/${conversation.id}/messages?limit=50`);
  if (!messagesAfterReset.messages?.some((item) => Number(item.id) === Number(message.id) && item.crypto?.ciphertext === envelope.ciphertext)) throw new Error('DM key reset changed or removed existing encrypted messages.');
  const resetMessageEnvelope = {
    version: 1,
    clientMessageId: 'newkeysmokemessageid123456789',
    ciphertext: Buffer.from(webcrypto.getRandomValues(new Uint8Array(48))).toString('base64url'),
    iv: Buffer.from(webcrypto.getRandomValues(new Uint8Array(12))).toString('base64url'),
    salt: Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    senderPublicKey: rotatedAliceKey,
    recipientPublicKey: resetBobKey,
  };
  const sentWithResetKey = await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ envelope: resetMessageEnvelope, attachmentMeta: [] }) });
  if (!sentWithResetKey.message?.encrypted) throw new Error('New encrypted DMs did not work after key reset.');
  await bob(`/conversations/${conversation.id}/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: sentWithResetKey.message.id }) });

  for (const origin of [false, 'https://attacker.example']) {
    try {
      await openRealtime(alice.cookie, false, { origin });
      throw new Error('Untrusted cookie-authenticated WebSocket should have failed.');
    } catch (error) {
      if (!String(error.message).includes('403')) throw error;
    }
  }
  let aliceRt = await openRealtime(aliceSignup.accessToken, true, { origin: false });
  const bobRt = await openRealtime(bob.cookie);
  await aliceRt.wait('connected');
  await bobRt.wait('connected');
  const presenceSync = await bobRt.wait('presence-sync');
  const aliceStatus = presenceSync.payload?.users?.find((item) => Number(item.userId) === Number(aliceSignup.account.id));
  if (aliceStatus?.status !== 'online') throw new Error('Realtime presence sync did not show Alice online.');
  await bobRt.sendFragmented('presence-sync-request', {});
  const presenceResync = await bobRt.wait('presence-sync', 2500);
  if (presenceResync.payload?.users?.find((item) => Number(item.userId) === Number(aliceSignup.account.id))?.status !== 'online') throw new Error('Presence resync did not refresh Alice online.');
  await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'realtime unread regression' }) });
  const delivered = await bobRt.wait('message');
  if (Number(delivered.payload?.unreadCount) !== 1 || delivered.payload?.message?.body !== 'realtime unread regression') throw new Error('Realtime DM unread update was not delivered.');
  aliceRt.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  let wentOffline;
  try { wentOffline = await bobRt.wait('presence', 2500, (message) => Number(message.payload?.userId) === Number(aliceSignup.account.id)); }
  catch { throw new Error('No offline presence event reached Bob after Alice disconnected.'); }
  if (Number(wentOffline.payload?.userId) !== Number(aliceSignup.account.id) || wentOffline.payload?.status !== 'offline') throw new Error('Realtime presence did not update when Alice disconnected.');
  bobRt.send('presence-sync-request', {});
  const offlineResync = await bobRt.wait('presence-sync', 2500);
  if (offlineResync.payload?.users?.find((item) => Number(item.userId) === Number(aliceSignup.account.id))?.status !== 'offline') throw new Error('Presence resync did not refresh Alice offline.');
  aliceRt = await openRealtime(alice.cookie);
  await aliceRt.wait('connected');
  let cameOnline;
  try { cameOnline = await bobRt.wait('presence', 2500, (message) => Number(message.payload?.userId) === Number(aliceSignup.account.id)); }
  catch { throw new Error('No online presence event reached Bob after Alice reconnected.'); }
  if (Number(cameOnline.payload?.userId) !== Number(aliceSignup.account.id) || cameOnline.payload?.status !== 'online') throw new Error('Realtime presence did not update when Alice reconnected.');
  await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'live read receipt regression' }) });
  const liveDmMessage = await bobRt.wait('message', 2500, (message) => Number(message.payload?.conversationId) === Number(conversation.id));
  const dmReadEvent = bobRt.wait('unread', 2500, (message) => message.payload?.kind === 'dm' && Number(message.payload?.conversationId) === Number(conversation.id)).catch(() => { throw new Error('No realtime DM read acknowledgement reached the reader.'); });
  await bob(`/conversations/${conversation.id}/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: liveDmMessage.payload?.message?.id }) });
  const dmReadUpdate = await dmReadEvent;
  if (Number(dmReadUpdate.payload?.unreadCount) !== 0) throw new Error('DM read acknowledgement did not update live unread state.');
  aliceRt.send('dm-call-invite', { conversationId: 999999 });
  const missingCall = await aliceRt.wait('dm-call-error');
  if (!String(missingCall.payload?.error || '').includes('Conversation')) throw new Error('Unknown conversation call should fail.');
  aliceRt.send('dm-call-invite', { conversationId: conversation.id });
  const aliceRing = await aliceRt.wait('dm-call-invite');
  const bobRing = await bobRt.wait('dm-call-invite');
  if (aliceRing.payload?.role !== 'caller' || bobRing.payload?.role !== 'callee') throw new Error('DM call invite roles missing.');
  if (bobRing.payload?.peer?.username !== 'alice_test') throw new Error('Incoming DM call peer missing.');
  bobRt.send('dm-call-decline', { conversationId: conversation.id });
  const aliceDeclined = await aliceRt.wait('dm-call-ended');
  const bobDeclined = await bobRt.wait('dm-call-ended');
  if (aliceDeclined.payload?.reason !== 'declined' || bobDeclined.payload?.reason !== 'declined') throw new Error('DM call decline did not end.');
  aliceRt.send('dm-call-invite', { conversationId: conversation.id });
  await aliceRt.wait('dm-call-invite');
  await bobRt.wait('dm-call-invite');
  bobRt.send('dm-call-accept', { conversationId: conversation.id });
  const aliceAccepted = await aliceRt.wait('dm-call-accepted');
  const bobAccepted = await bobRt.wait('dm-call-accepted');
  if (!aliceAccepted.payload?.peer?.username || !bobAccepted.payload?.peer?.username) throw new Error('DM call accept missing peer.');
  aliceRt.send('dm-call-signal', { conversationId: conversation.id, signal: { description: { type: 'offer', sdp: 'v=0' } } });
  const bobSignal = await bobRt.wait('dm-call-signal');
  if (bobSignal.payload?.signal?.description?.type !== 'offer') throw new Error('DM call signal was not forwarded.');
  aliceRt.send('dm-call-hangup', { conversationId: conversation.id });
  const bobEnded = await bobRt.wait('dm-call-ended');
  if (bobEnded.payload?.reason !== 'hangup') throw new Error('DM call hangup missing.');
  aliceRt.close();
  bobRt.close();
  const bobProfile = await alice('/users/bob_test');
  if (!bobProfile.user?.createdAt || bobProfile.user.relation !== 'friend' || bobProfile.user.username !== 'bob_test') throw new Error('User profile card payload failed.');
  const selfProfile = await alice('/users/alice_test');
  if (selfProfile.user?.relation !== 'self') throw new Error('Self profile relation failed.');
  if (selfProfile.user?.gradeLabel !== '11th grade') throw new Error('Self grade badge missing.');
  if (selfProfile.user?.schoolLabel !== 'United High' || selfProfile.user?.schoolHex?.[0] !== '#E87722') throw new Error('Self school badge missing.');
  if (bobProfile.user?.gradeLabel !== 'Below High School') throw new Error('Friend grade badge missing.');
  if (bobProfile.user?.schoolLabel) throw new Error('Skipped school should not show a badge.');
  const schoolSkip = await alice('/account/school', { method: 'POST', body: JSON.stringify({ school: 'no_response' }) });
  if (schoolSkip.account?.school !== 'no_response' || schoolSkip.account?.schoolLabel) throw new Error('Hidden school should have no badge.');
  const skippedCard = await bob('/users/alice_test');
  if (skippedCard.user?.schoolLabel) throw new Error('Declined school should not show a badge.');
  const schoolUpdate = await alice('/account/school', { method: 'POST', body: JSON.stringify({ school: 'alexander-hs' }) });
  if (schoolUpdate.account?.schoolLabel !== 'Alexander' || schoolUpdate.account?.schoolHex?.[0] !== '#1E4B8E') throw new Error('School update failed.');
  const aliceSchoolCard = await bob('/users/alice_test');
  if (aliceSchoolCard.user?.schoolLabel !== 'Alexander') throw new Error('Updated school missing from profile.');
  const updatedDirectory = await bob('/people');
  const updatedDirectoryCard = updatedDirectory.people?.find((person) => person.username === 'alice_test');
  if (updatedDirectoryCard?.schoolLabel !== 'Alexander' || updatedDirectoryCard?.schoolHex?.[0] !== '#1E4B8E') throw new Error('Updated school badge missing from the people directory.');
  const clearedSchool = await alice('/account/grade', { method: 'POST', body: JSON.stringify({ grade: 'below_hs' }) });
  if (clearedSchool.account?.school) throw new Error('Mismatched school should clear when grade changes.');
  await alice('/account/grade', { method: 'POST', body: JSON.stringify({ grade: '11' }) });
  await alice('/account/school', { method: 'POST', body: JSON.stringify({ school: 'united-hs' }) });
  try {
    await alice('/account/school', { method: 'POST', body: JSON.stringify({ school: 'laredo-college' }) });
    throw new Error('Laredo College should not be a school.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  try {
    await alice('/account/school', { method: 'POST', body: JSON.stringify({ school: 'magnet' }) });
    throw new Error('MAGNET should not be a school.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const skippedPrograms = await alice('/account/program', { method: 'POST', body: JSON.stringify({ programs: ['no_response'] }) });
  if (skippedPrograms.account?.programAnswered !== true || skippedPrograms.account?.programs?.length) throw new Error('Skipped programs should have no badges.');
  const magnetProgram = await alice('/account/program', { method: 'POST', body: JSON.stringify({ programs: ['magnet'] }) });
  if (!magnetProgram.account?.programs?.some((item) => item.id === 'magnet' && item.label === 'MAGNET' && item.hex?.[0] === '#F0A202')) throw new Error('MAGNET program badge missing.');
  const bothPrograms = await alice('/account/program', { method: 'POST', body: JSON.stringify({ programs: ['magnet', 'laredo-college'] }) });
  if (!bothPrograms.account?.programs?.some((item) => item.id === 'laredo-college' && item.label === 'Laredo College' && item.hex?.[0] === '#1F8A4C')) throw new Error('Laredo College program badge missing.');
  const discoverPeople = await bob('/people');
  const aliceInDiscover = discoverPeople.people?.find((person) => person.username === 'alice_test');
  if (!aliceInDiscover?.programs?.some((item) => item.id === 'laredo-college' && item.label === 'Laredo College')) throw new Error('Discover did not return the Laredo College badge for its member.');
  const filteredDiscoverPeople = await bob('/people?query=alice_test&school=united-hs&program=magnet&grade=11&limit=10');
  if (filteredDiscoverPeople.total !== 1 || filteredDiscoverPeople.people?.[0]?.username !== 'alice_test' || filteredDiscoverPeople.people[0]?.gradeLabel !== '11th grade') throw new Error('Discover people search and school/program/grade filters failed.');
  const firstDiscoverPage = await alice('/people?limit=1');
  const secondDiscoverPage = await alice(`/people?limit=1&cursor=${firstDiscoverPage.nextCursor}`);
  if (!firstDiscoverPage.nextCursor || firstDiscoverPage.people?.length !== 1 || secondDiscoverPage.people?.length !== 1 || firstDiscoverPage.people[0].id === secondDiscoverPage.people[0].id) throw new Error('Discover people pagination failed.');
  const invalidDiscoverFilter = await bob.raw('/people?program=not-a-program');
  if (invalidDiscoverFilter.status !== 400) throw new Error('Unknown Discover program filters should be rejected.');
  const publicUserStatsResponse = await fetch(`${base}/auth/stats`);
  const publicUserStats = await publicUserStatsResponse.json();
  if (!publicUserStatsResponse.ok || publicUserStats.total !== 3) throw new Error('Public Glean user count is inaccurate.');
  const programCard = await bob('/users/alice_test');
  if (!programCard.user?.programs?.some((item) => item.label === 'MAGNET')) throw new Error('MAGNET missing from profile.');
  if (!programCard.user?.programs?.some((item) => item.label === 'Laredo College')) throw new Error('Laredo College missing from profile.');
  if (programCard.user?.schoolLabel === 'MAGNET' || programCard.user?.schoolLabel === 'Laredo College') throw new Error('Program badges leaked as school.');
  try {
    await alice('/account/discord', { method: 'POST', body: JSON.stringify({ discordUsername: '1' }) });
    throw new Error('Invalid Discord username should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const discordSet = await alice('/account/discord', { method: 'POST', body: JSON.stringify({ discordUsername: '@Alice.Glean' }) });
  if (discordSet.account?.discordUsername !== 'alice.glean') throw new Error('Discord username save failed.');
  const discordCard = await bob('/users/alice_test');
  if (discordCard.user?.discordUsername !== 'alice.glean') throw new Error('Discord username missing from profile.');
  const discordLegacy = await alice('/account/discord', { method: 'POST', body: JSON.stringify({ discordUsername: 'Alice#1234' }) });
  if (discordLegacy.account?.discordUsername !== 'Alice#1234') throw new Error('Legacy Discord username save failed.');
  const discordClear = await alice('/account/discord', { method: 'POST', body: JSON.stringify({ discordUsername: '' }) });
  if (discordClear.account?.discordUsername) throw new Error('Cleared Discord username should hide.');
  const discordGone = await bob('/users/alice_test');
  if (discordGone.user?.discordUsername) throw new Error('Cleared Discord username leaked on profile.');
  await alice('/account/discord', { method: 'POST', body: JSON.stringify({ discordUsername: 'alice.glean' }) });
  const gradeUpdate = await alice('/account/grade', { method: 'POST', body: JSON.stringify({ grade: '12' }) });
  if (gradeUpdate.account?.grade !== '12' || gradeUpdate.account?.gradeLabel !== '12th grade') throw new Error('Grade update failed.');
  const aliceGradeCard = await bob('/users/alice_test');
  if (aliceGradeCard.user?.gradeLabel !== '12th grade') throw new Error('Updated grade missing from profile.');
  const hiddenGrade = await alice('/account/grade', { method: 'POST', body: JSON.stringify({ grade: 'no_response' }) });
  if (hiddenGrade.account?.grade !== 'no_response' || hiddenGrade.account?.gradeLabel) throw new Error('Hidden grade should have no badge.');
  const hiddenCard = await bob('/users/alice_test');
  if (hiddenCard.user?.gradeLabel) throw new Error('Declined grade should not show a badge.');
  await alice('/account/grade', { method: 'POST', body: JSON.stringify({ grade: '11' }) });
  const census = await bob('/analytics');
  const analytics = census.analytics;
  if (!analytics || JSON.stringify(analytics).includes('alice_test') || JSON.stringify(analytics).includes('bob_test')) throw new Error('Analytics leaked usernames.');
  if (Number(analytics.members) < 2) throw new Error('Analytics member count too low.');
  if (!analytics.grades?.find((item) => item.label === '11th grade' && item.count >= 1)) throw new Error('Analytics missing grade counts.');
  if (!analytics.grades?.find((item) => item.label === 'Below High School' && item.count >= 1)) throw new Error('Analytics missing below-high-school count.');
  if (!analytics.schools?.find((item) => item.label === 'United High' && item.count >= 1)) throw new Error('Analytics missing school counts.');
  if (!analytics.schools?.find((item) => item.id === 'hidden' && item.count >= 1)) throw new Error('Analytics missing hidden school count.');
  if (!analytics.programs?.find((item) => item.label === 'MAGNET' && item.count >= 1)) throw new Error('Analytics missing MAGNET program count.');
  if (!analytics.programs?.find((item) => item.label === 'Laredo College' && item.count >= 1)) throw new Error('Analytics missing Laredo College program count.');
  if (!analytics.joins?.some((item) => item.count >= 2)) throw new Error('Analytics missing join dates.');
  if (Number(analytics.joinedThisMonth) < 2) throw new Error('Analytics join month count too low.');
  const analyticsPeople = await bob('/analytics/people?limit=1');
  if (analyticsPeople.people?.length !== 1 || !analyticsPeople.nextCursor) throw new Error('Analytics people pagination did not return a next page.');
  const analyticsNextPage = await bob(`/analytics/people?limit=1&cursor=${analyticsPeople.nextCursor}`);
  if (analyticsNextPage.people?.length !== 1 || analyticsNextPage.people[0].username === analyticsPeople.people[0].username) throw new Error('Analytics people cursor did not advance.');
  const analyticsSearch = await bob('/analytics/people?query=alice_test');
  if (analyticsSearch.people?.length !== 1 || analyticsSearch.people[0].username !== 'alice_test' || analyticsSearch.people[0].email) throw new Error('Analytics people search or field privacy failed.');
  const solidBanner = await alice('/account/banner', { method: 'POST', body: JSON.stringify({ kind: 'solid', color: '#249cff' }) });
  if (solidBanner.account?.banner?.kind !== 'solid' || solidBanner.account.banner.color !== '#249cff') throw new Error('Solid banner save failed.');
  const aliceMe = await alice('/auth/me');
  if (aliceMe.account?.banner?.color !== '#249cff') throw new Error('Banner missing from session.');
  const aliceCard = await bob('/users/alice_test');
  if (aliceCard.user?.banner?.kind !== 'solid' || aliceCard.user.banner.color !== '#249cff') throw new Error('Banner missing from profile.');
  const gradientBanner = await alice('/account/banner', { method: 'POST', body: JSON.stringify({ kind: 'gradient', from: '#7c5cff', to: '#249cff', angle: 90 }) });
  if (gradientBanner.account?.banner?.kind !== 'gradient' || gradientBanner.account.banner.angle !== 90) throw new Error('Gradient banner save failed.');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const bannerForm = new FormData();
  bannerForm.append('banner', new Blob([jpeg], { type: 'image/jpeg' }), 'banner.jpg');
  const imageBanner = await alice('/account/banner', { method: 'POST', body: bannerForm });
  if (imageBanner.account?.banner?.kind !== 'image' || !/^\/api\/v1\/banners\/banner-[a-z2-7]+\.jpg$/.test(imageBanner.account.banner.imageUrl || '')) throw new Error('Image banner save failed.');
  const gifAvatarForm = new FormData();
  gifAvatarForm.append('avatar', new Blob([gif], { type: 'image/gif' }), 'avatar.gif');
  const gifAvatar = await alice('/account/avatar', { method: 'POST', body: gifAvatarForm });
  if (!/^\/api\/v1\/avatars\/avatar-[a-z2-7]+\.gif$/.test(gifAvatar.account?.avatarUrl || '')) throw new Error('GIF avatar save failed.');
  const gifAvatarFile = await alice.raw(gifAvatar.account.avatarUrl.replace(/^\/api\/v1/, ''));
  if (!gifAvatarFile.ok || !String(gifAvatarFile.headers.get('content-type') || '').includes('image/gif') || !Buffer.from(await gifAvatarFile.arrayBuffer()).equals(gif)) throw new Error('GIF avatar was not served intact.');
  const gifBannerForm = new FormData();
  gifBannerForm.append('banner', new Blob([gif], { type: 'image/gif' }), 'banner.gif');
  const gifBanner = await alice('/account/banner', { method: 'POST', body: gifBannerForm });
  if (gifBanner.account?.banner?.kind !== 'image' || !/^\/api\/v1\/banners\/banner-[a-z2-7]+\.gif$/.test(gifBanner.account.banner.imageUrl || '')) throw new Error('GIF banner save failed.');
  const gifBannerFile = await alice.raw(gifBanner.account.banner.imageUrl.replace(/^\/api\/v1/, ''));
  if (!gifBannerFile.ok || !String(gifBannerFile.headers.get('content-type') || '').includes('image/gif') || !Buffer.from(await gifBannerFile.arrayBuffer()).equals(gif)) throw new Error('GIF banner was not served intact.');
  const resetBanner = await alice('/account/banner', { method: 'POST', body: JSON.stringify({ kind: 'none' }) });
  if (resetBanner.account?.banner) throw new Error('Banner reset failed.');
  const profileBackground = await alice('/account/profile-background', { method: 'POST', body: JSON.stringify({ kind: 'gradient', from: '#ff5c8a', to: '#7c5cff', angle: 135 }) });
  if (profileBackground.account?.profileBackground?.kind !== 'gradient' || profileBackground.account.profileBackground.from !== '#ff5c8a') throw new Error('Profile background save failed.');
  const bannerAndBackground = await alice('/account/banner', { method: 'POST', body: JSON.stringify({ kind: 'solid', color: '#249cff' }) });
  if (bannerAndBackground.account?.banner?.color !== '#249cff' || bannerAndBackground.account?.profileBackground?.kind !== 'gradient') throw new Error('Banner and profile background did not stay separate.');
  const backgroundMe = await alice('/auth/me');
  if (backgroundMe.account?.banner?.color !== '#249cff' || backgroundMe.account?.profileBackground?.to !== '#7c5cff') throw new Error('Banner and profile background missing from session.');
  const backgroundCard = await bob('/users/alice_test');
  if (backgroundCard.user?.profileBackground?.kind !== 'gradient') throw new Error('Profile background missing from profile.');
  const resetProfileBackground = await alice('/account/profile-background', { method: 'POST', body: JSON.stringify({ kind: 'none' }) });
  if (resetProfileBackground.account?.profileBackground) throw new Error('Profile background reset failed.');
  const resetBannerAgain = await alice('/account/banner', { method: 'POST', body: JSON.stringify({ kind: 'none' }) });
  if (resetBannerAgain.account?.banner) throw new Error('Banner second reset failed.');
  const vapid = await alice('/push/vapid');
  if (!vapid.publicKey || vapid.publicKey.length < 80) throw new Error('VAPID public key missing.');
  const { server: discoveryServer } = await alice('/servers', { method: 'POST', body: JSON.stringify({ name: 'Discoverable Test Server' }) });
  if (discoveryServer.isPublic !== false) throw new Error('New servers should be private by default.');
  const hiddenPublicList = await bob('/public-servers?query=Discoverable');
  if (hiddenPublicList.servers?.some((item) => item.id === discoveryServer.id)) throw new Error('Private server leaked into Discover.');
  const hiddenJoinAttempt = await bob.raw(`/public-servers/${discoveryServer.id}/join`, { method: 'POST', body: '{}' });
  if (hiddenJoinAttempt.status !== 404) throw new Error('Private server should reject public joins.');
  await alice(`/servers/${discoveryServer.id}`, { method: 'PATCH', body: JSON.stringify({ isPublic: true }) });
  const publicDirectory = await bob('/public-servers?query=Discoverable');
  const publicDirectoryEntry = publicDirectory.servers?.find((item) => item.id === discoveryServer.id);
  if (!publicDirectoryEntry || publicDirectoryEntry.isMember || publicDirectoryEntry.memberCount !== 1) throw new Error('Public server directory entry is incomplete.');
  const publicJoin = await bob(`/public-servers/${discoveryServer.id}/join`, { method: 'POST', body: '{}' });
  if (!publicJoin.server?.isPublic) throw new Error('Joining a public server failed.');
  const memberPublicDirectory = await bob('/public-servers?query=Discoverable');
  if (!memberPublicDirectory.servers?.find((item) => item.id === discoveryServer.id)?.isMember) throw new Error('Discover did not mark the joined server.');
  const nonOwnerVisibilityChange = await bob.raw(`/servers/${discoveryServer.id}`, { method: 'PATCH', body: JSON.stringify({ isPublic: false }) });
  if (nonOwnerVisibilityChange.status !== 403) throw new Error('A non-owner changed server visibility.');
  const privateAgain = await alice(`/servers/${discoveryServer.id}`, { method: 'PATCH', body: JSON.stringify({ isPublic: false }) });
  if (privateAgain.server?.isPublic !== false) throw new Error('Owner could not make their server private.');
  const hiddenAgain = await bob('/public-servers?query=Discoverable');
  if (hiddenAgain.servers?.some((item) => item.id === discoveryServer.id)) throw new Error('Private server remained visible in Discover.');
  await alice(`/servers/${discoveryServer.id}`, { method: 'DELETE' });
  const { server: moderationServer } = await alice('/servers', { method: 'POST', body: JSON.stringify({ name: 'Moderation Toggle Lab' }) });
  const moderationChannelId = moderationServer.channels?.[0]?.id;
  if (moderationServer.moderationEnabled !== false || !moderationChannelId) throw new Error('Server moderation should start off.');
  await alice(`/channels/${moderationChannelId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'fuck' }) });
  await alice(`/servers/${moderationServer.id}`, { method: 'PATCH', body: JSON.stringify({ moderationEnabled: true }) });
  const enabledModeration = await alice(`/servers/${moderationServer.id}`);
  if (enabledModeration.server?.moderationEnabled !== true) throw new Error('Server moderation did not turn on.');
  const blockedProfanity = await alice.raw(`/channels/${moderationChannelId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'fuck' }) });
  if (blockedProfanity.status !== 422) throw new Error('Enabled moderation should block profanity.');
  const deniedModerationChange = await bob.raw(`/servers/${moderationServer.id}`, { method: 'PATCH', body: JSON.stringify({ moderationEnabled: false }) });
  if (deniedModerationChange.status !== 403) throw new Error('A non-owner changed server moderation.');
  await alice(`/servers/${moderationServer.id}`, { method: 'PATCH', body: JSON.stringify({ moderationEnabled: false }) });
  const disabledModerationMessage = await alice(`/channels/${moderationChannelId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'fuck' }) });
  if (!disabledModerationMessage.message) throw new Error('Disabled moderation should allow profanity.');
  await alice(`/servers/${moderationServer.id}`, { method: 'DELETE' });
  const { server } = await alice('/servers', { method: 'POST', body: JSON.stringify({ name: 'Voice Lab' }) });
  const { channel } = await alice(`/servers/${server.id}/channels`, { method: 'POST', body: JSON.stringify({ name: 'stage', type: 'voice' }) });
  if (!channel?.voice || channel.kind !== 'voice') throw new Error('Voice channel create failed.');
  const { server: loaded } = await alice(`/servers/${server.id}`);
  if (!loaded.channels.some((item) => item.id === channel.id && item.voice === true && item.kind === 'voice')) throw new Error('Voice channel did not persist.');
  if (!loaded.voiceOccupancy || typeof loaded.voiceOccupancy !== 'object') throw new Error('Voice occupancy missing.');
  if (!Array.isArray(loaded.members) || loaded.memberTotal !== 1 || loaded.membersPage?.hasMore !== false) throw new Error('Initial server member page metadata is incomplete.');
  const memberPage = await alice(`/servers/${server.id}/members?offset=0&limit=1`);
  if (memberPage.members?.length !== 1 || memberPage.page?.hasMore !== false || memberPage.page?.nextOffset !== 1) throw new Error('Server member pagination failed.');
  const ownerRole = loaded.roles.find((role) => role.permissions === 'owner');
  if (!ownerRole) throw new Error('Owner role missing.');
  const renamedOwnerRole = await alice(`/servers/${server.id}/roles/${ownerRole.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Server Owner' }) });
  if (renamedOwnerRole.role?.name !== 'Server Owner' || renamedOwnerRole.role.permissions !== 'owner' || renamedOwnerRole.role.color !== ownerRole.color || renamedOwnerRole.role.position !== ownerRole.position) throw new Error('Owner role rename did not preserve protected settings.');
  try {
    await alice(`/servers/${server.id}/roles/${ownerRole.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Unsafe Owner', permissions: 'member' }) });
    throw new Error('Owner role permission update should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  try {
    await alice(`/servers/${server.id}/roles/${ownerRole.id}`, { method: 'DELETE' });
    throw new Error('Owner role deletion should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const { role: organizerRole } = await alice(`/servers/${server.id}/roles`, { method: 'POST', body: JSON.stringify({ name: 'Organizer', color: '#249cff', permissions: 'member' }) });
  const { role: guideRole } = await alice(`/servers/${server.id}/roles`, { method: 'POST', body: JSON.stringify({ name: 'Guide', color: '#7c5cff', permissions: 'moderator' }) });
  const roleDetailsBeforeOrder = await alice(`/servers/${server.id}`);
  const existingCustomRoleIds = roleDetailsBeforeOrder.server.roles
    .filter((role) => role.permissions !== 'owner' && role.name !== 'Member')
    .map((role) => role.id)
    .filter((roleId) => roleId !== organizerRole.id && roleId !== guideRole.id);
  const requestedRoleOrder = [guideRole.id, organizerRole.id, ...existingCustomRoleIds];
  const reorderedRoles = await alice(`/servers/${server.id}/roles/order`, { method: 'PATCH', body: JSON.stringify({ roleIds: requestedRoleOrder }) });
  const persistedCustomRoleIds = reorderedRoles.roles
    .filter((role) => role.permissions !== 'owner' && role.name !== 'Member')
    .map((role) => role.id);
  if (persistedCustomRoleIds.join() !== requestedRoleOrder.join()) throw new Error('Role order did not persist.');
  if (reorderedRoles.roles[0]?.permissions !== 'owner' || reorderedRoles.roles.at(-1)?.name !== 'Member') throw new Error('Default role positions changed during reorder.');
  try {
    await alice(`/servers/${server.id}/roles/order`, { method: 'PATCH', body: JSON.stringify({ roleIds: [guideRole.id] }) });
    throw new Error('Partial role order should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const patched = await alice(`/servers/${server.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Voice Lab', description: 'Stage and chat' }) });
  if (patched.server?.description !== 'Stage and chat' || patched.server?.name !== 'Voice Lab') throw new Error('Server profile patch failed.');
  const iconForm = new FormData();
  iconForm.append('icon', new Blob([jpeg], { type: 'image/jpeg' }), 'icon.jpg');
  const iconed = await alice(`/servers/${server.id}/icon`, { method: 'POST', body: iconForm });
  if (!/^\/api\/v1\/server-icons\/server-icon-[a-z2-7]+\.jpg$/.test(iconed.server?.iconUrl || '')) throw new Error('Server icon save failed.');
  const listedServers = await alice('/servers');
  if (!listedServers.servers?.find((item) => item.id === server.id)?.iconUrl) throw new Error('Server icon missing from list.');
  const { server: orderLab } = await alice('/servers', { method: 'POST', body: JSON.stringify({ name: 'Order Lab' }) });
  const listedForOrder = await alice('/servers');
  const memberIds = listedForOrder.servers.filter((item) => !item.inspecting).map((item) => item.id);
  if (!memberIds.includes(server.id) || !memberIds.includes(orderLab.id)) throw new Error('Created servers missing from list.');
  const reversedServers = [...memberIds].reverse();
  await alice('/servers/order', { method: 'PATCH', body: JSON.stringify({ serverIds: reversedServers }) });
  const resorted = await alice('/servers');
  const resortedIds = resorted.servers.filter((item) => !item.inspecting).map((item) => item.id);
  if (resortedIds.join() !== reversedServers.join()) throw new Error('Server order did not persist.');
  try {
    await alice('/servers/order', { method: 'PATCH', body: JSON.stringify({ serverIds: [server.id] }) });
    throw new Error('Partial server order should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const general = loaded.channels.find((item) => item.name === 'general' && !item.voice);
  const { channel: lounge } = await alice(`/servers/${server.id}/channels`, { method: 'POST', body: JSON.stringify({ name: 'lounge' }) });
  const { channel: lobby } = await alice(`/servers/${server.id}/channels`, { method: 'POST', body: JSON.stringify({ name: 'lobby' }) });
  const textOrder = [lobby.id, lounge.id, general.id];
  await alice(`/servers/${server.id}/channels/order`, { method: 'PATCH', body: JSON.stringify({ channelIds: textOrder }) });
  const { channel: booth } = await alice(`/servers/${server.id}/channels`, { method: 'POST', body: JSON.stringify({ name: 'booth', type: 'voice' }) });
  const voiceOrder = [booth.id, channel.id];
  await alice(`/servers/${server.id}/channels/order`, { method: 'PATCH', body: JSON.stringify({ channelIds: voiceOrder }) });
  const orderedServer = await alice(`/servers/${server.id}`);
  const textIds = orderedServer.server.channels.filter((item) => !item.voice).map((item) => item.id);
  const voiceIds = orderedServer.server.channels.filter((item) => item.voice).map((item) => item.id);
  if (textIds.join() !== textOrder.join()) throw new Error('Text channel order did not persist.');
  if (voiceIds.join() !== voiceOrder.join()) throw new Error('Voice channel order did not persist.');
  try {
    await alice(`/servers/${server.id}/channels/order`, { method: 'PATCH', body: JSON.stringify({ channelIds: [general.id, channel.id] }) });
    throw new Error('Mixed channel order should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  if (parseInviteInput('https://glean.local/invite/abcdef') !== 'abcdef') throw new Error('Invite URL parse failed.');
  if (parseInviteInput('abcdefg') !== 'abcdefg') throw new Error('Invite code parse failed.');
  const previewInvite = await alice(`/servers/${server.id}/invites`, { method: 'POST', body: JSON.stringify({ expiresInHours: 1, maxUses: 0 }) });
  const preview = await bob(`/invites/${previewInvite.invite.code}`);
  if (preview.server?.name !== 'Voice Lab' || preview.alreadyMember || !preview.server.memberCount) throw new Error('Invite preview failed.');
  if (!String(preview.server.iconUrl || '').includes(`/invites/${previewInvite.invite.code}/icon`)) throw new Error('Invite icon URL missing.');
  const iconRes = await bob.raw(`/invites/${previewInvite.invite.code}/icon`);
  if (!iconRes.ok || !String(iconRes.headers.get('content-type') || '').includes('image/jpeg')) throw new Error('Invite icon fetch failed.');
  const solidServerBanner = await alice(`/servers/${server.id}/banner`, { method: 'POST', body: JSON.stringify({ kind: 'solid', color: '#249cff' }) });
  if (solidServerBanner.server?.banner?.kind !== 'solid' || solidServerBanner.server.banner.color !== '#249cff') throw new Error('Server solid banner save failed.');
  const listedBanner = await alice('/servers');
  if (listedBanner.servers?.find((item) => item.id === server.id)?.banner?.color !== '#249cff') throw new Error('Server banner missing from list.');
  const solidPreview = await bob(`/invites/${previewInvite.invite.code}`);
  if (solidPreview.server?.banner?.kind !== 'solid' || solidPreview.server.banner.color !== '#249cff') throw new Error('Invite preview missing solid banner.');
  const gradientServerBanner = await alice(`/servers/${server.id}/banner`, { method: 'POST', body: JSON.stringify({ kind: 'gradient', from: '#7c5cff', to: '#249cff', angle: 90 }) });
  if (gradientServerBanner.server?.banner?.kind !== 'gradient' || gradientServerBanner.server.banner.angle !== 90) throw new Error('Server gradient banner save failed.');
  const serverBannerForm = new FormData();
  serverBannerForm.append('banner', new Blob([jpeg], { type: 'image/jpeg' }), 'banner.jpg');
  const imageServerBanner = await alice(`/servers/${server.id}/banner`, { method: 'POST', body: serverBannerForm });
  if (imageServerBanner.server?.banner?.kind !== 'image' || !/^\/api\/v1\/server-banners\/server-banner-[a-z2-7]+\.jpg$/.test(imageServerBanner.server.banner.imageUrl || '')) throw new Error('Server image banner save failed.');
  const imagePreview = await bob(`/invites/${previewInvite.invite.code}`);
  if (imagePreview.server?.banner?.kind !== 'image' || !String(imagePreview.server.banner.imageUrl || '').includes(`/invites/${previewInvite.invite.code}/banner`)) throw new Error('Invite banner URL missing.');
  const bannerRes = await bob.raw(`/invites/${previewInvite.invite.code}/banner`);
  if (!bannerRes.ok || !String(bannerRes.headers.get('content-type') || '').includes('image/jpeg')) throw new Error('Invite banner fetch failed.');
  const memberBanner = await alice.raw(imageServerBanner.server.banner.imageUrl.replace(/^\/api\/v1/, ''));
  if (!memberBanner.ok) throw new Error('Member server banner fetch failed.');
  const outsiderBanner = await bob.raw(imageServerBanner.server.banner.imageUrl.replace(/^\/api\/v1/, ''));
  if (outsiderBanner.ok) throw new Error('Non-member fetched private server banner.');
  const sent = await alice(`/servers/${server.id}/invites/send`, { method: 'POST', body: JSON.stringify({ username: 'bob_test', expiresInHours: 1, maxUses: 0 }) });
  if (!sent.conversationId || !sent.invite?.code || !String(sent.message?.body || '').includes(`/invite/${sent.invite.code}`)) throw new Error('Send invite failed.');
  const bobInviteMsgs = await bob(`/conversations/${sent.conversationId}/messages?limit=50`);
  if (!bobInviteMsgs.messages?.some((item) => String(item.body || '').includes(`/invite/${sent.invite.code}`))) throw new Error('Invite DM missing.');
  const inviteList = await alice(`/servers/${server.id}/invites`);
  if (!Array.isArray(inviteList.invites)) throw new Error('Invite list missing.');
  const madeInvite = await alice(`/servers/${server.id}/invites`, { method: 'POST', body: JSON.stringify({ expiresInHours: 1, maxUses: 5 }) });
  if (!madeInvite.invite?.code || madeInvite.invite.maxUses !== 5) throw new Error('Invite options failed.');
  await alice(`/servers/${server.id}/invites/${madeInvite.invite.code}`, { method: 'DELETE' });
  const banList = await alice(`/servers/${server.id}/bans`);
  if (!Array.isArray(banList.bans)) throw new Error('Ban list missing.');
  const nuper = await makeClient();
  await nuper('/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'Nuper', password: 'correct-horse-789', grade: 'no_response', school: 'no_response' }) });
  await acceptCurrentAgreements(nuper);
  const nuperMe = await nuper('/auth/me');
  if (!nuperMe.account?.platformAdmin) throw new Error('Nuper is not platform admin.');
  const initialNuperServers = await nuper('/servers');
  const official = initialNuperServers.servers.find((item) => item.officialAnnouncements);
  if (!official || official.name !== 'Glean') throw new Error('Official Glean server missing.');
  const officialDetail = (await nuper(`/servers/${official.id}`)).server;
  const officialAnnouncement = officialDetail.channels.find((channel) => channel.name === 'announcements' && channel.kind === 'announcement');
  const officialGeneral = officialDetail.channels.find((channel) => channel.name === 'general' && !channel.voice && !channel.locked);
  const officialVoice = officialDetail.channels.find((channel) => channel.voice && !channel.locked);
  if (!officialAnnouncement || !officialGeneral || !officialVoice) throw new Error('Official Glean needs announcements, general, and voice channels.');
  const announcementId = officialAnnouncement.id;
  for (const existingUser of [alice, bob]) {
    if (!(await existingUser('/servers')).servers.some((item) => item.id === official.id)) throw new Error('Existing user not enrolled in official Glean.');
    const posting = await existingUser.raw(`/channels/${announcementId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Not allowed' }) });
    if (posting.status !== 403) throw new Error('Member could publish an official announcement.');
    const leaving = await existingUser.raw(`/servers/${official.id}/leave`, { method: 'POST', body: '{}' });
    if (leaving.status !== 403) throw new Error('Required official membership could be removed.');
  }
  await nuper(`/channels/${announcementId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Official announcement test' }) });
  const readable = await alice(`/channels/${announcementId}/messages`);
  if (!readable.messages.some((message) => message.body === 'Official announcement test')) throw new Error('Members cannot read official announcements.');
  await alice(`/channels/${officialGeneral.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Hello Glean community' }) });
  if (!(await bob(`/channels/${officialGeneral.id}/messages`)).messages.some((message) => message.body === 'Hello Glean community')) throw new Error('Members cannot chat in official general.');
  await nuper(`/servers/${official.id}/channels/${officialGeneral.id}`, { method: 'PATCH', body: JSON.stringify({ slowmode: 10 }) });
  const slowed = await alice.raw(`/channels/${officialGeneral.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Too soon' }) });
  if (slowed.status !== 429) throw new Error('Official general bypassed slowmode.');
  await nuper(`/servers/${official.id}/channels/${officialGeneral.id}`, { method: 'PATCH', body: JSON.stringify({ slowmode: 0 }) });
  const extraText = await nuper(`/servers/${official.id}/channels`, { method: 'POST', body: JSON.stringify({ name: 'community', type: 'text' }) });
  await nuper(`/servers/${official.id}/channels/${extraText.channel.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'community-chat', topic: 'Community chat' }) });
  const extraVoice = await nuper(`/servers/${official.id}/channels`, { method: 'POST', body: JSON.stringify({ name: 'voice-two', type: 'voice' }) });
  if (!extraVoice.channel.voice) throw new Error('Official server voice creation failed.');
  const communityVoiceSocket = await openRealtime(bob.cookie);
  try {
    communityVoiceSocket.send('voice-join', { serverId: official.id, channelId: officialVoice.id });
    const presence = await communityVoiceSocket.wait('voice-presence', 2500, (event) => event.payload.serverId === official.id && event.payload.channelId === officialVoice.id);
    if (!presence.payload.participants.some((member) => member.id === bobID)) throw new Error('Official server member could not join voice.');
    communityVoiceSocket.send('voice-leave', { serverId: official.id, channelId: officialVoice.id });
    await communityVoiceSocket.wait('voice-presence', 2500, (event) => event.payload.channelId === officialVoice.id && event.payload.action === 'left');
  } finally { communityVoiceSocket.close(); }
  const memberCreate = await alice.raw(`/servers/${official.id}/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'unauthorized', type: 'voice' }) });
  if (memberCreate.status !== 403) throw new Error('Members could create channels without permission.');
  await alice(`/servers/${official.id}/mute`, { method: 'PATCH', body: JSON.stringify({ muted: true }) });
  const mutedServers = await alice('/servers');
  const mutedOfficial = mutedServers.servers.find((item) => item.id === official.id);
  if (!mutedOfficial?.muted || mutedOfficial.unread || mutedOfficial.unreadCount || mutedOfficial.mentionCount) throw new Error('Muted server still shows notifications.');
  await alice(`/servers/${official.id}/mute`, { method: 'PATCH', body: JSON.stringify({ muted: false }) });
  for (const request of [
    [`/servers/${official.id}`, 'DELETE', undefined],
    [`/servers/${official.id}/channels/${announcementId}`, 'DELETE', undefined],
    [`/servers/${official.id}/channels/${announcementId}`, 'PATCH', { channelKind: 'text' }],
  ]) {
    const result = await nuper.raw(request[0], { method: request[1], headers: { 'Content-Type': 'application/json' }, ...(request[2] ? { body: JSON.stringify(request[2]) } : {}) });
    if (![400, 403].includes(result.status)) throw new Error('Official server protection failed.');
  }
  if (initialNuperServers.servers?.some((item) => item.name === 'Glean (BETA)')) throw new Error('The default Glean (BETA) server should not be created.');
  for (const existingUser of [alice, bob]) {
    const existingServers = await existingUser('/servers');
    if (existingServers.servers?.some((item) => item.name === 'Glean (BETA)')) throw new Error('Existing accounts should not be added to a default Glean (BETA) server.');
  }
  try {
    await alice('/push/test', { method: 'POST', body: '{}' });
    throw new Error('Non-admin test push should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  const testPush = await nuper('/push/test', { method: 'POST', body: '{}' });
  if (!testPush.ok || typeof testPush.sent !== 'number') throw new Error('Admin test push failed.');
  try {
    await alice('/push/announcement', { method: 'POST', body: JSON.stringify({ message: 'Unauthorized announcement' }) });
    throw new Error('Non-Nuper custom announcement should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  try {
    await nuper('/push/announcement', { method: 'POST', body: JSON.stringify({ message: '   ' }) });
    throw new Error('Empty custom announcement should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const announcement = await nuper('/push/announcement', { method: 'POST', body: JSON.stringify({ message: 'Have a great day!' }) });
  if (!announcement.ok || typeof announcement.sent !== 'number') throw new Error('Nuper custom announcement failed.');
  const nuperServers = await nuper('/servers');
  const inspected = nuperServers.servers?.find((item) => item.id === server.id);
  if (!inspected?.inspecting) throw new Error('Nuper cannot inspect other servers.');
  if (nuperMe.account.showInspectServers !== true) throw new Error('Hidden servers should start on.');
  try {
    await alice('/account/inspect-servers', { method: 'POST', body: JSON.stringify({ show: false }) });
    throw new Error('Non-admin inspect pref should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  const hiddenPref = await nuper('/account/inspect-servers', { method: 'POST', body: JSON.stringify({ show: false }) });
  if (hiddenPref.account?.showInspectServers !== false) throw new Error('Hidden servers did not turn off.');
  const hiddenList = await nuper('/servers');
  if (hiddenList.servers?.some((item) => item.inspecting) || hiddenList.servers?.some((item) => item.id === server.id)) {
    throw new Error('Hidden inspect servers still listed.');
  }
  const stillInspect = await nuper(`/servers/${server.id}`);
  if (!stillInspect.server?.inspecting) throw new Error('Inspect by id should still work when hidden.');
  const shownPref = await nuper('/account/inspect-servers', { method: 'POST', body: JSON.stringify({ show: true }) });
  if (shownPref.account?.showInspectServers !== true) throw new Error('Hidden servers did not turn on.');
  const shownList = await nuper('/servers');
  if (!shownList.servers?.find((item) => item.id === server.id)?.inspecting) throw new Error('Inspect servers missing after enable.');
  const nuperView = await nuper(`/servers/${server.id}`);
  if (!nuperView.server?.inspecting) throw new Error('Nuper inspect payload missing.');
  const textChannel = nuperView.server.channels.find((item) => !item.voice);
  const nuperMessages = await nuper(`/channels/${textChannel.id}/messages`);
  if (!Array.isArray(nuperMessages.messages)) throw new Error('Nuper cannot read channel messages.');
  try {
    await nuper(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'ghost' }) });
    throw new Error('Inspecting admin should not post as a non-member.');
  } catch (error) {
    if (!String(error.message).startsWith('404 ')) throw error;
  }
  const bobServers = await bob('/servers');
  if (bobServers.servers?.some((item) => item.id === server.id)) throw new Error('Non-member saw a private server.');
  await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'history seed' }) });
  const joinInvite = await alice(`/servers/${server.id}/invites`, { method: 'POST', body: JSON.stringify({ expiresInHours: 1, maxUses: 0 }) });
  await bob(`/invites/${joinInvite.invite.code}/join`, { method: 'POST', body: '{}' });
  const bobJoined = await bob('/servers');
  const bobServer = bobJoined.servers?.find((item) => item.id === server.id);
  if (!bobServer || bobServer.unread || bobServer.mentionCount) throw new Error('Joining should not inherit history unread.');
  if (bobServer.banner?.kind !== 'image') throw new Error('Joined server missing banner.');
  const serverOnlyMember = await makeClient();
  const serverOnlySignup = await serverOnlyMember('/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'server_only_test', password: 'correct-horse-987' }) });
  await acceptCurrentAgreements(serverOnlyMember);
  await serverOnlyMember(`/invites/${joinInvite.invite.code}/join`, { method: 'POST', body: '{}' });
  const serverOnlyRealtime = await openRealtime(serverOnlyMember.cookie);
  try {
    await serverOnlyRealtime.wait('connected');
    await serverOnlyRealtime.wait('presence-sync');
    const liveMember = (await bob(`/servers/${server.id}`)).server.members.find((member) => member.username === 'server_only_test');
    if (liveMember?.presence !== 'online') throw new Error('Server member API did not return current presence for its loaded page.');
    bobServerRealtime = await openRealtime(bob.cookie);
    await bobServerRealtime.wait('connected');
    const bobPresenceSync = await bobServerRealtime.wait('presence-sync');
    if (bobPresenceSync.payload?.users?.some((item) => Number(item.userId) === Number(serverOnlySignup.account.id))) {
      throw new Error('Presence sync sent an entire large-server roster instead of only direct contacts.');
    }
    await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'hello @bob_test' }) });
    const liveServerNotification = await bobServerRealtime.wait('channel-message', 2500, (message) => Number(message.payload?.serverId) === Number(server.id));
    if (Number(liveServerNotification.payload?.unreadCount) !== 1 || Number(liveServerNotification.payload?.serverUnreadCount) !== 1) throw new Error('Live server notification did not include unread counts.');
  } finally { serverOnlyRealtime.close(); }
  const bobPinged = await bob('/servers');
  const pinged = bobPinged.servers?.find((item) => item.id === server.id);
  if (!pinged?.unread || Number(pinged.unreadCount) !== 1 || Number(pinged.mentionCount) < 1) throw new Error('Channel mention unread missing.');
  if (typeof bobPinged.homeUnread !== 'number') throw new Error('homeUnread missing.');
  const alicePinged = await alice('/servers');
  if (alicePinged.servers?.find((item) => item.id === server.id)?.mentionCount) throw new Error('Sender mention badge should be 0.');
  const bobDetail = await bob(`/servers/${server.id}`);
  const bobGeneral = bobDetail.server.channels.find((item) => item.id === textChannel.id);
  if (Number(bobGeneral?.unreadCount) !== 1 || !bobGeneral.mentionCount) throw new Error('Channel unread counts missing.');
  const bobMember = bobDetail.server.members.find((member) => member.username === 'bob_test');
  if (!bobMember) throw new Error('Joined member missing from server roster.');
  const { role: limitedMod } = await alice(`/servers/${server.id}/roles`, { method: 'POST', body: JSON.stringify({ name: 'Chat Moderator', color: '#3366aa', permissions: 'moderator', permissionFlags: ['manageMessages'] }) });
  await alice(`/servers/${server.id}/members/${bobMember.id}/role`, { method: 'POST', body: JSON.stringify({ roleId: limitedMod.id }) });
  const limitedView = await bob(`/servers/${server.id}`);
  if (limitedView.server.membership?.permissionFlags?.join() !== 'manageMessages') throw new Error('Moderator permission flags did not persist.');
  const deniedReorder = await bob.raw(`/servers/${server.id}/channels/order`, { method: 'PATCH', body: JSON.stringify({ channelIds: textOrder }) });
  if (deniedReorder.status !== 403) throw new Error('Moderator without channel permission reordered channels.');
  const deniedInvite = await bob.raw(`/servers/${server.id}/invites`, { method: 'POST', body: '{}' });
  if (deniedInvite.status !== 403) throw new Error('Moderator without invite permission created an invite.');
  await alice(`/servers/${server.id}/members/${bobMember.id}/role`, { method: 'POST', body: JSON.stringify({ roleId: organizerRole.id }) });
  const roleAssigned = await alice(`/servers/${server.id}`);
  const assignedBob = roleAssigned.server.members.find((member) => member.id === bobMember.id);
  if (assignedBob?.roleId !== organizerRole.id || assignedBob.roleName !== 'Organizer') throw new Error('Member role assignment did not persist.');
  try {
    await bob(`/servers/${server.id}/roles/order`, { method: 'PATCH', body: JSON.stringify({ roleIds: requestedRoleOrder }) });
    throw new Error('Non-owner role ordering should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  const channelReadEvent = bobServerRealtime.wait('unread', 2500, (message) => message.payload?.kind === 'channel' && Number(message.payload?.channelId) === Number(textChannel.id)).catch(() => { throw new Error('No realtime server-channel read acknowledgement reached the reader.'); });
  await bob(`/channels/${textChannel.id}/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: 999999 }) });
  const liveChannelReadUpdate = await channelReadEvent;
  if (Number(liveChannelReadUpdate.payload?.unreadCount) !== 0 || Number(liveChannelReadUpdate.payload?.serverUnreadCount) !== 0) throw new Error('Server channel read acknowledgement did not update live unread state.');
  bobServerRealtime.close();
  const bobCleared = await bob(`/servers/${server.id}`);
  const cleared = bobCleared.server.channels.find((item) => item.id === textChannel.id);
  if (cleared.unreadCount || cleared.mentionCount) throw new Error('Channel mark-read failed.');
  await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'no mention' }) });
  const bobPlain = await bob('/servers');
  const plain = bobPlain.servers?.find((item) => item.id === server.id);
  if (!plain?.unread || Number(plain.unreadCount) !== 1 || Number(plain.mentionCount)) throw new Error('Plain channel unread should show without a mention.');
  const nuperListed = await nuper('/servers');
  const nuperInspected = nuperListed.servers?.find((item) => item.id === server.id);
  if (nuperInspected.unread || nuperInspected.mentionCount) throw new Error('Inspecting unread should be 0.');
  try {
    await nuper(`/channels/${textChannel.id}/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: 1 }) });
    throw new Error('Inspecting admin should not mark channel read.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  try {
    await alice(`/channels/${channel.id}/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: 1 }) });
    throw new Error('Voice channel read should be rejected.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  try {
    await alice(`/channels/${channel.id}/messages`);
    throw new Error('Voice channel message GET should be rejected.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  try {
    await alice(`/channels/${channel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'nope' }) });
    throw new Error('Voice channel message POST should be rejected.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const alicePresence = await alice('/auth/me');
  if (!['online', 'idle', 'offline'].includes(alicePresence.account?.presence)) throw new Error('Presence missing.');
  if (alicePresence.account?.presenceHidden) throw new Error('Presence should start visible.');
  if (alicePresence.account?.presence !== 'offline') throw new Error('HTTP presence should be offline without a socket.');
  const aliceDevice = await makeClient();
  await aliceDevice('/auth/signin', { method: 'POST', body: JSON.stringify({ username: 'alice_test', password: 'correct-horse-123' }) });
  const sessions = await alice('/account/sessions');
  if (!sessions.sessions?.some((item) => item.current) || sessions.sessions.length < 2) throw new Error('Session list missing devices.');
  const otherSession = sessions.sessions.find((item) => !item.current);
  if (!otherSession?.id || !otherSession.device) throw new Error('Other session payload missing.');
  await alice(`/account/sessions/${otherSession.id}`, { method: 'DELETE' });
  try {
    await aliceDevice('/auth/me');
    throw new Error('Revoked device should be signed out.');
  } catch (error) {
    if (!String(error.message).startsWith('401 ')) throw error;
  }
  const aliceDevice2 = await makeClient();
  await aliceDevice2('/auth/signin', { method: 'POST', body: JSON.stringify({ username: 'alice_test', password: 'correct-horse-123' }) });
  const revokedOthers = await alice('/account/sessions/others', { method: 'DELETE' });
  if (!revokedOthers.ok || Number(revokedOthers.revoked) < 1) throw new Error('Revoke others failed.');
  try {
    await aliceDevice2('/auth/me');
    throw new Error('Revoke others should sign out other devices.');
  } catch (error) {
    if (!String(error.message).startsWith('401 ')) throw error;
  }
  try {
    await alice('/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'wrong-password-1', newPassword: 'correct-horse-999' }) });
    throw new Error('Wrong current password should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('401 ')) throw error;
  }
  const aliceDevice3 = await makeClient();
  await aliceDevice3('/auth/signin', { method: 'POST', body: JSON.stringify({ username: 'alice_test', password: 'correct-horse-123' }) });
  const changed = await alice('/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'correct-horse-123', newPassword: 'correct-horse-999' }) });
  if (!changed.ok || Number(changed.revoked) < 1) throw new Error('Password change did not revoke other devices.');
  try {
    await aliceDevice3('/auth/me');
    throw new Error('Password change should revoke other sessions.');
  } catch (error) {
    if (!String(error.message).startsWith('401 ')) throw error;
  }
  const stillAlice = await alice('/auth/me');
  if (!stillAlice.account) throw new Error('Current session should survive password change.');
  const thief = await makeClient();
  try {
    await thief('/auth/signin', { method: 'POST', body: JSON.stringify({ username: 'alice_test', password: 'correct-horse-123' }) });
    throw new Error('Old password should fail after change.');
  } catch (error) {
    if (!String(error.message).startsWith('401 ')) throw error;
  }
  await thief('/auth/signin', { method: 'POST', body: JSON.stringify({ username: 'alice_test', password: 'correct-horse-999' }) });
  const hidden = await alice('/account/presence', { method: 'POST', body: JSON.stringify({ hidden: true }) });
  if (!hidden.account?.presenceHidden || hidden.account.presence !== 'offline') throw new Error('Appear offline failed.');
  const bobSees = await bob('/users/alice_test');
  if (bobSees.user?.presence !== 'offline') throw new Error('Hidden user should look offline to friends.');
  const visible = await alice('/account/presence', { method: 'POST', body: JSON.stringify({ hidden: false }) });
  if (visible.account?.presenceHidden) throw new Error('Stop appearing offline failed.');
  try {
    await alice('/account/keep-information-secret', { method: 'POST', body: JSON.stringify({ enabled: 'yes' }) });
    throw new Error('Secret mode should reject non-boolean values.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const secretOn = await alice('/account/keep-information-secret', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  if (!secretOn.account?.keepInformationSecret || secretOn.account.presence !== 'offline') throw new Error('Secret mode did not hide presence.');
  const secretPresence = await bob('/users/alice_test');
  if (secretPresence.user?.presence !== 'offline') throw new Error('Secret-mode presence leaked to another account.');
  const suppressedTyping = await alice(`/conversations/${conversation.id}/typing`, { method: 'POST', body: JSON.stringify({ typing: true }) });
  if (!suppressedTyping.suppressed) throw new Error('Secret mode did not suppress DM typing indicators.');
  const secretStatus = await alice('/account/presence-status', { method: 'POST', body: JSON.stringify({ status: 'online' }) });
  if (secretStatus.account?.presence !== 'offline') throw new Error('Secret mode did not override public online status.');
  const secretOff = await alice('/account/keep-information-secret', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  if (secretOff.account?.keepInformationSecret || secretOff.account.presence !== 'online') throw new Error('Secret mode failed to turn off or altered manual presence status.');
  await alice('/account/presence-status', { method: 'POST', body: JSON.stringify({ status: 'auto' }) });

  const parentCh = await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'reply parent' }) });
  const replyCh = await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'reply child', replyToMessageId: parentCh.message.id }) });
  if (!replyCh.message?.replyTo || replyCh.message.replyTo.id !== parentCh.message.id || replyCh.message.replyTo.body !== 'reply parent') throw new Error('Channel reply payload failed.');
  const listedChannel = await bob(`/channels/${textChannel.id}/messages`);
  if (!listedChannel.messages?.find((item) => item.id === replyCh.message.id)?.replyTo?.body) throw new Error('Channel reply missing on GET.');
  for (let index = 0; index < 6; index += 1) {
    await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: `history-${index}` }) });
  }
  const newestPage = await bob(`/channels/${textChannel.id}/messages?limit=3`);
  if (newestPage.messages?.length !== 3) throw new Error('Channel page size failed.');
  if (!newestPage.page?.hasMore || !newestPage.page?.nextBefore) throw new Error('Channel page cursor missing.');
  if (newestPage.messages[0].id >= newestPage.messages[1].id) throw new Error('Channel page order failed.');
  const olderPage = await bob(`/channels/${textChannel.id}/messages?limit=3&before=${newestPage.messages[0].id}`);
  if (!olderPage.messages?.length) throw new Error('Older channel page empty.');
  if (olderPage.messages.some((item) => newestPage.messages.some((current) => current.id === item.id))) throw new Error('Channel pages overlapped.');

  const dmParent = await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'dm parent' }) });
  if (dmParent.message?.sender?.customBadges?.[0]?.label !== 'OM') throw new Error('Custom badge missing from DM sender.');
  const dmReply = await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'dm child', replyToMessageId: dmParent.message.id }) });
  if (!dmReply.message?.replyTo || dmReply.message.replyTo.body !== 'dm parent') throw new Error('DM reply payload failed.');
  const editedDm = await alice(`/conversations/${conversation.id}/messages/${dmParent.message.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'dm parent edited' }) });
  if (!editedDm.message?.editedAt || editedDm.message.body !== 'dm parent edited') throw new Error('DM edit failed.');
  await alice(`/conversations/${conversation.id}/messages/${dmReply.message.id}`, { method: 'DELETE' });
  const listedDm = await alice(`/conversations/${conversation.id}/messages?limit=50`);
  if (listedDm.messages.some((item) => item.id === dmReply.message.id)) throw new Error('Deleted DM still listed.');
  if (listedDm.messages.find((item) => item.id === dmParent.message.id)?.body !== 'dm parent edited') throw new Error('Edited DM missing from GET.');
  try {
    await alice(`/conversations/${conversation.id}/messages/${message.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'nope' }) });
    throw new Error('Encrypted DM edit should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const keep = await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'keep-me' }) });
  const doomed = await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'delete-me' }) });
  await alice(`/conversations/${conversation.id}/messages/${doomed.message.id}`, { method: 'DELETE' });
  const afterDelete = await alice('/conversations');
  const afterDeleteThread = afterDelete.conversations?.find((item) => item.id === conversation.id);
  if (afterDeleteThread?.lastMessage === 'delete-me') throw new Error('Deleted DM still lastMessage.');
  if (afterDeleteThread?.lastMessage !== keep.message.body) throw new Error('lastMessage did not fall back after delete.');

  const fileForm = new FormData();
  fileForm.append('body', 'file ping');
  fileForm.append('files', new Blob([Buffer.from('hello-glean-file')], { type: 'text/plain' }), 'ping.txt');
  const dmFile = await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: fileForm });
  if (!dmFile.message?.attachments?.[0]?.id) throw new Error('DM attachment upload failed.');
  const dmRange = await alice.raw(`/attachments/${dmFile.message.attachments[0].id}`, { headers: { Range: 'bytes=0-4' } });
  if (dmRange.status !== 206) throw new Error(`DM attachment range expected 206, got ${dmRange.status}`);
  if (Buffer.from(await dmRange.arrayBuffer()).toString() !== 'hello') throw new Error('DM attachment range body failed.');

  const chForm = new FormData();
  chForm.append('body', '');
  chForm.append('files', new Blob([Buffer.from('channel-file')], { type: 'text/plain' }), 'ch.txt');
  const chFile = await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: chForm });
  if (!chFile.message?.attachments?.[0]?.id) throw new Error('Channel attachment upload failed.');
  const chRange = await alice.raw(`/channel-attachments/${chFile.message.attachments[0].id}`, { headers: { Range: 'bytes=0-6' } });
  if (chRange.status !== 206) throw new Error(`Channel attachment range expected 206, got ${chRange.status}`);
  if (Buffer.from(await chRange.arrayBuffer()).toString() !== 'channel') throw new Error('Channel attachment range body failed.');

  await alice(`/friends/bob_test`, { method: 'DELETE' });
  const afterUnfriend = await alice('/friends');
  if (afterUnfriend.friends?.some((item) => item.username === 'bob_test')) throw new Error('Unfriend did not remove friendship.');
  await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'after unfriend' }) });
  try {
    await alice('/conversations/direct/bob_test', { method: 'POST', body: '{}' });
    throw new Error('New DM after unfriend should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }

  await alice('/blocks', { method: 'POST', body: JSON.stringify({ username: 'bob_test' }) });
  const blockedProfile = await alice('/users/bob_test');
  if (blockedProfile.user?.relation !== 'blocked') throw new Error('Blocker profile relation failed.');
  const blockedSees = await bob('/users/alice_test');
  if (blockedSees.user?.relation !== 'none') throw new Error('Blocked user should not see blocked relation.');
  const alicePeople = await alice('/people');
  if (alicePeople.people?.some((item) => item.username === 'bob_test')) throw new Error('Discover should hide blocked users.');
  const blocks = await alice('/blocks');
  if (!blocks.blocked?.some((item) => item.username === 'bob_test')) throw new Error('Blocked list missing user.');
  try {
    await alice('/friends/requests', { method: 'POST', body: JSON.stringify({ username: 'bob_test' }) });
    throw new Error('Friend request while blocked should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  try {
    await bob('/friends/requests', { method: 'POST', body: JSON.stringify({ username: 'alice_test' }) });
    throw new Error('Friend request from blocked user should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  try {
    await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'blocked ping' }) });
    throw new Error('DM send while blocked should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  try {
    await bob(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'blocked ping' }) });
    throw new Error('DM send from blocked side should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  const blockedThread = (await alice('/conversations')).conversations?.find((item) => item.id === conversation.id);
  if (!blockedThread?.blocked) throw new Error('Conversation blocked flag missing.');
  await alice('/blocks/bob_test', { method: 'DELETE' });
  await alice('/friends/requests', { method: 'POST', body: JSON.stringify({ username: 'bob_test' }) });
  const bobIncoming = await bob('/friends');
  try {
    await alice(`/friends/requests/${bobIncoming.requests[0].id}/decline`, { method: 'POST', body: '{}' });
    throw new Error('Sender should not decline a request.');
  } catch (error) {
    if (!String(error.message).startsWith('404 ')) throw error;
  }
  await bob(`/friends/requests/${bobIncoming.requests[0].id}/decline`, { method: 'POST', body: '{}' });
  if ((await bob('/friends')).requests?.length) throw new Error('Declined request still incoming.');
  if ((await alice('/friends')).sent?.some((item) => item.user?.username === 'bob_test')) throw new Error('Declined request still sent.');
  try {
    await bob(`/friends/requests/${bobIncoming.requests[0].id}/decline`, { method: 'POST', body: '{}' });
    throw new Error('Second decline should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('404 ')) throw error;
  }
  await alice('/friends/requests', { method: 'POST', body: JSON.stringify({ username: 'bob_test' }) });
  const bobIncomingAgain = await bob('/friends');
  await bob(`/friends/requests/${bobIncomingAgain.requests[0].id}/accept`, { method: 'POST', body: '{}' });
  await alice(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'after unblock' }) });
  await alice('/conversations/direct/bob_test', { method: 'POST', body: '{}' });

  const { channel: rulesCh } = await alice(`/servers/${server.id}/channels`, { method: 'POST', body: JSON.stringify({ name: 'rules', type: 'rules' }) });
  if (!rulesCh?.locked || rulesCh.kind !== 'rules') throw new Error('Rules channel should be locked.');
  const { channel: newsCh } = await alice(`/servers/${server.id}/channels`, { method: 'POST', body: JSON.stringify({ name: 'news', type: 'announcement' }) });
  if (!newsCh?.locked || newsCh.kind !== 'announcement') throw new Error('Announcement channel should be locked.');
  await alice(`/channels/${rulesCh.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Be kind.' }) });
  try {
    await bob(`/channels/${rulesCh.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'spam' }) });
    throw new Error('Members should not post in rules.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  try {
    await bob(`/channels/${newsCh.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'spam' }) });
    throw new Error('Members should not post in announcements.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  const lockedLounge = await alice(`/servers/${server.id}/channels/${lounge.id}`, { method: 'PATCH', body: JSON.stringify({ locked: true, topic: 'Quiet hours', slowmode: 5 }) });
  if (!lockedLounge.channel?.locked || lockedLounge.channel.topic !== 'Quiet hours' || lockedLounge.channel.slowmode !== 5) throw new Error('Channel patch failed.');
  try {
    await bob(`/channels/${lounge.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'locked' }) });
    throw new Error('Members should not post in a locked channel.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  await alice(`/servers/${server.id}/channels/${lounge.id}`, { method: 'PATCH', body: JSON.stringify({ locked: false, slowmode: 60 }) });
  await bob(`/channels/${lounge.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'slow 1' }) });
  try {
    await bob(`/channels/${lounge.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'slow 2' }) });
    throw new Error('Slowmode should reject a second post.');
  } catch (error) {
    if (!String(error.message).startsWith('429 ')) throw error;
  }
  await bob(`/channels/${textChannel.id}/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: 999999 }) });
  const everyonePing = await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'staff @everyone' }) });
  if (!everyonePing.message?.id) throw new Error('@everyone send failed.');
  const bobEveryone = await bob('/servers');
  if (Number(bobEveryone.servers?.find((item) => item.id === server.id)?.mentionCount) < 1) throw new Error('@everyone did not ping members.');
  const bobEveryoneDetail = await bob(`/servers/${server.id}`);
  if (!bobEveryoneDetail.server.channels.find((item) => item.id === textChannel.id)?.mentionCount) throw new Error('@everyone channel mention missing.');
  const bobEveryoneSend = await bob(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'hey @everyone' }) });
  if (!bobEveryoneSend.message?.id) throw new Error('Member @everyone failed.');
  const bobMe = await bob('/auth/me');
  const bobOwnMessage = await bob(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'before timeout' }) });
  const timed = await alice(`/servers/${server.id}/members/${bobMe.account.id}/timeout`, { method: 'POST', body: JSON.stringify({ seconds: 60, reason: 'cool down' }) });
  if (!timed.timeoutUntil) throw new Error('Timeout did not apply.');
  const bobTimedDetail = await bob(`/servers/${server.id}`);
  if (bobTimedDetail.server.membership?.timeoutUntil !== timed.timeoutUntil) throw new Error('Timed-out member detail did not expose the active timeout.');
  try {
    await bob(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'muted' }) });
    throw new Error('Timed out member should not post.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  const { role: timeoutStaffRole } = await alice(`/servers/${server.id}/roles`, { method: 'POST', body: JSON.stringify({ name: 'Timeout Staff', color: '#3366aa', permissions: 'moderator', permissionFlags: ['manageMessages', 'postStaff'] }) });
  await alice(`/servers/${server.id}/members/${bobMe.account.id}/role`, { method: 'POST', body: JSON.stringify({ roleId: timeoutStaffRole.id }) });
  await alice(`/servers/${server.id}/members/${bobMe.account.id}/timeout`, { method: 'POST', body: JSON.stringify({ seconds: 60, reason: 'staff timeout regression' }) });
  try {
    await bob(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'staff timeout should block' }) });
    throw new Error('A timed-out member with postStaff permission should not post.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  try {
    await bob(`/channels/${textChannel.id}/messages/${bobOwnMessage.message.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'staff timeout should block edits' }) });
    throw new Error('A timed-out member with manageMessages permission should not edit their own message.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }
  await alice(`/servers/${server.id}/members/${bobMe.account.id}/timeout`, { method: 'POST', body: JSON.stringify({ seconds: 0 }) });
  await bob(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'unmuted' }) });
  await alice(`/servers/${server.id}/members/${bobMe.account.id}/role`, { method: 'POST', body: JSON.stringify({ roleId: organizerRole.id }) });

  const nameSolid = await alice('/account/name-style', { method: 'POST', body: JSON.stringify({ kind: 'solid', color: '#ff5c8a', glow: true, font: 'google-sans' }) });
  if (nameSolid.account?.nameStyle?.kind !== 'solid' || nameSolid.account.nameStyle.color !== '#ff5c8a' || nameSolid.account.nameStyle.glow !== 50 || nameSolid.account.nameStyle.font !== 'google-sans') {
    throw new Error('Solid name style save failed.');
  }
  const nameGlow = await alice('/account/name-style', { method: 'POST', body: JSON.stringify({ kind: 'solid', color: '#ff5c8a', glow: 80, font: 'jetbrains-mono' }) });
  if (nameGlow.account?.nameStyle?.glow !== 80 || nameGlow.account.nameStyle.font !== 'jetbrains-mono') throw new Error('Glow strength save failed.');
  try {
    await alice('/account/name-style', { method: 'POST', body: JSON.stringify({ kind: 'solid', color: 'red' }) });
    throw new Error('Bad name color should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  try {
    await alice('/account/name-style', { method: 'POST', body: JSON.stringify({ font: 'comic-sans' }) });
    throw new Error('Bad name font should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const nameGrad = await alice('/account/name-style', { method: 'POST', body: JSON.stringify({ kind: 'gradient', from: '#249cff', to: '#7c5cff', angle: 90, glow: 65, font: 'inter' }) });
  if (nameGrad.account?.nameStyle?.kind !== 'gradient' || nameGrad.account.nameStyle.from !== '#249cff' || nameGrad.account.nameStyle.to !== '#7c5cff' || nameGrad.account.nameStyle.angle !== 90 || nameGrad.account.nameStyle.font !== 'inter' || nameGrad.account.nameStyle.glow !== 65) {
    throw new Error('Gradient name style save failed.');
  }
  const aliceProfile = await bob('/users/alice_test');
  if (aliceProfile.user?.nameStyle?.font !== 'inter' || aliceProfile.user.nameStyle.kind !== 'gradient') throw new Error('Profile name style missing.');
  const bobFriends = await bob('/friends');
  if (!bobFriends.friends?.find((item) => item.username === 'alice_test')?.nameStyle?.kind) throw new Error('Friend name style missing.');
  const bobConvos = await bob('/conversations');
  if (!bobConvos.conversations?.find((item) => item.user?.username === 'alice_test')?.user?.nameStyle?.kind) throw new Error('Conversation name style missing.');
  const styledServer = await bob(`/servers/${server.id}`);
  if (!styledServer.server.members.find((item) => item.username === 'alice_test')?.nameStyle?.kind) throw new Error('Member name style missing.');
  if (styledServer.server.members.find((item) => item.username === 'alice_test')?.customBadges?.[0]?.label !== 'OM') throw new Error('Custom badge missing from server member list.');
  await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'styled name' }) });
  const styledMessages = await bob(`/channels/${textChannel.id}/messages`);
  const styledAuthor = styledMessages.messages?.find((item) => item.body === 'styled name')?.author;
  if (!styledAuthor?.nameStyle?.kind) throw new Error('Channel author name style missing.');
  if (styledAuthor.customBadges?.[0]?.label !== 'OM') throw new Error('Custom badge missing from channel author.');
  const nameCleared = await alice('/account/name-style', { method: 'POST', body: JSON.stringify({ kind: 'none' }) });
  if (nameCleared.account?.nameStyle) throw new Error('Name style clear failed.');

  const pollCreate = await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ poll: { question: 'Best snack?', options: ['Chips', 'Fruit', 'Chips'], allowMultiple: false } }) });
  if (!pollCreate.message?.poll || pollCreate.message.poll.question !== 'Best snack?' || pollCreate.message.poll.options.length !== 3 || pollCreate.message.poll.options[0].text !== 'Chips') {
    throw new Error('Poll create failed.');
  }
  try {
    await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ poll: { question: 'Nope', options: ['Only one'] } }) });
    throw new Error('One-option poll should fail.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  const pollVote = await bob(`/channels/${textChannel.id}/messages/${pollCreate.message.id}/poll/vote`, { method: 'POST', body: JSON.stringify({ optionIndex: 1 }) });
  if (!pollVote.message?.poll?.options?.[1]?.voted || pollVote.message.poll.voterCount !== 1) throw new Error('Poll vote failed.');
  const pollSwitch = await bob(`/channels/${textChannel.id}/messages/${pollCreate.message.id}/poll/vote`, { method: 'POST', body: JSON.stringify({ optionIndex: 0 }) });
  if (!pollSwitch.message.poll.options[0].voted || pollSwitch.message.poll.options[1].voted || pollSwitch.message.poll.voterCount !== 1) throw new Error('Single-choice poll should replace the vote.');
  const multiPoll = await alice(`/channels/${textChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'pick any', poll: { question: 'Pick any', options: ['A', 'B', 'C'], allowMultiple: true } }) });
  await bob(`/channels/${textChannel.id}/messages/${multiPoll.message.id}/poll/vote`, { method: 'POST', body: JSON.stringify({ optionIndex: 0 }) });
  const multiSecond = await bob(`/channels/${textChannel.id}/messages/${multiPoll.message.id}/poll/vote`, { method: 'POST', body: JSON.stringify({ optionIndex: 2 }) });
  if (!multiSecond.message.poll.options[0].voted || !multiSecond.message.poll.options[2].voted || multiSecond.message.poll.voterCount !== 1) throw new Error('Multi poll should keep both votes.');
  const listedPolls = await bob(`/channels/${textChannel.id}/messages?limit=100`);
  const listedPoll = listedPolls.messages?.find((item) => Number(item.id) === Number(pollCreate.message.id));
  if (!listedPoll?.poll) throw new Error('Listed poll missing.');
  if (Number(listedPoll.poll.options?.[0]?.votes) !== 1) throw new Error(`Listed poll missing votes: ${JSON.stringify(listedPoll.poll)}`);
  const pollClosed = await alice(`/channels/${textChannel.id}/messages/${pollCreate.message.id}/poll/close`, { method: 'POST' });
  if (!pollClosed.message?.poll?.closed) throw new Error('Poll close failed.');
  try {
    await bob(`/channels/${textChannel.id}/messages/${pollCreate.message.id}/poll/vote`, { method: 'POST', body: JSON.stringify({ optionIndex: 0 }) });
    throw new Error('Closed poll should reject votes.');
  } catch (error) {
    if (!String(error.message).startsWith('400 ')) throw error;
  }
  try {
    await bob(`/channels/${textChannel.id}/messages/${pollCreate.message.id}/poll/close`, { method: 'POST' });
    throw new Error('Members should not close someone else\'s poll.');
  } catch (error) {
    if (!String(error.message).startsWith('403 ')) throw error;
  }

  const newMember = await makeClient();
  await newMember('/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'hub_new_member', password: 'correct-horse-new-member' }) });
  await acceptCurrentAgreements(newMember);
  const newMemberServers = await newMember('/servers');
  if (!newMemberServers.servers.some((item) => item.id === official.id)) throw new Error('New account not enrolled in official Glean.');
  if (newMemberServers.servers?.some((item) => item.name === 'Glean (BETA)')) throw new Error('A new account should not receive a default Glean (BETA) server.');

  const hiddenOfficial = await nuper('/admin/official-server', { method: 'PATCH', body: JSON.stringify({ hidden: true }) });
  if (!hiddenOfficial.hidden) throw new Error('Official server hide setting was not enabled.');
  if ((await nuper('/servers')).servers.some((item) => Number(item.id) === Number(official.id))) throw new Error('Hidden official server remained in the server list.');
  if ((await nuper.raw(`/servers/${official.id}`)).status !== 404) throw new Error('Hidden official server remained directly accessible.');
  if ((await alice.raw('/admin/official-server')).status !== 403) throw new Error('Non-admin could change official server visibility.');
  const shownOfficial = await nuper('/admin/official-server', { method: 'PATCH', body: JSON.stringify({ hidden: false }) });
  if (shownOfficial.hidden || !(await nuper('/servers')).servers.some((item) => Number(item.id) === Number(official.id))) throw new Error('Official server did not return after being shown.');

  const unauthorizedOfficialKick = await alice.raw(`/servers/${official.id}/members/${bobID}/kick`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (unauthorizedOfficialKick.status !== 403) throw new Error('A regular official-server member could moderate another member.');
  const officialInvite = await nuper(`/servers/${official.id}/invites`, {
    method: 'POST', body: JSON.stringify({ expiresInHours: 1, maxUses: 0 }),
  });
  const kickAlice = await nuper(`/servers/${official.id}/members/${aliceSignup.account.id}/kick`, { method: 'POST', body: '{}' });
  if (kickAlice.action !== 'kick' || (await alice('/servers')).servers.some((item) => Number(item.id) === Number(official.id))) {
    throw new Error('The official server owner could not kick a member.');
  }
  await nuper('/admin/official-server', { method: 'PATCH', body: JSON.stringify({ hidden: true }) });
  await nuper('/admin/official-server', { method: 'PATCH', body: JSON.stringify({ hidden: false }) });
  if ((await alice('/servers')).servers.some((item) => Number(item.id) === Number(official.id))) {
    throw new Error('A kicked member was automatically re-enrolled into the official server.');
  }
  await alice(`/invites/${officialInvite.invite.code}/join`, { method: 'POST', body: '{}' });
  if (!(await alice('/servers')).servers.some((item) => Number(item.id) === Number(official.id))) {
    throw new Error('A kicked member could not rejoin the official server through an invite.');
  }
  const banAlice = await nuper(`/servers/${official.id}/members/${aliceSignup.account.id}/ban`, {
    method: 'POST', body: JSON.stringify({ reason: 'official server moderation smoke test' }),
  });
  if (banAlice.action !== 'ban' || (await alice('/servers')).servers.some((item) => Number(item.id) === Number(official.id))) {
    throw new Error('The official server owner could not ban a member.');
  }
  const officialBans = await nuper(`/servers/${official.id}/bans`);
  if (!officialBans.bans?.some((item) => Number(item.userId) === Number(aliceSignup.account.id))) {
    throw new Error('Official-server ban did not appear in the bans list.');
  }
  const bannedJoin = await alice.raw(`/invites/${officialInvite.invite.code}/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (bannedJoin.status !== 403) throw new Error('A banned member could rejoin the official server.');
  await nuper('/admin/official-server', { method: 'PATCH', body: JSON.stringify({ hidden: true }) });
  await nuper('/admin/official-server', { method: 'PATCH', body: JSON.stringify({ hidden: false }) });
  if ((await alice('/servers')).servers.some((item) => Number(item.id) === Number(official.id))) {
    throw new Error('A banned member was automatically re-enrolled into the official server.');
  }
  await nuper(`/servers/${official.id}/bans/${aliceSignup.account.id}`, { method: 'DELETE' });
  if (!(await alice('/servers')).servers.some((item) => Number(item.id) === Number(official.id))) {
    throw new Error('Unbanning did not restore required official-server membership.');
  }

  const deletingUser = await makeClient();
  const deletingSignup = await deletingUser('/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'delete_me_test', password: 'correct-horse-delete-me' }) });
  await acceptCurrentAgreements(deletingUser);
  const { server: deletionSharedServer } = await alice('/servers', { method: 'POST', body: JSON.stringify({ name: 'Account deletion shared test' }) });
  await alice(`/servers/${deletionSharedServer.id}`, { method: 'PATCH', body: JSON.stringify({ isPublic: true }) });
  await deletingUser(`/public-servers/${deletionSharedServer.id}/join`, { method: 'POST', body: '{}' });
  const joinedPublicServer = await deletingUser(`/servers/${deletionSharedServer.id}`);
  const joinedChannelId = joinedPublicServer.server?.channels?.find((item) => !item.voice)?.id;
  if (!joinedChannelId) throw new Error('Account deletion test could not join a text channel.');
  await deletingUser(`/channels/${joinedChannelId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'delete-account-owned-message' }) });
  const aliceBeforeAccountDelete = await alice(`/channels/${joinedChannelId}/messages?limit=100`);
  if (!aliceBeforeAccountDelete.messages?.some((item) => item.body === 'delete-account-owned-message')) throw new Error('Account deletion test message was not visible to another server member.');
  await deletingUser('/friends/requests', { method: 'POST', body: JSON.stringify({ username: 'alice_test' }) });
  const aliceDeleteRequest = (await alice('/friends')).requests?.find((item) => item.user?.username === 'delete_me_test');
  if (!aliceDeleteRequest) throw new Error('Account deletion test friend request was missing.');
  await alice(`/friends/requests/${aliceDeleteRequest.id}/accept`, { method: 'POST', body: '{}' });
  const { conversation: deleteDm } = await deletingUser('/conversations/direct/alice_test', { method: 'POST', body: '{}' });
  await deletingUser(`/conversations/${deleteDm.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'delete-account-private-message' }) });
  const uploadsBeforeDelete = new Set(readdirSync(join(dataDir, 'uploads')));
  const deleteDmForm = new FormData();
  deleteDmForm.append('body', 'delete-account-dm-file');
  deleteDmForm.append('files', new Blob([Buffer.from('private-test-upload')], { type: 'text/plain' }), 'private.txt');
  const deleteDmFile = await deletingUser(`/conversations/${deleteDm.id}/messages`, { method: 'POST', body: deleteDmForm });
  const deleteChannelForm = new FormData();
  deleteChannelForm.append('body', 'delete-account-channel-file');
  deleteChannelForm.append('files', new Blob([Buffer.from('channel-test-upload')], { type: 'text/plain' }), 'channel.txt');
  const deleteChannelFile = await deletingUser(`/channels/${joinedChannelId}/messages`, { method: 'POST', body: deleteChannelForm });
  const incorrectDelete = await deletingUser.raw('/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }) });
  if (incorrectDelete.status !== 401) throw new Error('Account deletion must reject an incorrect password.');
  if ((await deletingUser('/auth/me')).account?.username !== 'delete_me_test') throw new Error('A failed account deletion should leave the account signed in.');
  const accountServer = await deletingUser('/servers', { method: 'POST', body: JSON.stringify({ name: 'Account deletion owner test' }) });
  const accountServerId = accountServer.server.id;
  await deletingUser(`/servers/${accountServerId}`, { method: 'PATCH', body: JSON.stringify({ isPublic: true }) });
  const deletedAccountResult = await deletingUser('/account', { method: 'DELETE', body: JSON.stringify({ password: 'correct-horse-delete-me' }) });
  if (!deletedAccountResult.ok) throw new Error('Account deletion endpoint did not confirm deletion.');
  const deletedAuth = await deletingUser.raw('/auth/me');
  if (deletedAuth.status !== 401) throw new Error('Deleted account session remained valid.');
  const aliceAfterAccountDelete = await alice(`/channels/${joinedChannelId}/messages?limit=100`);
  if (aliceAfterAccountDelete.messages?.some((item) => item.body === 'delete-account-owned-message')) throw new Error('Account deletion left the user’s message in a surviving server.');
  const aliceConversationsAfterDelete = await alice('/conversations');
  if (aliceConversationsAfterDelete.conversations?.some((item) => item.id === deleteDm.id)) throw new Error('Account deletion left the direct-message conversation for the other participant.');
  if ((await alice.raw(`/attachments/${deleteDmFile.message.attachments[0].id}`)).status !== 404) throw new Error('Account deletion left a direct-message attachment accessible.');
  if ((await alice.raw(`/channel-attachments/${deleteChannelFile.message.attachments[0].id}`)).status !== 404) throw new Error('Account deletion left a channel attachment accessible.');
  const remainingTestUploads = readdirSync(join(dataDir, 'uploads')).filter((name) => !uploadsBeforeDelete.has(name));
  if (remainingTestUploads.length) throw new Error(`Account deletion left uploaded files behind: ${remainingTestUploads.length}`);
  if ((await bob(`/public-servers?query=${encodeURIComponent('Account deletion owner test')}`)).servers?.some((item) => item.id === accountServerId)) throw new Error('Account deletion left the user-owned server discoverable.');
  const noOwnedServer = await bob.raw(`/servers/${accountServerId}`);
  if (noOwnedServer.status !== 404) throw new Error('Account deletion did not remove its owned server.');
  const afterDeletionSignup = await makeClient();
  const recreated = await afterDeletionSignup('/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'after_delete_test', password: 'correct-horse-recreated' }) });
  if (Number(recreated.account?.id) === Number(deletingSignup.account?.id)) throw new Error('A deleted account ID was reused.');

  console.log('Glean server smoke test passed.');
} finally {
  bobServerRealtime?.close();
  server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 150));
  rmSync(dataDir, { recursive: true, force: true });
}
