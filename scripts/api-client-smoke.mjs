import { strict as assert } from 'node:assert';
import { apiRequest, ApiError } from '../src/app/apiClient.js';
import { apiRoutes } from '../src/app/apiRoutes.js';
import { patchCachedServerUnreadSummary, patchServerUnreadSummary, peekCachedServers, rememberServers } from '../src/app/serverCache.js';

const originalFetch = globalThis.fetch;
try {
  let attempts = 0;
  globalThis.fetch = async (url, options) => {
    attempts += 1;
    assert.equal(url, '/api/v1/servers');
    assert.equal(options.credentials, 'same-origin');
    if (attempts === 1) throw new TypeError('temporary network failure');
    return new Response('{"servers":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  assert.deepEqual(await apiRequest(apiRoutes.servers), { servers: [] });
  assert.equal(attempts, 2, 'GET retries once after a network failure');

  globalThis.fetch = async () => new Response('{"error":"Not found","requestId":"req-test"}', {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-header' },
  });
  await assert.rejects(apiRequest('/missing'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    assert.equal(error.requestId, 'req-test');
    return true;
  });

  attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError('temporary network failure');
  };
  await assert.rejects(apiRequest('/messages', { method: 'POST', body: '{}' }), ApiError);
  assert.equal(attempts, 1, 'message sends are never automatically replayed');

  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(apiRequest('/slow', { timeoutMs: 5, retries: 0 }), /timed out/i);

  if (typeof FormData !== 'undefined') {
    let uploadHeaders;
    globalThis.fetch = async (_url, options) => {
      uploadHeaders = options.headers;
      return new Response('{}', { status: 200 });
    };
    const form = new FormData();
    form.append('files', new Blob(['file']), 'test.txt');
    await apiRequest('/uploads', { method: 'POST', body: form });
    assert.equal(uploadHeaders['Content-Type'], undefined, 'browser sets the multipart boundary');
  }

  assert.equal(apiRoutes.conversationMessages(12), '/conversations/12/messages');
  assert.equal(apiRoutes.directConversation('someone+test'), '/conversations/direct/someone%2Btest');
  assert.throws(() => apiRoutes.channelMessages('not-an-id'), TypeError);
  assert.throws(() => apiRoutes.directConversation('  '), TypeError);
  await assert.rejects(apiRequest('https://example.com/'), TypeError);

  const originalSessionStorage = globalThis.sessionStorage;
  const stored = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  rememberServers({ servers: [{ id: 17, name: 'Glean', unread: false, unreadCount: 0, mentionCount: 0 }] });
  assert.equal(patchCachedServerUnreadSummary({ serverId: 17, serverUnread: true, serverUnreadCount: 3, serverMentionCount: 1 }), true);
  assert.deepEqual(peekCachedServers().servers[0], {
    id: 17, name: 'Glean', unread: true, unreadCount: 3, mentionCount: 1,
  }, 'live server unread events update the shared cached summary');
  const untouched = [{ id: 17, unread: false, unreadCount: 0 }];
  assert.deepEqual(patchServerUnreadSummary(untouched, { serverId: 17, serverUnreadCount: 0 }), [
    { id: 17, unread: false, unreadCount: 0 },
  ]);
  if (originalSessionStorage === undefined) delete globalThis.sessionStorage;
  else globalThis.sessionStorage = originalSessionStorage;
  console.log('API client smoke test passed.');
} finally {
  globalThis.fetch = originalFetch;
}
