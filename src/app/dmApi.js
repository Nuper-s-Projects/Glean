import { parseInviteInput } from './invite';
import { bindPresenceActivity, clearPresenceActivity, ingestPresence } from './presence';
import { API_PREFIX, apiRequest as request } from './apiClient';
import { isDeveloperModeEnabled, recordDeveloperTraffic } from './developerMode.js';
import { apiRoutes } from './apiRoutes';
import { prepareUploadFiles } from './imageUpload';
import { invalidateLoopEvent } from './loopCache.js';
import {
  clearServersRequest,
  getFreshCachedServers,
  getServersCacheEpoch,
  getServersRequest,
  invalidateServersCache,
  patchCachedServerUnreadSummary,
  patchServerUnreadSummary,
  peekCachedServers,
  rememberServers,
  setServersRequest,
} from './serverCache';

export { invalidateServersCache, patchCachedServerUnreadSummary, patchServerUnreadSummary, peekCachedServers } from './serverCache';

export async function registerE2EEKey(publicKey, fingerprint) {
  return request('/e2ee/key', { method: 'PUT', body: JSON.stringify({ publicKey, fingerprint }) });
}

export async function getFriends() { return request('/friends'); }
export async function getPeople({ query = '', filter = 'all', attributes = [], cursor = 0, limit = 50, signal } = {}) {
  const params = new URLSearchParams({ query, filter, cursor: String(cursor), limit: String(limit) });
  if (attributes.length) params.set('attributes', attributes.join(','));
  return request(`/people?${params}`, { signal });
}
export async function getAnalytics() { return request('/analytics'); }
export async function getAnalyticsPeople({ query = '', cursor = 0, limit = 50 } = {}) {
  const params = new URLSearchParams({ query, cursor: String(cursor), limit: String(limit) });
  return request(`/analytics/people?${params}`);
}
export async function getPublicServers({ query = '', cursor = 0, limit = 24 } = {}) {
  const params = new URLSearchParams({ query, cursor: String(cursor), limit: String(limit) });
  return request(`${apiRoutes.publicServers}?${params}`);
}
export async function joinPublicServer(serverId) {
  invalidateServersCache();
  return request(apiRoutes.publicServerJoin(serverId), { method: 'POST', body: '{}' });
}
export async function getUserProfile(username) { return request(`/users/${encodeURIComponent(username)}`); }
export async function getVerifiedUsers(query = '') { return request(`/account/verified-users?q=${encodeURIComponent(query)}`); }
export async function setUserVerified(userId, verified) { return request(`/account/verified-users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ verified: Boolean(verified) }) }); }
export async function updateUserNote(username, note) {
  return request(`/users/${encodeURIComponent(username)}/note`, { method: 'PATCH', body: JSON.stringify({ note }) });
}
export async function sendFriendRequest(username) { return request('/friends/requests', { method: 'POST', body: JSON.stringify({ username }) }); }
export async function acceptFriendRequest(id) { return request(`/friends/requests/${id}/accept`, { method: 'POST' }); }
export async function declineFriendRequest(id) { return request(`/friends/requests/${id}/decline`, { method: 'POST' }); }
export async function cancelFriendRequest(id) { return request(`/friends/requests/${id}`, { method: 'DELETE' }); }
export async function unfriendUser(username) { return request(`/friends/${encodeURIComponent(username)}`, { method: 'DELETE' }); }
export async function getBlockedUsers() { return request('/blocks'); }
export async function blockUser(username) { return request('/blocks', { method: 'POST', body: JSON.stringify({ username }) }); }
export async function unblockUser(username) { return request(`/blocks/${encodeURIComponent(username)}`, { method: 'DELETE' }); }
export async function getConversations() { return request('/conversations'); }
export async function createGroupConversation(name, memberIds) { return request('/conversations/groups', { method: 'POST', body: JSON.stringify({ name, memberIds }) }); }
export async function renameGroupConversation(id, name) { return request(`/conversations/${id}/group`, { method: 'PATCH', body: JSON.stringify({ name }) }); }
export async function addGroupMember(id, userId) { return request(`/conversations/${id}/group/members`, { method: 'POST', body: JSON.stringify({ userId }) }); }
export async function removeGroupMember(id, userId) { return request(`/conversations/${id}/group/members/${userId}`, { method: 'DELETE' }); }
export async function leaveGroupConversation(id) { return request(`/conversations/${id}/group/leave`, { method: 'POST', body: '{}' }); }
export async function setConversationMuted(id, muted) { return request(`/conversations/${id}/mute`, { method: 'PATCH', body: JSON.stringify({ muted }) }); }
export async function setConversationPinned(conversationId, pinned) {
  return request(`/conversations/${conversationId}/pin`, { method: 'PATCH', body: JSON.stringify({ pinned: Boolean(pinned) }) });
}
export async function getServers({ force = false } = {}) {
  const cached = getFreshCachedServers();
  if (!force && cached) return cached;
  const inFlight = getServersRequest();
  if (!force && inFlight) return inFlight;
  const epoch = getServersCacheEpoch();
  const pending = request(apiRoutes.servers).then((payload) => {
    if (!Array.isArray(payload.servers)) throw new Error('The server list response was invalid. Try again.');
    if (epoch === getServersCacheEpoch()) rememberServers(payload);
    return payload;
  }).finally(() => {
    clearServersRequest(pending);
  });
  setServersRequest(pending);
  return pending;
}
export async function reorderServers(serverIds) {
  invalidateServersCache();
  return request(apiRoutes.serverOrder, { method: 'PATCH', body: JSON.stringify({ serverIds }) });
}
export async function createServer(name) {
  invalidateServersCache();
  return request(apiRoutes.servers, { method: 'POST', body: JSON.stringify({ name }) });
}
export async function getServer(id) {
  const payload = await request(apiRoutes.server(id));
  if (!payload.server || !Array.isArray(payload.server.channels)) throw new Error('Server details were incomplete. Try again.');
  return payload;
}
export async function getServerMembers(serverId, { offset = 0, limit = 50 } = {}) {
  const params = new URLSearchParams({
    offset: String(Math.max(0, Number(offset) || 0)),
    limit: String(Math.min(50, Math.max(1, Number(limit) || 50))),
  });
  return request(`${apiRoutes.serverMembers(serverId)}?${params}`);
}
export async function setServerMuted(id, muted) {
  invalidateServersCache();
  return request(`/servers/${id}/mute`, { method: 'PATCH', body: JSON.stringify({ muted: Boolean(muted) }) });
}
export async function getServerAuditLog(serverId, { before = null } = {}) {
  return request(apiRoutes.serverAuditLog(serverId, before));
}
export async function updateServer(id, payload) { return request(apiRoutes.server(id), { method: 'PATCH', body: JSON.stringify(payload) }); }
export async function getServerModelPlans(id) { return request(`/servers/${id}/model`); }
export async function startServerModelChat(id) { return request(`/servers/${id}/model/chats`, { method: 'POST', body: '{}' }); }
export async function prepareServerModelPlan(id, prompt, allowAll = false, chatId) { return request(`/servers/${id}/model`, { method: 'POST', timeoutMs: 135_000, body: JSON.stringify({ prompt, allowAll, chatId }) }); }
export async function applyServerModelPlan(id, planId) { return request(`/servers/${id}/model/${encodeURIComponent(planId)}/apply`, { method: 'POST', timeoutMs: 135_000, body: JSON.stringify({}) }); }
export async function setServerBotInstalled(serverId, botId, installed) {
  const path = `${apiRoutes.server(serverId)}/bots${installed ? '' : `/${encodeURIComponent(botId)}`}`;
  return request(path, installed
    ? { method: 'POST', body: JSON.stringify({ botId }) }
    : { method: 'DELETE' });
}
export async function updateServerIcon(id, file) {
  const form = new FormData();
  form.append('icon', file);
  return request(`/servers/${id}/icon`, { method: 'POST', body: form });
}
export async function removeServerIcon(id) { return request(`/servers/${id}/icon`, { method: 'DELETE' }); }
export async function updateServerBanner(id, payload) {
  if (payload instanceof File) {
    const form = new FormData();
    form.append('banner', payload);
    return request(`/servers/${id}/banner`, { method: 'POST', body: form });
  }
  return request(`/servers/${id}/banner`, { method: 'POST', body: JSON.stringify(payload) });
}
export async function leaveServer(serverId) {
  invalidateServersCache();
  return request(`/servers/${serverId}/leave`, { method: 'POST' });
}
export async function deleteServer(serverId) {
  invalidateServersCache();
  return request(`/servers/${serverId}`, { method: 'DELETE' });
}
export async function createChannel(serverId, name, type = 'text', categoryId = null) { return request(apiRoutes.serverChannels(serverId), { method: 'POST', body: JSON.stringify({ name, type, categoryId }) }); }
export async function createServerCategory(serverId, name) { return request(`/servers/${serverId}/categories`, { method: 'POST', body: JSON.stringify({ name }) }); }
export async function renameServerCategory(serverId, categoryId, name) { return request(`/servers/${serverId}/categories/${categoryId}`, { method: 'PATCH', body: JSON.stringify({ name }) }); }
export async function reorderServerCategories(serverId, categoryIds) { return request(`/servers/${serverId}/categories/order`, { method: 'PATCH', body: JSON.stringify({ categoryIds }) }); }
export async function updateChannel(serverId, channelId, payload) { return request(apiRoutes.serverChannel(serverId, channelId), { method: 'PATCH', body: JSON.stringify(payload) }); }
export async function clearServerChannelMessages(serverId, channelId) { return request(apiRoutes.serverChannelClearMessages(serverId, channelId), { method: 'POST', body: '{}' }); }
export async function updateServerChannelMessageCleanup(serverId, channelId, intervalSeconds) { return request(apiRoutes.serverChannelMessageCleanup(serverId, channelId), { method: 'POST', body: JSON.stringify({ intervalSeconds }) }); }
export async function reorderChannels(serverId, channelIds, scope) { return request(`/servers/${serverId}/channels/order`, { method: 'PATCH', body: JSON.stringify({ channelIds, ...(scope ? { scope } : {}) }) }); }
export async function deleteChannel(serverId, channelId) { return request(apiRoutes.serverChannel(serverId, channelId), { method: 'DELETE' }); }
export async function createRole(serverId, role) { return request(`/servers/${serverId}/roles`, { method: 'POST', body: JSON.stringify(role) }); }
export async function reorderRoles(serverId, roleIds) { return request(`/servers/${serverId}/roles/order`, { method: 'PATCH', body: JSON.stringify({ roleIds }) }); }
export async function updateRole(serverId, roleId, role) { return request(`/servers/${serverId}/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(role) }); }
export async function deleteRole(serverId, roleId) { return request(`/servers/${serverId}/roles/${roleId}`, { method: 'DELETE' }); }
export async function createServerInvite(serverId, options = {}) { return request(`/servers/${serverId}/invites`, { method: 'POST', body: JSON.stringify(options) }); }
export async function getServerInvites(serverId) { return request(`/servers/${serverId}/invites`); }
export async function sendServerInvite(serverId, payload) { return request(`/servers/${serverId}/invites/send`, { method: 'POST', body: JSON.stringify(payload) }); }
export async function revokeServerInvite(serverId, code) { return request(`/servers/${serverId}/invites/${encodeURIComponent(code)}`, { method: 'DELETE' }); }
export async function getInvitePreview(code) {
  const clean = parseInviteInput(code) || String(code || '').trim();
  return request(`/invites/${encodeURIComponent(clean)}`);
}
export async function joinServerByInvite(code) {
  const clean = parseInviteInput(code) || String(code || '').trim();
  invalidateServersCache();
  return request(`/invites/${encodeURIComponent(clean)}/join`, { method: 'POST' });
}
export async function getServerBans(serverId) { return request(`/servers/${serverId}/bans`); }
export async function unbanServerMember(serverId, userId) { return request(`/servers/${serverId}/bans/${userId}`, { method: 'DELETE' }); }
export async function getServerDeviceBans(serverId) { return request(`/servers/${serverId}/device-bans`); }
export async function unbanServerDevice(serverId, deviceHash) { return request(`/servers/${serverId}/device-bans/${deviceHash}`, { method: 'DELETE' }); }
export async function assignMemberRole(serverId, userId, roleId) { return request(`/servers/${serverId}/members/${userId}/role`, { method: 'POST', body: JSON.stringify({ roleId }) }); }
export async function moderateMember(serverId, userId, action, reason = '') { return request(`/servers/${serverId}/members/${userId}/${action}`, { method: 'POST', body: JSON.stringify({ reason }) }); }
export async function banMemberDevice(serverId, userId, reason = '') { return request(`/servers/${serverId}/members/${userId}/device-ban`, { method: 'POST', body: JSON.stringify({ reason }) }); }
export async function timeoutMember(serverId, userId, payload = {}) { return request(`/servers/${serverId}/members/${userId}/timeout`, { method: 'POST', body: JSON.stringify(payload) }); }
export async function disconnectVoiceMember(serverId, userId) { return request(`/servers/${serverId}/voice-members/${userId}/disconnect`, { method: 'POST', body: '{}' }); }
export async function getChannelMessages(id, { before = null, limit = 50 } = {}) {
  const pageSize = Math.min(100, Math.max(1, Number.isInteger(Number(limit)) ? Number(limit) : 50));
  const params = new URLSearchParams({ limit: String(pageSize) });
  if (before) params.set('before', String(before));
  const payload = await request(`${apiRoutes.channelMessages(id)}?${params}`);
  if (!Array.isArray(payload.messages)) throw new Error('Channel history could not be read. Try again.');
  if (!before) invalidateServersCache();
  return payload;
}
export async function sendChannelMessage(id, body, files = [], replyToMessageId = null, poll = null, onUploadProgress) {
  const path = apiRoutes.channelMessages(id);
  if (!files.length) {
    return request(path, { method: 'POST', body: JSON.stringify({ body, ...(replyToMessageId ? { replyToMessageId } : {}), ...(poll ? { poll } : {}) }) });
  }
  const uploadFiles = await prepareUploadFiles(files);
  const formData = new FormData();
  formData.append('body', body ?? '');
  if (replyToMessageId) formData.append('replyToMessageId', String(replyToMessageId));
  if (poll) formData.append('poll', JSON.stringify(poll));
  uploadFiles.forEach((file) => formData.append('files', file));
  return request(path, { method: 'POST', body: formData, onUploadProgress });
}
export async function voteChannelPoll(channelId, messageId, optionIndex) {
  return request(`/channels/${channelId}/messages/${messageId}/poll/vote`, { method: 'POST', body: JSON.stringify({ optionIndex }) });
}
export async function closeChannelPoll(channelId, messageId) {
  return request(`/channels/${channelId}/messages/${messageId}/poll/close`, { method: 'POST' });
}
export async function editChannelMessage(channelId, messageId, body) { return request(`/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ body }) }); }
export async function reactToChannelMessage(channelId, messageId, emoji) { return request(`/channels/${channelId}/messages/${messageId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }); }
export async function removeChannelMessage(channelId, messageId) { return request(`/channels/${channelId}/messages/${messageId}`, { method: 'DELETE' }); }

export async function getAppSession(scopeKey) { return request(`/apps/session?scopeKey=${encodeURIComponent(scopeKey)}`); }
export async function getWhiteboard(scopeKey) { return request(`/apps/whiteboard?scopeKey=${encodeURIComponent(scopeKey)}`); }
export async function uploadWhiteboardImage(scopeKey, file) {
  const formData = new FormData();
  formData.append('scopeKey', scopeKey);
  formData.append('image', file);
  return request('/apps/whiteboard/images', { method: 'POST', body: formData });
}
export async function submitGarticPage(scopeKey, round, content) {
  return request('/apps/gartic/submit', { method: 'POST', body: JSON.stringify({ scopeKey, round, content }) });
}

export async function openDirectConversation(username) {
  return request(apiRoutes.directConversation(username), { method: 'POST' });
}

export async function getMessages(conversationId, { before = null, limit = 50, signal } = {}) {
  const pageSize = Math.min(100, Math.max(1, Number.isInteger(Number(limit)) ? Number(limit) : 50));
  const params = new URLSearchParams({ limit: String(pageSize) });
  if (before) params.set('before', String(before));
  const payload = await request(`${apiRoutes.conversationMessages(conversationId)}?${params}`, { signal });
  if (!Array.isArray(payload.messages)) throw new Error('Direct-message history could not be read. Try again.');
  return payload;
}

export async function sendMessage(conversationId, body, files = [], replyToMessageId = null, onUploadProgress) {
  const path = apiRoutes.conversationMessages(conversationId);
  if (!files.length) {
    return request(path, {
      method: 'POST',
      body: JSON.stringify({ body, ...(replyToMessageId ? { replyToMessageId } : {}) }),
    });
  }
  const uploadFiles = await prepareUploadFiles(files);
  const formData = new FormData();
  formData.append('body', body ?? '');
  if (replyToMessageId) formData.append('replyToMessageId', String(replyToMessageId));
  uploadFiles.forEach((file) => formData.append('files', file));
  return request(path, { method: 'POST', body: formData, onUploadProgress });
}

export async function editDirectMessage(conversationId, messageId, body) {
  return request(apiRoutes.conversationMessage(conversationId, messageId), { method: 'PATCH', body: JSON.stringify({ body }) });
}

export async function removeDirectMessage(conversationId, messageId) {
  return request(apiRoutes.conversationMessage(conversationId, messageId), { method: 'DELETE' });
}

export async function sendEncryptedMessage(conversationId, encrypted, onUploadProgress) {
  const { envelope, attachmentMeta, encryptedFiles, replyToMessageId } = encrypted;
  if (!encryptedFiles.length) {
    return request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ envelope, attachmentMeta, replyToMessageId }),
    });
  }
  const formData = new FormData();
  formData.append('envelope', JSON.stringify(envelope));
  formData.append('attachmentMeta', JSON.stringify(attachmentMeta));
  if (replyToMessageId) formData.append('replyToMessageId', String(replyToMessageId));
  encryptedFiles.forEach((file) => formData.append('files', file));
  return request(`/conversations/${conversationId}/messages`, { method: 'POST', body: formData, onUploadProgress });
}

export async function sendTyping(conversationId, typing) {
  return request(`/conversations/${conversationId}/typing`, { method: 'POST', body: JSON.stringify({ typing }) });
}

export async function markConversationRead(conversationId, lastReadMessageId) {
  return request(`/conversations/${conversationId}/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId }) });
}

export async function markChannelRead(channelId, lastReadMessageId) {
  const payload = await request(`/channels/${channelId}/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId }) });
  invalidateServersCache();
  return payload;
}

export async function updateAccountUsername(username) {
  const { account } = await request('/auth/username', { method: 'POST', body: JSON.stringify({ username }) });
  return account;
}

export async function updateAccountBio(bio) {
  const { account } = await request('/account/bio', { method: 'POST', body: JSON.stringify({ bio }) });
  return account;
}

export async function updateAccountCustomBadges(customBadges) {
  const { account } = await request('/account/custom-badges', { method: 'POST', body: JSON.stringify({ customBadges }) });
  return account;
}

export async function updateAccountGrade(grade) {
  const { account } = await request('/account/grade', { method: 'POST', body: JSON.stringify({ grade }) });
  return account;
}

export async function updateAccountSchool(school) {
  const { account } = await request('/account/school', { method: 'POST', body: JSON.stringify({ school }) });
  return account;
}

export async function updateAccountProgram(programs) {
  const { account } = await request('/account/program', { method: 'POST', body: JSON.stringify({ programs }) });
  return account;
}

export async function updateAccountDiscord(discordUsername) {
  const { account } = await request('/account/discord', { method: 'POST', body: JSON.stringify({ discordUsername }) });
  return account;
}

export async function updateAccountSocialLinks(socialLinks) {
  const { account } = await request('/account/social-links', { method: 'POST', body: JSON.stringify(socialLinks) });
  return account;
}

export async function skipAccountSocialLinks() {
  const { account } = await request('/account/social-links/skip', { method: 'POST' });
  return account;
}

export async function updateAccountAvatar(file, crop = null) {
  const form = new FormData();
  form.append('avatar', file);
  if (crop) form.append('crop', JSON.stringify(crop));
  const { account } = await request('/account/avatar', { method: 'POST', body: form });
  return account;
}

export async function updateAccountBanner(payload) {
  if (payload instanceof File) {
    const form = new FormData();
    form.append('banner', payload);
    const { account } = await request('/account/banner', { method: 'POST', body: form });
    return account;
  }
  const { account } = await request('/account/banner', { method: 'POST', body: JSON.stringify(payload) });
  return account;
}

export async function updateAccountProfileBackground(payload, adjustments) {
  if (payload instanceof File) {
    const form = new FormData();
    form.append('background', payload);
    form.append('adjustments', JSON.stringify(adjustments || {}));
    const { account } = await request('/account/profile-background', { method: 'POST', body: form });
    return account;
  }
  const { account } = await request('/account/profile-background', { method: 'POST', body: JSON.stringify(payload) });
  return account;
}

export async function updateAccountMainTheme(payload, photo) {
  let body = JSON.stringify(payload);
  if (photo) {
    body = new FormData();
    body.append('background', photo);
    body.append('adjustments', JSON.stringify(payload.theme));
  }
  const { account } = await request('/account/theme', { method: 'POST', body });
  return account;
}

export async function updateAccountAccessibility(contrast, saturation, reduceMotion, glassFrost, glassDepth, glassRefraction, theme, showLoopStreakReminder = true) {
  const { account } = await request('/account/accessibility', {
    method: 'POST',
    body: JSON.stringify({ contrast, saturation, reduceMotion, glassFrost, glassDepth, glassRefraction, theme, showLoopStreakReminder }),
  });
  return account;
}

export async function updateAccountNameStyle(payload) {
  const { account } = await request('/account/name-style', { method: 'POST', body: JSON.stringify(payload) });
  return account;
}

export async function getPushVapidKey() {
  return request('/push/vapid');
}

export async function subscribeDesktopPush(subscription) {
  return request('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) });
}

export async function unsubscribeDesktopPush(endpoint) {
  return request('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) });
}

export async function changePassword(currentPassword, newPassword, profileKeyBackup = null) {
  return request('/account/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, ...(profileKeyBackup ? { profileKeyBackup } : {}) }) });
}
export async function deleteAccount(password) {
  return request('/account', { method: 'DELETE', body: JSON.stringify({ password }) });
}
export async function getAccountSessions() {
  return request('/account/sessions');
}

export async function revokeAccountSession(id) {
  return request(`/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function revokeOtherSessions() {
  return request('/account/sessions/others', { method: 'DELETE' });
}

export async function setPresenceHidden(hidden) {
  const { account } = await request('/account/presence', { method: 'POST', body: JSON.stringify({ hidden: Boolean(hidden) }) });
  ingestPresence({ userId: account.id, status: account.presence, hidden: account.presenceHidden });
  return account;
}

export async function setKeepInformationSecret(enabled) {
  const { account } = await request('/account/keep-information-secret', { method: 'POST', body: JSON.stringify({ enabled: Boolean(enabled) }) });
  ingestPresence({ userId: account.id, status: account.presence, hidden: account.presenceHidden || account.keepInformationSecret });
  return account;
}

export async function setPresenceStatus(status) {
  const { account } = await request('/account/presence-status', { method: 'POST', body: JSON.stringify({ status }) });
  ingestPresence({ userId: account.id, status: account.presence, hidden: account.presenceHidden });
  return account;
}

export async function setShowInspectServers(show) {
  const { account } = await request('/account/inspect-servers', { method: 'POST', body: JSON.stringify({ show: Boolean(show) }) });
  invalidateServersCache();
  return account;
}

export async function setPrivateNotesEnabled(enabled) {
  const { account } = await request('/account/private-notes', { method: 'POST', body: JSON.stringify({ enabled: Boolean(enabled) }) });
  return account;
}

export function inspectServersVisible(account) {
  return Boolean(account?.platformAdmin) && account?.showInspectServers !== false;
}

let realtimeSession = null;
const EPHEMERAL_SOCKET_EVENTS = new Set(['presence', 'presence-sync-request', 'typing', 'channel-typing']);
const SOCKET_EPHEMERAL_BUFFER_LIMIT = 64 * 1024;

function safeCall(callback, ...args) {
  try { callback?.(...args); } catch { /* one subscriber cannot block realtime delivery */ }
}

function createRealtimeSession(key) {
  const subscribers = new Set();
  const queue = [];
  let socket = null;
  let stopped = false;
  let reconnectTimer = null;
  let connectTimer = null;
  let attempt = 0;
  let status = 'disconnected';
  let connectedPayload = null;
  let lastServerHeartbeatAt = 0;
  const heartbeatTimeoutMs = 40_000;
  const sendSocketData = (target, data) => {
    target.send(data);
    if (isDeveloperModeEnabled()) recordDeveloperTraffic('websocket', { uploaded: new TextEncoder().encode(data).byteLength });
  };

  const isNetworkOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

  const notifyStatus = (nextStatus) => {
    status = nextStatus;
    for (const subscriber of subscribers) safeCall(subscriber.onStatus, nextStatus);
  };

  const notifyEvent = (eventName, payload) => {
    invalidateLoopEvent(eventName, payload);
    for (const subscriber of subscribers) safeCall(subscriber.onEvent, eventName, payload);
  };

  const scheduleReconnect = () => {
    if (stopped || !subscribers.size || reconnectTimer || isNetworkOffline()) return;
    const delay = Math.min(10_000, 250 * (2 ** Math.min(attempt, 6))) + Math.floor(Math.random() * 150);
    attempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const clearConnectTimer = () => {
    if (connectTimer !== null) window.clearTimeout(connectTimer);
    connectTimer = null;
  };

  const retireSocket = (target, code, reason) => {
    if (socket !== target || stopped) return;
    socket = null;
    clearConnectTimer();
    if (target.readyState < WebSocket.CLOSING) target.close(code, reason);
    notifyStatus('reconnecting');
    scheduleReconnect();
  };

  const connect = () => {
    if (stopped || !subscribers.size || reconnectTimer || (socket && socket.readyState < WebSocket.CLOSING)) return;
    if (isNetworkOffline()) {
      notifyStatus('reconnecting');
      return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let nextSocket;
    try {
      nextSocket = new WebSocket(`${protocol}//${window.location.host}${API_PREFIX}/realtime`);
    } catch {
      notifyStatus('reconnecting');
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
    connectedPayload = null;
    notifyStatus('connecting');
    connectTimer = window.setTimeout(() => retireSocket(nextSocket, 4000, 'connection timeout'), 10_000);

    nextSocket.addEventListener('open', () => {
      if (socket !== nextSocket) return;
      clearConnectTimer();
      attempt = 0;
      lastServerHeartbeatAt = Date.now();
      notifyStatus('connected');
      bindPresenceActivity(() => {
        if (socket === nextSocket && nextSocket.readyState === WebSocket.OPEN) {
          sendSocketData(nextSocket, JSON.stringify({ event: 'presence', payload: { active: true } }));
        }
      });
      while (queue.length && socket === nextSocket && nextSocket.readyState === WebSocket.OPEN) sendSocketData(nextSocket, queue.shift());
    });
    nextSocket.addEventListener('message', (event) => {
      if (socket !== nextSocket) return;
      if (isDeveloperModeEnabled()) {
        const receivedBytes = typeof event.data === 'string'
          ? new TextEncoder().encode(event.data).byteLength
          : Number(event.data?.byteLength) || 0;
        recordDeveloperTraffic('websocket', { downloaded: receivedBytes });
      }
      try {
        const message = JSON.parse(event.data);
        const eventName = message?.event;
        const payload = message?.payload || {};
        if (!eventName) return;
        lastServerHeartbeatAt = Date.now();
        if (eventName === 'heartbeat') {
          return;
        }
        if (eventName === 'maintenance' && payload.active === true) {
          window.location.replace('/');
          return;
        }
        if (eventName === 'school-access-blocked') {
          window.location.replace('/');
          return;
        }
        if (eventName === 'presence' || eventName === 'presence-sync') ingestPresence(payload);
        if (eventName === 'connected') {
          connectedPayload = payload;
          lastServerHeartbeatAt = Date.now();
        }
        notifyEvent(eventName, payload);
      } catch { /* malformed real-time event */ }
    });
    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket || stopped) return;
      clearConnectTimer();
      socket = null;
      notifyStatus('reconnecting');
      scheduleReconnect();
    });
    nextSocket.addEventListener('error', () => {
      retireSocket(nextSocket, 4000, 'connection error');
    });
  };

  const onOffline = () => {
    if (stopped) return;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearConnectTimer();
    notifyStatus('reconnecting');
    const staleSocket = socket;
    socket = null;
    if (staleSocket && staleSocket.readyState < WebSocket.CLOSING) staleSocket.close(4001, 'network offline');
  };

  const onOnline = () => {
    if (stopped || !subscribers.size) return;
    // Duplicate network-online events must not tear down a healthy call/socket.
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastServerHeartbeatAt <= heartbeatTimeoutMs) return;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearConnectTimer();
    const staleSocket = socket;
    socket = null;
    if (staleSocket && staleSocket.readyState < WebSocket.CLOSING) staleSocket.close(4001, 'network restored');
    connect();
  };

  const ensureCurrentConnection = () => {
    if (stopped || !subscribers.size || isNetworkOffline()) return;
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastServerHeartbeatAt > heartbeatTimeoutMs) {
      retireSocket(socket, 4000, 'heartbeat timeout');
      return;
    }
    if (!socket && !reconnectTimer) connect();
  };

  const heartbeatWatchdog = window.setInterval(ensureCurrentConnection, 5_000);
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    ensureCurrentConnection();
    if (socket?.readyState === WebSocket.OPEN) {
      sendSocketData(socket, JSON.stringify({ event: 'presence-sync-request', payload: {} }));
    }
  };

  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibilityChange);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    subscribers.clear();
    queue.length = 0;
    clearPresenceActivity();
    window.clearInterval(heartbeatWatchdog);
    clearConnectTimer();
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    const currentSocket = socket;
    socket = null;
    if (currentSocket && currentSocket.readyState < WebSocket.CLOSING) currentSocket.close(1000, 'session closed');
  };

  const add = (onEvent, onStatus) => {
    const subscriber = { onEvent, onStatus };
    subscribers.add(subscriber);
    if (status !== 'disconnected') safeCall(onStatus, status);
    if (status === 'connected' && connectedPayload) {
      Promise.resolve().then(() => {
        if (subscribers.has(subscriber) && !stopped) safeCall(onEvent, 'connected', connectedPayload, { replayed: true });
      });
    }
    if (!socket && !reconnectTimer) connect();
    return () => {
      subscribers.delete(subscriber);
      safeCall(onStatus, 'disconnected');
      if (!subscribers.size) {
        stop();
        if (realtimeSession?.key === key) realtimeSession = null;
      }
    };
  };

  return {
    key,
    add,
    send(event, payload) {
      const ephemeral = EPHEMERAL_SOCKET_EVENTS.has(event);
      if (ephemeral && (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > SOCKET_EPHEMERAL_BUFFER_LIMIT)) return;
      const data = JSON.stringify({ event, payload });
      if (socket?.readyState === WebSocket.OPEN) sendSocketData(socket, data);
      else if (queue.length < 20) queue.push(data);
    },
    stop,
  };
}

export function subscribeToDmEvents(onEvent, onStatus = () => {}, sessionKey = null) {
  const key = String(sessionKey || realtimeSession?.key || 'default');
  if (realtimeSession && realtimeSession.key !== key) {
    realtimeSession.stop();
    realtimeSession = null;
  }
  if (!realtimeSession) realtimeSession = createRealtimeSession(key);
  const session = realtimeSession;
  const remove = session.add(onEvent, onStatus);
  return {
    send: (event, payload) => session.send(event, payload),
    close: remove,
  };
}
