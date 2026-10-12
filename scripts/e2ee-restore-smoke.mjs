import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';

const identities = new Map();
const vault = new Map();
const requests = [];
let remote;
let profileRemote;
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const request = action => {
  const result = {};
  queueMicrotask(() => { result.result = action(); result.onsuccess?.(); });
  return result;
};
globalThis.indexedDB = {
  open: () => request(() => ({
    objectStoreNames: { contains: () => true }, close() {},
    transaction: name => ({ objectStore: () => {
      const store = name === 'identities' ? identities : vault;
      return {
        get: key => request(() => store.get(key)),
        getAll: () => request(() => [...store.values()]),
        put: value => request(() => store.set(name === 'identities' ? value.accountId : value.fingerprint, value)),
      };
    } }),
  })),
};
globalThis.restoreTestApi = async (path, options = {}) => {
  const method = options.method || 'GET';
  requests.push({ path, method });
  if (path === '/e2ee/profile-key') {
    if (method === 'PUT') {
      const payload = JSON.parse(options.body);
      profileRemote = { revision: payload.revision + 1, backup: payload.backup, publicKey: payload.publicKey, fingerprint: payload.fingerprint };
      return { revision: profileRemote.revision };
    }
    return profileRemote || remote;
  }
  if (path === '/e2ee/key' && method === 'PUT') return { ok: true };
  assert.equal(method, 'GET', 'startup legacy restore must not rewrite its shared vault');
  return remote;
};
const source = readFileSync(new URL('../src/app/e2ee.js', import.meta.url), 'utf8')
  .replace("import { prepareUploadFiles } from './imageUpload';", 'const prepareUploadFiles = async files => files;')
  .replace("import { apiRequest } from './apiClient';", 'const apiRequest = globalThis.restoreTestApi;');
const { ensureE2EEIdentity, decryptMessage, prepareEncryptedMessage, restoreAccountE2EEIdentity, prepareProfileKeyBackupForPasswordChange } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const fingerprint = key => createHash('sha256').update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest('hex').slice(0, 32);
async function identity(accountId) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return { accountId, username: `fixture${accountId}`, publicKey, privateKey: pair.privateKey,
    privateJwk: await webcrypto.subtle.exportKey('jwk', pair.privateKey), fingerprint: fingerprint(publicKey) };
}
const existing = await identity(101);
identities.set(101, existing);
remote = { revision: 1, envelope: { version: 1 }, publicKey: existing.publicKey };
assert.equal((await ensureE2EEIdentity(101, existing.username)).fingerprint, existing.fingerprint);

const current = await identity(102);
const archived = await identity(102);
identities.set(102, current); vault.set(archived.fingerprint, archived);
remote = { revision: 1, envelope: { version: 1 }, publicKey: archived.publicKey };
assert.equal((await ensureE2EEIdentity(102, current.username)).fingerprint, archived.fingerprint);
assert.equal((await ensureE2EEIdentity(102, current.username)).fingerprint, archived.fingerprint, 'cache must preserve selected archived key');

const missing = await identity(103);
identities.set(103, missing);
remote = { revision: 1, envelope: { version: 1 }, publicKey: existing.publicKey };
const mismatch = await ensureE2EEIdentity(103, missing.username);
assert.equal(mismatch.serverKeyMismatch, true);
assert.equal(identities.get(103).fingerprint, missing.fingerprint);
await assert.rejects(prepareEncryptedMessage(mismatch, {}, 'test'), /missing your existing message key/);

const original = await identity(104); const replacement = await identity(104);
identities.set(104, replacement);
const code = webcrypto.getRandomValues(new Uint8Array(32));
vault.set('sync:104', { fingerprint: 'sync:104', code: Buffer.from(code).toString('base64url') });
const key = await webcrypto.subtle.importKey('raw', code, 'AES-GCM', false, ['encrypt']);
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const encoded = new TextEncoder();
const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoded.encode('glean-key-sync-v1:104') }, key,
  encoded.encode(JSON.stringify({ activeFingerprint: original.fingerprint, identities: [{ publicKey: original.publicKey, privateJwk: original.privateJwk, fingerprint: original.fingerprint }] })));
remote = { publicKey: original.publicKey, envelope: { iv: Buffer.from(iv).toString('base64url'), ciphertext: Buffer.from(ciphertext).toString('base64url') } };
const restored = await ensureE2EEIdentity(104, original.username);
assert.equal(restored.fingerprint, original.fingerprint);
assert.equal(vault.get(replacement.fingerprint).fingerprint, replacement.fingerprint, 'previous identity must remain archived');
const sender = await identity(105);
const encrypted = await prepareEncryptedMessage(sender, { id: 1, user: { publicKey: original.publicKey } }, 'readable fixture');
const message = { encrypted: true, crypto: encrypted.envelope, clientMessageId: encrypted.envelope.clientMessageId, sender: { id: 105 }, attachments: [] };
assert.equal((await decryptMessage(restored, message, 1)).body, 'readable fixture');
const unavailableRecipient = await identity(106);
const unavailable = await prepareEncryptedMessage(sender, { id: 1, user: { publicKey: unavailableRecipient.publicKey } }, 'unavailable fixture');
const unreadable = await decryptMessage(mismatch, { ...message, crypto: unavailable.envelope, clientMessageId: unavailable.envelope.clientMessageId }, 1);
assert.equal(unreadable.decryptionFailed, true);
assert.notEqual(unreadable.body, '', 'missing keys must not silently hide message content');
assert.equal(requests.length, 4);

const profileIdentity = await identity(201);
identities.set(201, profileIdentity);
profileRemote = { revision: 0, backup: null, publicKey: null, fingerprint: null };
const initializedProfile = await restoreAccountE2EEIdentity(201, 'Nuper', 'account-password-fixture');
assert.equal(initializedProfile.fingerprint, profileIdentity.fingerprint);
assert.equal(profileRemote.revision, 1);
assert.equal(profileRemote.publicKey.x, profileIdentity.publicKey.x);
assert.equal(profileRemote.backup.ciphertext.includes(profileIdentity.privateJwk.d), false, 'server backup must not expose plaintext private keys');
identities.delete(201);
for (const [key, value] of vault) if (Number(value.accountId) === 201) vault.delete(key);
const crossDeviceIdentity = await restoreAccountE2EEIdentity(201, 'Nuper', 'account-password-fixture');
assert.equal(crossDeviceIdentity.fingerprint, profileIdentity.fingerprint, 'a new device restores the profile-bound key');
const sender201 = await identity(202);
const profileEncrypted = await prepareEncryptedMessage(sender201, { id: 201, user: { publicKey: crossDeviceIdentity.publicKey, username: 'Nuper' } }, 'profile-bound history works');
const profileMessage = { encrypted: true, crypto: profileEncrypted.envelope, clientMessageId: profileEncrypted.envelope.clientMessageId, sender: { id: 202 }, attachments: [] };
assert.equal((await decryptMessage(crossDeviceIdentity, profileMessage, 201)).body, 'profile-bound history works');
identities.delete(201);
for (const [key, value] of vault) if (Number(value.accountId) === 201) vault.delete(key);
const wrongPasswordIdentity = await restoreAccountE2EEIdentity(201, 'Nuper', 'wrong-account-password');
assert.equal(wrongPasswordIdentity.serverKeyMismatch, true, 'wrong password must not produce a usable identity');
assert.equal(wrongPasswordIdentity.privateKey, undefined);
identities.set(201, crossDeviceIdentity);
const newPasswordBackup = await prepareProfileKeyBackupForPasswordChange(201, 'Nuper', 'account-password-fixture', 'new-account-password-fixture');
assert.equal(newPasswordBackup.fingerprint, profileIdentity.fingerprint, 'password change retains the same account key');
const passwordMaterial = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('new-account-password-fixture'), 'PBKDF2', false, ['deriveKey']);
const newPasswordKey = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(newPasswordBackup.backup.salt, 'base64url'), iterations: 600_000, hash: 'SHA-256' }, passwordMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(newPasswordBackup.backup.iv, 'base64url'), additionalData: new TextEncoder().encode('glean-account-key-backup-v1:201') }, newPasswordKey, Buffer.from(newPasswordBackup.backup.ciphertext, 'base64url'));
console.log('PASS: existing key, archived key and cache, mismatched key preservation, read-only vault restoration, encrypted message decryption');
