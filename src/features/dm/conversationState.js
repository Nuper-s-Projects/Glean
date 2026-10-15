import { retainLocalImagePreviews } from '../../app/attachmentPreviews.js';

export function selectConversations(conversations, query = '', filter = 'all') {
  const needle = query.trim().toLocaleLowerCase();
  return conversations.filter((conversation) => {
    if (filter === 'unread' && (!conversation.unreadCount || conversation.muted)) return false;
    if (filter === 'pinned' && !conversation.pinned) return false;
    return !needle || `${conversation.name || conversation.user?.username || ''}\n${(conversation.members || []).map(member => member.username).join(' ')}\n${conversation.lastMessage || ''}`.toLocaleLowerCase().includes(needle);
  }).sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    || (Date.parse(right.lastMessageAt) || 0) - (Date.parse(left.lastMessageAt) || 0)
    || Number(right.id) - Number(left.id));
}

export function selectUnstartedFriends(friends, conversations, query = '', filter = 'all') {
  if (filter !== 'all') return [];
  const represented = new Set(conversations.filter(conversation => conversation.kind !== 'group').map(conversation => Number(conversation.user?.id)));
  const needle = query.trim().toLocaleLowerCase();
  return friends.filter(friend => {
    const id = Number(friend.id);
    if (!Number.isSafeInteger(id) || id <= 0 || represented.has(id)) return false;
    represented.add(id);
    return !needle || String(friend.username || '').toLocaleLowerCase().includes(needle);
  }).sort((left, right) => String(left.username || '').localeCompare(String(right.username || ''), undefined, { sensitivity: 'base' }));
}

export function reconcileSentMessage(messages, optimisticId, message) {
  message = retainLocalImagePreviews(message, messages.find(item => Number(item.id) === Number(message.id)));
  const remaining = messages.filter((item) => item.id !== optimisticId
    && Number(item.id) !== Number(message.id)
    && !(message.clientMessageId && item.clientMessageId === message.clientMessageId));
  return [...remaining, { ...message, status: 'sent' }].sort((left, right) =>
    (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0)
    || (Number(left.id) || 0) - (Number(right.id) || 0));
}

export function preserveReadableMessages(incoming, current) {
  const readable = new Map(current.filter((message) => message.decryptionFailed === false).map((message) => [Number(message.id), message]));
  return incoming.map((message) => message.decryptionFailed && readable.has(Number(message.id))
    ? { ...message, ...readable.get(Number(message.id)) }
    : message);
}

export function recentHistorySnapshot(current, incoming, hasMore) {
  if (!hasMore || !incoming.length) return incoming;
  const oldestId = Math.min(...incoming.map(message => Number(message.id)).filter(Number.isSafeInteger));
  return [...current.filter(message => Number.isSafeInteger(Number(message.id)) && Number(message.id) < oldestId), ...incoming];
}

export function trimInactiveTranscripts(cache, selectedId) {
  for (const [id, transcript] of cache) {
    if (Number(id) === Number(selectedId)) continue;
    if (transcript.messages.some(message => message.status && message.status !== 'sent')) continue;
    cache.delete(id);
  }
}
