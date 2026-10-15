import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const records = new Map();
const request = fn => { const result = {}; queueMicrotask(() => { result.result = fn(); result.onsuccess?.(); }); return result; };
globalThis.indexedDB = { open: () => request(() => ({ objectStoreNames: { contains: () => true }, close() {}, transaction: () => ({ objectStore: () => ({ getAll: () => request(() => [...records.values()]) }) }) })) };
const source = readFileSync(new URL('../src/app/e2ee.js', import.meta.url), 'utf8')
  .replace("import { prepareUploadFiles } from './imageUpload';", 'const prepareUploadFiles = async files => files;')
  .replace("import { apiRequest } from './apiClient';", 'const apiRequest = async () => { throw Error("Unexpected API request"); };');
const { prepareEncryptedMessage, decryptMessage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
async function makeIdentity(accountId) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { accountId, publicKey, privateKey: pair.privateKey, fingerprint: createHash('sha256').update(JSON.stringify(publicKey)).digest('hex') };
}
const identities = await Promise.all([1, 2, 3, 4].map(makeIdentity));
const group = { id: 42, kind: 'group', revision: 1, members: identities.slice(0, 3).map(identity => ({ id: identity.accountId, username: `Member${identity.accountId}`, publicKey: identity.publicKey })) };
const prepared = await prepareEncryptedMessage(identities[0], group, 'private group fixture');
const message = { id: 1, encrypted: true, crypto: prepared.envelope, clientMessageId: prepared.envelope.clientMessageId, sender: { id: 1 }, attachments: [] };
assert.equal(prepared.envelope.version, 2);
assert.equal(prepared.envelope.recipientKeys.length, 3);
assert.ok(!JSON.stringify(prepared).includes('private group fixture'));
for (const identity of identities.slice(0, 3)) assert.equal((await decryptMessage(identity, message, 42)).body, 'private group fixture');
assert.equal((await decryptMessage(identities[3], message, 42)).decryptionFailed, true, 'outsider cannot decrypt');
assert.equal((await decryptMessage(identities[1], message, 43)).decryptionFailed, true, 'conversation binding');
assert.equal((await decryptMessage(identities[1], { ...message, clientMessageId: 'changed' }, 42)).decryptionFailed, true, 'nonce binding');
const tampered = structuredClone(message); tampered.crypto.recipientKeys[1].ciphertext = 'A'.repeat(64);
assert.equal((await decryptMessage(identities[1], tampered, 42)).decryptionFailed, true);
const next = { ...group, revision: 2, members: group.members.filter(m => m.id !== 2) };
const future = await prepareEncryptedMessage(identities[0], next, 'after removal');
assert.equal((await decryptMessage(identities[1], { ...message, crypto: future.envelope, clientMessageId: future.envelope.clientMessageId }, 42)).decryptionFailed, true, 'removed member has no future key');
await assert.rejects(prepareEncryptedMessage(identities[0], { ...group, members: group.members.map(m => m.id === 2 ? { ...m, publicKey: null } : m) }, 'test'), /Member2 needs to sign in/);
console.log('PASS group encryption: all members including sender, outsider isolation, authenticated conversation/nonce, tamper rejection, removal, missing keys.');
