export const DEFAULT_NOTIFICATIONS = Object.freeze({ serverMessages: 'all', directMessages: true, groupMessages: true, friendRequests: true, dailyGreetings: true });

export function createNotificationPreferences({ database, requireUser, readJson, sendJson, sendEvent, channelVisible, onConversationMute }) {
  const preference = database.prepare('SELECT settings_json FROM user_notification_settings WHERE user_id=?');
  const save = database.prepare('INSERT INTO user_notification_settings(user_id,settings_json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json');
  const conversation = database.prepare('SELECT g.name FROM conversation_members m LEFT JOIN group_conversations g ON g.conversation_id=m.conversation_id WHERE m.user_id=? AND m.conversation_id=?');
  const mutedConversation = database.prepare('SELECT 1 FROM user_conversation_mutes WHERE user_id=? AND conversation_id=?');
  const mute = database.prepare('INSERT OR IGNORE INTO user_conversation_mutes(user_id,conversation_id) VALUES(?,?)');
  const unmute = database.prepare('DELETE FROM user_conversation_mutes WHERE user_id=? AND conversation_id=?');
  const serverMember = database.prepare('SELECT 1 FROM server_members WHERE user_id=? AND server_id=?');
  const serverMuted = database.prepare('SELECT 1 FROM user_server_mutes WHERE user_id=? AND server_id=?');
  const mentioned = database.prepare('SELECT 1 FROM channel_message_mentions v JOIN channel_messages m ON m.id=v.message_id WHERE v.user_id=? AND v.message_id=? AND m.channel_id=? AND m.deleted_at IS NULL');
  const servers = database.prepare('SELECT s.id,s.name,CASE WHEN mute.user_id IS NULL THEN 0 ELSE 1 END AS muted FROM server_members m JOIN servers s ON s.id=m.server_id LEFT JOIN user_server_mutes mute ON mute.user_id=m.user_id AND mute.server_id=s.id WHERE m.user_id=? ORDER BY s.name COLLATE NOCASE,s.id');
  const groups = database.prepare('SELECT g.conversation_id AS id,g.name,CASE WHEN mute.user_id IS NULL THEN 0 ELSE 1 END AS muted FROM conversation_members m JOIN group_conversations g ON g.conversation_id=m.conversation_id LEFT JOIN user_conversation_mutes mute ON mute.user_id=m.user_id AND mute.conversation_id=g.conversation_id WHERE m.user_id=? ORDER BY g.name COLLATE NOCASE,g.conversation_id');
  const get = userId => {
    const stored = preference.get(userId);
    if (!stored) return { ...DEFAULT_NOTIFICATIONS };
    try { return { ...DEFAULT_NOTIFICATIONS, ...JSON.parse(stored.settings_json) }; }
    catch { return { ...DEFAULT_NOTIFICATIONS }; }
  };
  const canNotify = (userId, payload) => {
    if (payload?.kind === 'loop') return true;
    const settings = get(userId);
    if (payload?.kind === 'channel') {
      if (!serverMember.get(userId, Number(payload.serverId)) || serverMuted.get(userId, Number(payload.serverId))
        || !channelVisible(userId, Number(payload.channelId)) || settings.serverMessages === 'off') return false;
      return settings.serverMessages === 'all' || Boolean(mentioned.get(userId, Number(payload.messageId || 0), Number(payload.channelId)));
    }
    if (payload?.kind === 'dm' || payload?.kind === 'dm-call') {
      const id = Number(payload.conversationId), membership = conversation.get(userId, id);
      return Boolean(membership && !mutedConversation.get(userId, id) && (membership.name ? settings.groupMessages : settings.directMessages));
    }
    if (payload?.kind === 'friends') return settings.friendRequests;
    if (payload?.kind === 'announcement' && String(payload.tag || '').startsWith('glean-scheduled-')) return settings.dailyGreetings;
    return true;
  };
  const handle = async (request, response, path, method) => {
    const match = path.match(/^\/api\/conversations\/(\d+)\/mute$/);
    if (path !== '/api/account/notifications' && !match) return false;
    const user = requireUser(request, response);
    if (!user) return true;
    const done = (status, body) => { sendJson(response, status, body); return true; };
    if (path === '/api/account/notifications' && method === 'GET') return done(200, { settings: get(user.id), servers: servers.all(user.id).map(row => ({ ...row, muted: Boolean(row.muted) })), groups: groups.all(user.id).map(row => ({ ...row, muted: Boolean(row.muted) })) });
    if (method !== 'PATCH') return done(405, { error: 'Method not allowed.' });
    let input;
    try { input = await readJson(request, 4096); } catch { return done(400, { error: 'Provide valid notification settings.' }); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return done(400, { error: 'Provide notification settings as an object.' });
    if (match) {
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id < 1 || !conversation.get(user.id, id)) return done(404, { error: 'Conversation not found.' });
      if (Object.keys(input).length !== 1 || typeof input.muted !== 'boolean') return done(400, { error: 'Muted must be true or false.' });
      if (input.muted) mute.run(user.id, id); else unmute.run(user.id, id);
      onConversationMute?.(user.id, id);
      sendEvent(user.id, 'notification-settings', { conversationId: id, muted: input.muted });
      sendEvent(user.id, 'conversations', { conversationId: id });
      return done(200, { conversationId: id, muted: input.muted });
    }
    const fields = Object.keys(input);
    if (!fields.length || fields.some(key => !Object.hasOwn(DEFAULT_NOTIFICATIONS, key)
      || (key === 'serverMessages' ? !['all', 'mentions', 'off'].includes(input[key]) : typeof input[key] !== 'boolean'))) return done(400, { error: 'Choose valid notification preferences.' });
    const settings = { ...get(user.id), ...input };
    save.run(user.id, JSON.stringify(settings));
    sendEvent(user.id, 'notification-settings', { settings });
    return done(200, { settings });
  };
  return { get, canNotify, handle };
}
