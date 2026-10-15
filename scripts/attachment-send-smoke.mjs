import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareUploadFiles } from '../src/app/imageUpload.js';
import { apiRequest } from '../src/app/apiClient.js';
import { pendingImagePreviews, withLocalImagePreviews, retainLocalImagePreviews } from '../src/app/attachmentPreviews.js';

let decodes = 0;
globalThis.createImageBitmap = async () => {
  decodes++;
  await new Promise(resolve => setTimeout(resolve, 5));
  return { width: 100, height: 100, close() {} };
};
const image = new File(['image'], 'small.png', { type: 'image/png' });
const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
assert.equal(pendingImagePreviews([video, image]).length, 1);
assert.equal(pendingImagePreviews([image])[0].localFile, image);
const encryptedAttachment = { id: 55, name: 'small.png', type: 'image/png', encrypted: true };
const previewMessage = withLocalImagePreviews({ attachments: [encryptedAttachment] }, [image]);
assert.equal(previewMessage.attachments[0].localFile, image);
assert.equal(previewMessage.attachments[0].encrypted, true, 'preview never changes encryption metadata');
assert.equal(encryptedAttachment.localFile, undefined, 'server payload is not mutated');
assert.equal(retainLocalImagePreviews({ attachments: [encryptedAttachment] }, previewMessage).attachments[0].localFile, image, 'realtime updates retain the preview for the same attachment');
assert.equal(retainLocalImagePreviews({ attachments: [{ ...encryptedAttachment, id: 56 }] }, previewMessage).attachments[0].localFile, undefined, 'different attachment IDs never inherit a preview');
const [selected, sent] = await Promise.all([prepareUploadFiles([image]), prepareUploadFiles([image])]);
assert.equal(decodes, 1, 'selection and send share one preparation');
assert.equal(selected[0], image);
assert.equal(sent[0], image);
await prepareUploadFiles(selected);
assert.equal(decodes, 1, 'prepared images are not decoded again');

let status = 201;
let mode = 'success';
let requests = 0;
globalThis.XMLHttpRequest = class {
  upload = {};
  headers = {};
  open(method, url) { assert.equal(method, 'POST'); assert.equal(url, '/api/v1/upload-test'); }
  setRequestHeader(key, value) { this.headers[key] = value; }
  getResponseHeader() { return 'upload-test-request'; }
  abort() { this.onabort(); }
  send(body) {
    requests++;
    assert.ok(body instanceof FormData);
    assert.equal(this.headers['Content-Type'], undefined, 'browser sets the multipart boundary');
    if (mode === 'timeout') return;
    queueMicrotask(() => {
      if (mode === 'network') return this.onerror();
      this.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 });
      this.upload.onload();
      this.status = status;
      this.responseText = status === 201 ? '{"ok":true}' : '{"error":"Not allowed"}';
      this.onload();
    });
  }
};
const form = new FormData();
form.append('files', image);
const progress = [];
assert.deepEqual(await apiRequest('/upload-test', { method: 'POST', body: form, onUploadProgress: percent => progress.push(percent) }), { ok: true });
assert.deepEqual(progress, [50, 100]);
status = 403;
await assert.rejects(apiRequest('/upload-test', { method: 'POST', body: form, onUploadProgress() {} }), error => error.status === 403 && error.message === 'Not allowed');
mode = 'network';
const before = requests;
await assert.rejects(apiRequest('/upload-test', { method: 'POST', body: form, onUploadProgress() {} }), /Could not reach/);
assert.equal(requests - before, 1, 'failed message uploads are never automatically replayed');
mode = 'timeout';
await assert.rejects(apiRequest('/upload-test', { method: 'POST', body: form, timeoutMs: 5, onUploadProgress() {} }), /timed out/);
const controller = new AbortController();
const upload = apiRequest('/upload-test', { method: 'POST', body: form, signal: controller.signal, onUploadProgress() {} });
controller.abort(new Error('Cancelled by user'));
await assert.rejects(upload, /Cancelled by user/);
console.log('PASS attachment preparation deduplication, upload progress, HTTP errors, no automatic replay, timeout and cancellation.');

// Run the actual screen handler with controlled network completions.
const communitySource = await readFile(new URL('../src/screens/CommunityScreen.jsx', import.meta.url), 'utf8');
const handler = communitySource.slice(communitySource.indexOf('  const submitMessage = async'), communitySource.indexOf('  const beginEdit ='));
let messages = [];
let draft = 'preserve this new draft';
const calls = [];
const channelRef = { current: { id: 1 } };
const context = {
  channel: { id: 1 }, inspecting: false, postLock: false, isSending: false, sendingRef: { current: false },
  normalizePoll: () => null, setNotice() {}, setIsSending() {}, replyTo: null, account: { id: 2, username: 'Uploader' },
  pendingImagePreviews, withLocalImagePreviews,
  setMessages: update => { messages = update(messages); }, setReplyTo() {}, channelRef, applyChannelPatch() {},
  sendChannelMessage: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
  upsertChannelMessage: (current, message) => [...current.filter(item => item.id !== message.id), message],
};
const submit = new Function(...Object.keys(context), `let pendingMessageSequence=-Date.now();${handler};return submitMessage;`)(...Object.values(context));
const submitDraft = (body, files = [image]) => submit({ preventDefault() {} }, {
  draft: body, attachments: files, poll: null, setDraft: value => { draft = value; }, setAttachments() {}, setPoll() {},
});
await submitDraft('photo one');
await submitDraft('photo two');
assert.equal(calls.length, 2, 'second send begins while the first is unresolved');
assert.equal(messages.length, 2);
assert.equal(messages[0].attachments[0].localFile, image, 'pending message displays the image before upload completion');
assert.notEqual(messages[0].id, messages[1].id);
calls[0].args[5](35);
assert.equal(messages[0].sendLabel, 'Uploading 35%');
draft = 'new draft must survive a failed upload';
calls[1].reject(new Error('Network unavailable'));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(messages[1].status, 'failed');
assert.equal(draft, 'new draft must survive a failed upload');
const retry = messages[1].retrySend();
assert.equal(calls.length, 3);
calls[2].resolve({ message: { id: 102, body: 'photo two' } });
await retry;
calls[0].resolve({ message: { id: 101, body: 'photo one' } });
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(messages.map(item => item.id).sort(), [101, 102]);
await submitDraft('old channel upload');
channelRef.current = { id: 9 };
messages = [];
calls[3].resolve({ message: { id: 103 } });
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(messages, [], 'completion must not leak into another channel');
console.log('PASS actual server composer handler: overlapping sends, independent progress, failure retry, new draft preservation and channel navigation.');
