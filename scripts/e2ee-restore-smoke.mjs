import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';

const identities = new Map();
const vault = new Map();
const requests = [];
let remote;
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
  requests.push({ path, method: options.method || 'GET' });
  assert.equal(options.method || 'GET', 'GET', 'startup must never upload or replace keys');
  return remote;
};
const source = readFileSync(new URL('../src/app/e2ee.js', import.meta.url), 'utf8')
  .replace("import { prepareUploadFiles } from './imageUpload';", 'const prepareUploadFiles = async files => files;')
  .replace("import { apiRequest } from './apiClient';", 'const apiRequest = globalThis.restoreTestApi;');
const { ensureE2EEIdentity, decryptMessage, prepareEncryptedMessage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
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
console.log('PASS: existing key, archived key and cache, mismatched key preservation, read-only vault restoration, encrypted message decryption');
