
import { prepareUploadFiles } from './imageUpload';
import { apiRequest } from './apiClient';

const DB_NAME = 'glean-e2ee';
const DB_VERSION = 2;
const STORE = 'identities';
const VAULT = 'vault';
const identityCache = new Map();
let storedIdentityRequest = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomToken(bytes = 24) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function samePublicKey(left, right) {
  if (!left || !right) return false;
  return left.kty === right.kty && left.crv === right.crv && left.x === right.x && left.y === right.y;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'accountId' });
      if (!request.result.objectStoreNames.contains(VAULT)) request.result.createObjectStore(VAULT, { keyPath: 'fingerprint' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open the encryption key store.'));
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function fingerprintPublicKey(publicKey) {
  const canonical = JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
  return Array.from(digest.slice(0, 16), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function hydrateIdentity(record) {
  if (!record?.publicKey) return null;
  if (record.privateKey) return record;
  if (!record.privateJwk) return null;
  if (!samePublicKey(record.publicKey, record.privateJwk)) throw new Error('Saved encryption key does not match its public key.');
  const privateKey = await crypto.subtle.importKey('jwk', record.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { ...record, privateKey };
}

async function readIdentity(accountId) {
  if (identityCache.has(accountId)) return identityCache.get(accountId);
  const db = await openDatabase();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  let record = await requestValue(store.get(accountId));
  if (!record && accountId !== Number(accountId)) record = await requestValue(store.get(Number(accountId)));
  if (!record) record = await requestValue(store.get(String(accountId)));
  db.close();
  const hydrated = await hydrateIdentity(record);
  if (hydrated) identityCache.set(accountId, hydrated);
  return hydrated;
}

async function listStoredIdentities() {
  if (storedIdentityRequest) return storedIdentityRequest;
  const request = (async () => {
    const db = await openDatabase();
    const identities = db.objectStoreNames.contains(STORE)
      ? await requestValue(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())
      : [];
    const vault = db.objectStoreNames.contains(VAULT)
      ? await requestValue(db.transaction(VAULT, 'readonly').objectStore(VAULT).getAll())
      : [];
    db.close();
    const byFingerprint = new Map();
    for (const record of [...identities, ...vault]) {
      const hydrated = await hydrateIdentity(record);
      if (!hydrated?.fingerprint) continue;
      const current = byFingerprint.get(hydrated.fingerprint);
      if (!current || String(hydrated.createdAt || '') > String(current.createdAt || '')) byFingerprint.set(hydrated.fingerprint, hydrated);
    }
    return [...byFingerprint.values()];
  })();
  storedIdentityRequest = request;
  try {
    return await request;
  } finally {
    if (storedIdentityRequest === request) storedIdentityRequest = null;
  }
}

async function writeIdentity(record) {
  const db = await openDatabase();
  const durable = {
    accountId: Number(record.accountId),
    username: record.username || null,
    publicKey: record.publicKey,
    privateJwk: record.privateJwk,
    fingerprint: record.fingerprint,
    createdAt: record.createdAt,
  };
  const stored = { ...durable, privateKey: record.privateKey };
  await requestValue(db.transaction(STORE, 'readwrite').objectStore(STORE).put(stored));
  await requestValue(db.transaction(VAULT, 'readwrite').objectStore(VAULT).put(stored));
  db.close();
  identityCache.set(Number(record.accountId), record);
  storedIdentityRequest = null;
}

async function writeVaultIdentity(record) {
  const db = await openDatabase();
  const durable = {
    accountId: Number(record.accountId),
    username: record.username || null,
    publicKey: record.publicKey,
    privateJwk: record.privateJwk,
    fingerprint: record.fingerprint,
    createdAt: record.createdAt,
  };
  const stored = { ...durable, privateKey: record.privateKey };
  try { await requestValue(db.transaction(VAULT, 'readwrite').objectStore(VAULT).put(stored)); }
  finally { db.close(); }
  storedIdentityRequest = null;
}

export async function deleteE2EEIdentity(accountId) {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof indexedDB === 'undefined') return;
  identityCache.delete(id);
  storedIdentityRequest = null;
  const db = await openDatabase();
  let record;
  let archivedRecords;
  try {
    record = await requestValue(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
    archivedRecords = await requestValue(db.transaction(VAULT, 'readonly').objectStore(VAULT).getAll());
  } finally {
    db.close();
  }
  const writeDb = await openDatabase();
  try {
    const transaction = writeDb.transaction([STORE, VAULT], 'readwrite');
    transaction.objectStore(STORE).delete(id);
    transaction.objectStore(STORE).delete(String(id));
    if (record?.fingerprint) transaction.objectStore(VAULT).delete(record.fingerprint);
    for (const old of archivedRecords.filter(item => Number(item.accountId) === id)) transaction.objectStore(VAULT).delete(old.fingerprint);
    transaction.objectStore(VAULT).delete(`sync:${id}`);
    syncCheckedAt.delete(id);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not remove this device’s encryption key.'));
      transaction.onabort = () => reject(transaction.error || new Error('Could not remove this device’s encryption key.'));
    });
  } finally {
    writeDb.close();
  }
}

async function ensureLocalIdentity(accountId, username) {
  if (!crypto?.subtle || !indexedDB) throw new Error('This browser cannot securely store Glean encryption keys.');
  const id = Number(accountId);
  const cached = identityCache.get(id);
  if (cached?.privateKey && cached?.publicKey && (!username || cached.username === username)) return cached;

  const existing = await readIdentity(id);
  if (existing?.privateKey && existing?.publicKey) {
    if (!username || existing.username === username) return existing;
    const record = { ...existing, accountId: id, username: username || existing.username || null };
    await writeIdentity(record);
    return record;
  }

  const stored = await listStoredIdentities();
  const fallback = stored.find((record) => username && record.username && record.username.toLowerCase() === username.toLowerCase())
    || stored.find(record => Number(record.accountId) === id);
  if (fallback?.privateKey && fallback?.publicKey) {
    const record = { ...fallback, accountId: id, username: username || fallback.username || null };
    await writeIdentity(record);
    return record;
  }

  const generated = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = await crypto.subtle.exportKey('jwk', generated.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', generated.privateKey);
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const record = {
    accountId: id,
    username: username || null,
    privateKey,
    privateJwk,
    publicKey,
    fingerprint: await fingerprintPublicKey(publicKey),
    createdAt: new Date().toISOString(),
  };
  await writeIdentity(record);
  return record;
}

const syncRequests = new Map();
const resetRequests = new Map();
const syncCheckedAt = new Map();
export function createKeySyncCode() { return randomToken(32); }
export async function savedKeySyncCode(accountId) { return await syncCode(accountId) || ''; }

async function saveSyncCode(accountId, code) {
  const db = await openDatabase();
  try {
    await requestValue(db.transaction(VAULT, 'readwrite').objectStore(VAULT).put({ fingerprint: `sync:${Number(accountId)}`, code }));
  } finally { db.close(); }
}

async function syncCode(accountId) {
  const db = await openDatabase();
  try { return (await requestValue(db.transaction(VAULT, 'readonly').objectStore(VAULT).get(`sync:${Number(accountId)}`)))?.code; }
  finally { db.close(); }
}

export function resetE2EEIdentity(accountId, username, password) {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(new Error('Sign in again before resetting DM encryption.'));
  if (resetRequests.has(id)) return resetRequests.get(id);
  const pending = (async () => {
    const inFlight = syncRequests.get(id);
    if (inFlight) await inFlight.catch(() => {});
    syncRequests.delete(id);
    if (!password || password.length > 256) throw new Error('Enter your current password to reset DM encryption.');

    // Keep the existing local key in the archive. The new one becomes active only
    // after the server accepts the password and the revision-checked key rotation.
    await ensureLocalIdentity(id, username);
    const generated = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await crypto.subtle.exportKey('jwk', generated.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', generated.privateKey);
    const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const identity = {
      accountId: id,
      username: username || null,
      privateKey,
      privateJwk,
      publicKey,
      fingerprint: await fingerprintPublicKey(publicKey),
      createdAt: new Date().toISOString(),
    };
    const code = createKeySyncCode();
    const syncKey = await crypto.subtle.importKey('raw', base64UrlToBytes(code), 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload = JSON.stringify({
      activeFingerprint: identity.fingerprint,
      identities: [{ privateJwk, publicKey, fingerprint: identity.fingerprint }],
    });
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`glean-key-sync-v1:${id}`) },
      syncKey,
      encoder.encode(payload),
    );
    const vault = await apiRequest('/e2ee/sync');
    // Stage the private key locally before committing the server-side rotation.
    await writeVaultIdentity(identity);
    await apiRequest('/e2ee/reset', {
      method: 'POST',
      body: JSON.stringify({
        password,
        revision: vault.revision,
        publicKey,
        fingerprint: identity.fingerprint,
        envelope: { version: 1, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) },
      }),
    });

    identityCache.set(id, identity);
    syncCheckedAt.set(id, Date.now());
    syncRequests.delete(id);
    await writeIdentity(identity);
    let syncCodeSaved = true;
    try { await saveSyncCode(id, code); } catch { syncCodeSaved = false; }
    window.dispatchEvent(new CustomEvent('glean-encryption-synced', { detail: { accountId: id, fingerprint: identity.fingerprint } }));
    return { identity, syncCode: code, syncCodeSaved };
  })();
  resetRequests.set(id, pending);
  return pending.finally(() => {
    if (resetRequests.get(id) === pending) resetRequests.delete(id);
  });
}

export async function syncEncryptionKeys(accountId, username, suppliedCode) {
  const id = Number(accountId);
  const code = suppliedCode?.trim() || await syncCode(id);
  const remote = await apiRequest('/e2ee/sync');
  if (!code) {
    const local = await ensureLocalIdentity(id, username);
    if (!remote.envelope) return local;
    const stored = await listStoredIdentities();
    const matching = stored.find((record) => Number(record.accountId) === id && samePublicKey(record.publicKey, remote.publicKey));
    return matching
      ? { ...matching, accountId: id, username: username || matching.username || null }
      : { ...local, serverKeyMismatch: true };
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(code) || base64UrlToBytes(code).length !== 32) throw new Error('Enter the 43-character sync code from your other device.');
  const key = await crypto.subtle.importKey('raw', base64UrlToBytes(code), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const aad = encoder.encode(`glean-key-sync-v1:${id}`);
  const local = await ensureLocalIdentity(id, username);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const vault = attempt ? await apiRequest('/e2ee/sync') : remote;
    let payload = { activeFingerprint: local.fingerprint, identities: [] };
    if (vault.envelope) {
      try {
        const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(vault.envelope.iv), additionalData: aad }, key, base64UrlToBytes(vault.envelope.ciphertext));
        payload = JSON.parse(decoder.decode(clear));
      } catch { throw new Error('That sync code cannot unlock your keys. Use the code from the first linked device.'); }
    }
    if (!Array.isArray(payload.identities) || payload.identities.length > 64) throw new Error('Invalid encryption key vault.');
    const records = await listStoredIdentities();
    const merged = new Map(payload.identities.map(record => [record.fingerprint, record]));
    for (const record of records.filter(record => Number(record.accountId) === id)) {
      const privateJwk = record.privateJwk || await crypto.subtle.exportKey('jwk', record.privateKey);
      merged.set(record.fingerprint, { privateJwk, publicKey: record.publicKey, fingerprint: record.fingerprint });
    }
    if (merged.size > 64) throw new Error('The encryption key vault is full.');
    payload.identities = [...merged.values()];
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(JSON.stringify(payload)));
    try {
      const activeRecord = payload.identities.find(record => record.fingerprint === payload.activeFingerprint);
      if (!activeRecord) throw new Error('Missing active encryption key.');
      await apiRequest('/e2ee/sync', { method: 'PUT', body: JSON.stringify({ revision: vault.revision, publicKey: activeRecord.publicKey, envelope: { version: 1, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) } }) });
    } catch (error) { if (error.status === 409 && attempt < 2) continue; throw error; }
    let active;
    for (const record of payload.identities) {
      if (record.fingerprint !== await fingerprintPublicKey(record.publicKey)) throw new Error('Invalid synced key fingerprint.');
      const restored = await hydrateIdentity({ ...record, accountId: id, username, createdAt: new Date().toISOString() });
      if (!restored) throw new Error('Invalid synced private key.');
      await writeIdentity(restored);
      if (record.fingerprint === payload.activeFingerprint) active = restored;
    }
    if (!active) throw new Error('Missing active encryption key.');
    await writeIdentity(active);
    const db = await openDatabase();
    try { await requestValue(db.transaction(VAULT, 'readwrite').objectStore(VAULT).put({ fingerprint: `sync:${id}`, code })); }
    finally { db.close(); }
    await apiRequest('/e2ee/key', { method: 'PUT', body: JSON.stringify({ publicKey: active.publicKey, fingerprint: active.fingerprint }) });
    syncCheckedAt.set(id, Date.now());
    window.dispatchEvent(new CustomEvent('glean-encryption-synced', { detail: { accountId: id } }));
    return active;
  }
}

export async function ensureE2EEIdentity(accountId, username) {
  const id = Number(accountId);
  if (resetRequests.has(id)) return resetRequests.get(id).then((result) => result.identity);
  if (Date.now() - (syncCheckedAt.get(id) || 0) < 30_000) return ensureLocalIdentity(id, username);
  if (syncRequests.has(id)) return syncRequests.get(id);
  // Startup restores local keys only. It must never rewrite the shared vault.
  const pending = (async () => {
    const local = await ensureLocalIdentity(id, username);
    const remote = await apiRequest('/e2ee/sync');
    if (!remote.envelope) return local;
    const code = await syncCode(id);
    if (code) {
      try {
        const key = await crypto.subtle.importKey('raw', base64UrlToBytes(code), 'AES-GCM', false, ['decrypt']);
        const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(remote.envelope.iv), additionalData: encoder.encode(`glean-key-sync-v1:${id}`) }, key, base64UrlToBytes(remote.envelope.ciphertext));
        const payload = JSON.parse(decoder.decode(clear));
        if (!Array.isArray(payload.identities) || payload.identities.length > 64) throw new Error('Invalid saved encryption vault.');
        const restored = [];
        for (const record of payload.identities) {
          if (record.fingerprint !== await fingerprintPublicKey(record.publicKey)) throw new Error('Invalid saved key fingerprint.');
          const hydrated = await hydrateIdentity({ ...record, accountId: id, username, createdAt: new Date().toISOString() });
          if (!hydrated) throw new Error('Invalid saved private key.');
          restored.push(hydrated);
        }
        // Archive the existing identity before any active identity is replaced.
        await writeIdentity(local);
        for (const record of restored) await writeIdentity(record);
      } catch (error) {
        console.warn('Glean could not restore the saved encrypted key vault; existing local keys are preserved.', error.name);
      }
    }
    const stored = await listStoredIdentities();
    const matching = stored.find(record => Number(record.accountId) === id && samePublicKey(record.publicKey, remote.publicKey));
    const selected = matching
      ? { ...matching, accountId: id, username: username || matching.username || null, serverKeyMismatch: false }
      : { ...local, serverKeyMismatch: true };
    identityCache.set(id, selected);
    return selected;
  })().then(identity => { syncCheckedAt.set(id, Date.now()); return identity; });
  syncRequests.set(id, pending);
  try { return await pending; } finally { syncRequests.delete(id); }
}

async function deriveAesKey(identity, peerPublicJwk, salt, info) {
  if (!peerPublicJwk) throw new Error('The other person has not initialized encrypted messaging yet.');
  const peerKey = await crypto.subtle.importKey('jwk', peerPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, identity.privateKey, 256);
  const hkdfBase = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function counterpartPublicKey(accountId, senderId, cryptoEnvelope) {
  return Number(senderId) === Number(accountId) ? cryptoEnvelope.recipientPublicKey : cryptoEnvelope.senderPublicKey;
}

function peerPublicKeyForIdentity(identity, cryptoEnvelope) {
  if (samePublicKey(identity.publicKey, cryptoEnvelope.senderPublicKey)) return cryptoEnvelope.recipientPublicKey;
  if (samePublicKey(identity.publicKey, cryptoEnvelope.recipientPublicKey)) return cryptoEnvelope.senderPublicKey;
  return null;
}

function aadCandidates(conversationId, clientMessageId) {
  const ids = [conversationId, Number(conversationId), String(conversationId)];
  const unique = [...new Set(ids.map((value) => String(value)))];
  return unique.map((id) => encoder.encode(`glean:${id}:${clientMessageId || ''}`));
}

export async function prepareEncryptedMessage(identity, conversation, text, files = []) {
  if (identity?.serverKeyMismatch) throw new Error('This browser is missing your existing message key. Restore it from a device that can still read your DMs before sending.');
  const peerPublicKey = conversation?.user?.publicKey;
  if (!peerPublicKey) throw new Error(`${conversation?.user?.username || 'This friend'} must open the updated Glean app once before encrypted DMs can be sent.`);
  const uploadFiles = await prepareUploadFiles(files);
  const clientMessageId = randomToken(24);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(identity, peerPublicKey, salt, 'glean-message-v1');
  const aad = encoder.encode(`glean:${conversation.id}:${clientMessageId}`);
  const privatePayload = JSON.stringify({
    text: String(text || ''),
    attachments: uploadFiles.map((file) => ({ name: file.name, type: file.type || 'application/octet-stream', size: file.size })),
  });
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(privatePayload));

  const encryptedFiles = [];
  const attachmentMeta = [];
  for (const file of uploadFiles) {
    const fileSalt = crypto.getRandomValues(new Uint8Array(32));
    const fileIv = crypto.getRandomValues(new Uint8Array(12));
    const fileKey = await deriveAesKey(identity, peerPublicKey, fileSalt, 'glean-attachment-v1');
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIv }, fileKey, await file.arrayBuffer());
    encryptedFiles.push(new File([encrypted], 'encrypted.glean', { type: 'application/octet-stream' }));
    attachmentMeta.push({ size: file.size, iv: bytesToBase64Url(fileIv), salt: bytesToBase64Url(fileSalt) });
  }

  return {
    envelope: {
      version: 1,
      clientMessageId,
      ciphertext: bytesToBase64Url(ciphertext),
      iv: bytesToBase64Url(iv),
      salt: bytesToBase64Url(salt),
      senderPublicKey: identity.publicKey,
      recipientPublicKey: peerPublicKey,
    },
    attachmentMeta,
    encryptedFiles,
  };
}

function decodePayload(decoded) {
  let privatePayload = { text: decoded, attachments: [] };
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') privatePayload = parsed;
  } catch { /* early text-only messages */ }
  return privatePayload;
}

async function tryDecryptWith(identity, message, conversationId) {
  const peerPublicKey = peerPublicKeyForIdentity(identity, message.crypto)
    || counterpartPublicKey(identity.accountId, message.sender.id, message.crypto);
  const salt = base64UrlToBytes(message.crypto.salt);
  const iv = base64UrlToBytes(message.crypto.iv);
  const ciphertext = base64UrlToBytes(message.crypto.ciphertext);
  const key = await deriveAesKey(identity, peerPublicKey, salt, 'glean-message-v1');
  const attempts = [...aadCandidates(conversationId, message.clientMessageId), null];
  for (const additionalData of attempts) {
    try {
      const plaintext = await crypto.subtle.decrypt(
        additionalData ? { name: 'AES-GCM', iv, additionalData } : { name: 'AES-GCM', iv },
        key,
        ciphertext,
      );
      const privatePayload = decodePayload(decoder.decode(plaintext));
      const attachments = (message.attachments || []).map((attachment, index) => ({
        ...attachment,
        name: privatePayload.attachments?.[index]?.name || attachment.name,
        type: privatePayload.attachments?.[index]?.type || attachment.type,
        size: Number(privatePayload.attachments?.[index]?.size ?? attachment.size),
      }));
      return { ...message, body: privatePayload.text, attachments, decryptionFailed: false };
    } catch { /* try next AAD */ }
  }
  return null;
}

export async function decryptMessage(identity, message, conversationId) {
  if (message?.replyTo?.encrypted && message.replyTo.crypto) {
    const reply = await decryptMessage(identity, { ...message.replyTo, replyTo: null }, conversationId);
    message = { ...message, replyTo: { ...message.replyTo, body: reply.body } };
  }
  if (!message?.encrypted || !message.crypto) return message;
  const stored = await listStoredIdentities();
  const matching = stored.filter((record) => peerPublicKeyForIdentity(record, message.crypto));
  const seen = new Set();
  const candidates = [identity, ...matching, ...stored].filter((record) => {
    if (!record?.fingerprint || seen.has(record.fingerprint)) return false;
    seen.add(record.fingerprint);
    return true;
  });
  for (const candidate of candidates) {
    try {
      const decrypted = await tryDecryptWith(candidate, message, conversationId);
      if (decrypted) return decrypted;
    } catch { /* next identity */ }
  }
  return { ...message, body: 'Unable to decrypt this message on this device.', decryptionFailed: true };
}

export async function decryptAttachment(accountId, attachment, message) {
  const identity = await ensureE2EEIdentity(accountId);
  const response = await fetch(attachment.url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Unable to download encrypted attachment.');
  const encryptedBytes = await response.arrayBuffer();
  const envelope = attachment.crypto || message.crypto;
  const stored = await listStoredIdentities();
  const candidates = [identity, ...stored];
  for (const candidate of candidates) {
    try {
      const peerPublicKey = peerPublicKeyForIdentity(candidate, envelope) || counterpartPublicKey(accountId, message.sender.id, envelope);
      const key = await deriveAesKey(candidate, peerPublicKey, base64UrlToBytes(envelope.salt), 'glean-attachment-v1');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(envelope.iv) }, key, encryptedBytes);
      return new Blob([plaintext], { type: attachment.type || 'application/octet-stream' });
    } catch { /* next identity */ }
  }
  throw new Error('Unable to decrypt this attachment on this device.');
}
