import assert from 'node:assert/strict';
import { preserveReadableMessages, recentHistorySnapshot, reconcileSentMessage, selectConversations, selectUnstartedFriends } from '../src/features/dm/conversationState.js';
import { mergePeoplePages } from '../src/features/dm/discoverPeopleState.js';

const conversations = [
  { id: 1, pinned: false, unreadCount: 0, user: { username: 'Alice' }, lastMessage: 'hello', lastMessageAt: '2026-10-09T12:00:00Z' },
  { id: 2, pinned: true, unreadCount: 0, user: { username: 'Bob' }, lastMessage: 'older', lastMessageAt: '2026-10-08T12:00:00Z' },
  { id: 3, pinned: false, unreadCount: 2, user: { username: 'Carol' }, lastMessage: 'recent', lastMessageAt: '2026-10-10T12:00:00Z' },
];
assert.deepEqual(selectConversations(conversations).map(item => item.id), [2, 3, 1]);
assert.deepEqual(selectConversations(conversations, '', 'unread').map(item => item.id), [3]);
assert.deepEqual(selectConversations(conversations, '', 'pinned').map(item => item.id), [2]);
assert.deepEqual(selectConversations(conversations, '  ALICE ').map(item => item.id), [1]);
assert.deepEqual(selectConversations(conversations, 'recent').map(item => item.id), [3]);
assert.deepEqual(conversations.map(item => item.id), [1, 2, 3]);
const friends = [{ id: 10, username: 'Alice' }, { id: 20, username: 'Zoe' }, { id: 30, username: 'dave' }, { id: 20, username: 'Zoe' }];
const friendChats = [{ id: 1, user: { id: '10', username: 'Alice' } }, { id: 2, user: { id: 40, username: 'Not a friend' } }];
assert.deepEqual(selectUnstartedFriends(friends, friendChats).map(friend => friend.id), [30, 20]);
assert.deepEqual(selectUnstartedFriends(friends, friendChats, '  ZOE ').map(friend => friend.id), [20]);
assert.deepEqual(selectUnstartedFriends(friends, friendChats, 'Alice'), []);
assert.deepEqual(selectUnstartedFriends(friends, friendChats, '', 'unread'), []);
assert.deepEqual(selectUnstartedFriends(friends, friendChats, '', 'pinned'), []);
assert.deepEqual(selectUnstartedFriends([], friendChats), []);
assert.deepEqual(selectUnstartedFriends(friends, [...friendChats, { id: 3, user: { id: 30 } }]).map(friend => friend.id), [20]);
assert.equal(friends.length, 4);
assert.deepEqual(mergePeoplePages([{ id: 3, username: 'old' }, { id: 1 }], [{ id: 3, username: 'new' }, { id: 600 }]), [{ id: 1 }, { id: 3, username: 'new' }, { id: 600 }]);
const pending = { id: 'pending-1', clientMessageId: 'same-envelope', body: 'hello', createdAt: '2026-10-10T12:00:00Z' };
const sent = { id: 7, clientMessageId: 'same-envelope', body: 'hello', createdAt: '2026-10-10T12:00:00Z' };
assert.deepEqual(reconcileSentMessage([pending, sent], pending.id, sent).map(item => item.id), [7]);
assert.equal(reconcileSentMessage([pending, sent], pending.id, sent)[0].status, 'sent');
const readable = { id: 7, body: 'secret', decryptionFailed: false };
assert.equal(preserveReadableMessages([{ id: 7, body: 'failed', decryptionFailed: true }], [readable])[0].body, 'secret');
assert.equal(preserveReadableMessages([{ id: 7, body: 'updated', decryptionFailed: false }], [readable])[0].body, 'updated');
assert.deepEqual(recentHistorySnapshot([{ id: 1 }, { id: 5 }, { id: 6 }], [{ id: 5 }, { id: 7 }], true).map(item => item.id), [1, 5, 7]);
assert.deepEqual(recentHistorySnapshot([{ id: 1 }, { id: 6 }], [{ id: 7 }], false).map(item => item.id), [7]);
assert.deepEqual(recentHistorySnapshot([{ id: 1 }], [], false), []);
console.log('DM state regression checks passed.');
