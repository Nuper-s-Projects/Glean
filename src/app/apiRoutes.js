function id(value, name) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return String(numeric);
}

export const apiRoutes = Object.freeze({
  servers: '/servers',
  publicServers: '/public-servers',
  publicServerJoin: (serverId) => `/public-servers/${id(serverId, 'Server id')}/join`,
  server: (serverId) => `/servers/${id(serverId, 'Server id')}`,
  serverMembers: (serverId) => `/servers/${id(serverId, 'Server id')}/members`,
  serverAuditLog: (serverId, before) => `/servers/${id(serverId, 'Server id')}/audit-log${before ? `?before=${encodeURIComponent(before)}` : ''}`,
  serverOrder: '/servers/order',
  serverChannels: (serverId) => `/servers/${id(serverId, 'Server id')}/channels`,
  serverChannel: (serverId, channelId) => `/servers/${id(serverId, 'Server id')}/channels/${id(channelId, 'Channel id')}`,
  serverChannelClearMessages: (serverId, channelId) => `/servers/${id(serverId, 'Server id')}/channels/${id(channelId, 'Channel id')}/clear-messages`,
  serverChannelMessageCleanup: (serverId, channelId) => `/servers/${id(serverId, 'Server id')}/channels/${id(channelId, 'Channel id')}/message-cleanup`,
  channelMessages: (channelId) => `/channels/${id(channelId, 'Channel id')}/messages`,
  channelMessage: (channelId, messageId) => `/channels/${id(channelId, 'Channel id')}/messages/${id(messageId, 'Message id')}`,
  conversation: (conversationId) => `/conversations/${id(conversationId, 'Conversation id')}`,
  conversationMessages: (conversationId) => `/conversations/${id(conversationId, 'Conversation id')}/messages`,
  conversationMessage: (conversationId, messageId) => `/conversations/${id(conversationId, 'Conversation id')}/messages/${id(messageId, 'Message id')}`,
  directConversation: (username) => {
    const clean = String(username || '').trim();
    if (!clean) throw new TypeError('Username is required to route a direct conversation.');
    return `/conversations/direct/${encodeURIComponent(clean)}`;
  },
});
