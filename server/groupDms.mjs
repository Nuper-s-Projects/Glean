// Additive metadata keeps existing direct conversations and their foreign keys intact.
export function createGroupDmService({ database, areFriends, isBlockedEither, publicPresence, publicNameStyle, publicCustomBadges, sendEvent, directMessagePayload, publicKeyMatchesStored, removeStoredUploads }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS group_conversations (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE INDEX IF NOT EXISTS group_conversations_owner ON group_conversations(owner_id);
  `);
  if (!database.prepare('PRAGMA table_info(conversation_members)').all().some(c => c.name === 'joined_after_message_id')) database.exec('ALTER TABLE conversation_members ADD COLUMN joined_after_message_id INTEGER NOT NULL DEFAULT 0');
  const groupById = database.prepare('SELECT * FROM group_conversations WHERE conversation_id = ?');
  const memberById = database.prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
  const membersQuery = database.prepare(`SELECT users.id, users.username, users.avatar_url, users.public_key_jwk, users.key_fingerprint, users.name_style_json, users.custom_badges_json, conversation_members.joined_after_message_id FROM conversation_members JOIN users ON users.id = conversation_members.user_id WHERE conversation_id = ? ORDER BY joined_at, users.id`);
  const memberIds = id => membersQuery.all(id).map(m => Number(m.id));
  const maxMessage = database.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?');
  const latestQuery = database.prepare('SELECT id FROM messages WHERE conversation_id = ? AND id > ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1');
  const unreadQuery = database.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND sender_id != ? AND deleted_at IS NULL AND id > ?');
  const pinQuery = database.prepare('SELECT 1 FROM conversation_pins WHERE conversation_id = ? AND user_id = ?');
  const groupFiles = database.prepare('SELECT storage_name FROM message_attachments WHERE conversation_id = ?');
  const groupsQuery = database.prepare('SELECT g.conversation_id AS id FROM group_conversations g JOIN conversation_members m ON m.conversation_id = g.conversation_id WHERE m.user_id = ?');
  const nameInput = value => typeof value === 'string' ? value.trim() : '';
  const parseKey = value => { try { return JSON.parse(value); } catch { return null; } };
  const transaction = fn => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = fn(); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
  const requireGroup = (id, userId) => {
    const group = groupById.get(id);
    if (!group || !memberById.get(id, userId)) fail(404, 'Group chat not found.');
    return group;
  };
  const requireOwner = (id, userId) => {
    const group = requireGroup(id, userId);
    if (Number(group.owner_id) !== Number(userId)) fail(403, 'Only the group owner can do that.');
    return group;
  };
  const eligible = (inviterId, targetId, existing) => {
    const target = database.prepare('SELECT id, is_bot FROM users WHERE id = ?').get(targetId);
    if (!target || Number(target.is_bot) || !areFriends(inviterId, targetId)) fail(403, 'You can only add accepted friends. Bots cannot join group DMs.');
    if (existing.some(id => isBlockedEither(id, targetId))) fail(403, 'This person cannot join a group with a blocked user.');
    return target;
  };
  const notify = (id, extra = []) => {
    for (const userId of new Set([...memberIds(id), ...extra])) sendEvent(userId, 'conversations', { conversationId: id, kind: 'group' });
  };
  const get = (id, userId) => {
    const group = requireGroup(id, userId);
    const membership = memberById.get(id, userId);
    const members = membersQuery.all(id).map(m => ({ id: Number(m.id), username: m.username, avatarUrl: m.avatar_url || null,
      nameStyle: publicNameStyle(m.name_style_json), customBadges: publicCustomBadges(m.custom_badges_json),
      publicKey: parseKey(m.public_key_jwk), keyFingerprint: m.key_fingerprint || null, presence: publicPresence(m.id) }));
    const lastRow = latestQuery.get(id, membership.joined_after_message_id);
    const last = lastRow ? directMessagePayload(lastRow) : null;
    if (last?.replyTo && last.replyTo.id <= Number(membership.joined_after_message_id)) last.replyTo = { id: last.replyTo.id, body: '', deleted: true };
    const unread = unreadQuery.get(id, userId, Math.max(Number(membership.last_read_message_id || 0), Number(membership.joined_after_message_id)));
    const pinned = pinQuery.get(id, userId);
    return { id: Number(id), kind: 'group', name: group.name, ownerId: Number(group.owner_id), revision: Number(group.revision), members,
      // The shared transcript uses this display identity, never as an encryption peer.
      user: { username: group.name, isGroup: true, avatarUrl: null },
      blocked: false, pinned: Boolean(pinned), unreadCount: Number(unread.count), lastMessage: last?.encrypted ? 'Message' : last?.body || null,
      lastMessageAt: last?.createdAt || null, lastEncryptedMessage: last?.encrypted ? last : null };
  };
  const list = userId => groupsQuery.all(userId).map(g => get(Number(g.id), userId));
  const validateEnvelope = (id, user, envelope) => {
    const group = requireGroup(id, user.id);
    if (envelope?.version !== 2 || Number(envelope.membershipRevision) !== Number(group.revision)) fail(409, 'Group membership changed. Refresh the chat and retry.');
    const members = membersQuery.all(id);
    if (members.some(m => Number(m.id) !== Number(user.id) && isBlockedEither(user.id, m.id))) fail(403, 'You cannot send to a group containing a blocked user.');
    if (!publicKeyMatchesStored(envelope.senderPublicKey, user.public_key_jwk, user.key_fingerprint)) fail(409, 'Your encryption key changed. Sign in again and retry.');
    if (!Array.isArray(envelope.recipientKeys) || envelope.recipientKeys.length !== members.length) fail(400, 'Every group member needs an encrypted message key.');
    const seen = new Set();
    for (const entry of envelope.recipientKeys) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(400, 'Invalid encrypted group key.');
      const member = members.find(m => Number(m.id) === entry.userId);
      if (!member || seen.has(entry.userId) || !publicKeyMatchesStored(entry.publicKey, member.public_key_jwk, member.key_fingerprint)) fail(409, 'Group encryption keys changed. Refresh the chat and retry.');
      seen.add(entry.userId);
      if (!/^[A-Za-z0-9_-]{16}$/.test(entry.iv || '') || !/^[A-Za-z0-9_-]{64}$/.test(entry.ciphertext || '')) fail(400, 'Invalid encrypted group key.');
    }
    return group;
  };
  const handle = async ({ path, method, request, response, user, readJson, sendJson }) => {
    const create = path === '/api/conversations/groups' && method === 'POST';
    const match = path.match(/^\/api\/conversations\/(\d+)\/group(?:\/(members|leave)(?:\/(\d+))?)?$/);
    if (!create && !match) return false;
    try {
      let input = {};
      if (['POST', 'PATCH'].includes(method)) {
        try { input = await readJson(request, 8192); } catch (error) { fail(400, error.message || 'Invalid JSON request.'); }
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Provide a JSON object.');
      const id = match ? Number(match[1]) : null;
      if (create) {
        const ids = input.memberIds;
        const name = nameInput(input.name);
        if (!name || name.length > 80) fail(400, 'Group name must be 1–80 characters.');
        if (!Array.isArray(ids) || ids.length < 2 || ids.length > 19 || ids.some(n => !Number.isSafeInteger(n) || n <= 0 || n === Number(user.id)) || new Set(ids).size !== ids.length) fail(400, 'Choose 2–19 different friends.');
        const newId = transaction(() => {
          if (Number(database.prepare('SELECT COUNT(*) AS count FROM group_conversations WHERE owner_id = ?').get(user.id).count) >= 100) fail(400, 'You already own 100 group DMs. Leave an unused group before creating another.');
          const existing = [Number(user.id)];
          for (const targetId of ids) { eligible(user.id, targetId, existing); existing.push(targetId); }
          const now = new Date().toISOString();
          const conversationId = Number(database.prepare("INSERT INTO conversations(kind,created_at) VALUES('direct',?)").run(now).lastInsertRowid);
          database.prepare('INSERT INTO group_conversations(conversation_id,name,owner_id) VALUES(?,?,?)').run(conversationId, name, user.id);
          const insert = database.prepare('INSERT INTO conversation_members(conversation_id,user_id,joined_at) VALUES(?,?,?)');
          for (const memberId of existing) insert.run(conversationId, memberId, now);
          return conversationId;
        });
        notify(newId);
        return sendJson(response, 201, { conversation: get(newId, user.id) });
      }
      requireGroup(id, user.id);
      if (method === 'GET' && !match[2]) return sendJson(response, 200, { conversation: get(id, user.id) });
      if (method === 'PATCH' && !match[2]) {
        const name = nameInput(input.name);
        if (!name || name.length > 80) fail(400, 'Group name must be 1–80 characters.');
        requireOwner(id, user.id);
        database.prepare('UPDATE group_conversations SET name = ? WHERE conversation_id = ?').run(name, id);
      } else if (method === 'POST' && match[2] === 'members' && !match[3]) {
        transaction(() => {
          requireOwner(id, user.id);
          const ids = memberIds(id), targetId = input.userId;
          if (!Number.isSafeInteger(targetId) || targetId <= 0 || ids.includes(targetId)) fail(400, 'Choose a friend who is not already in this group.');
          if (ids.length >= 20) fail(400, 'Group DMs support up to 20 people.');
          eligible(user.id, targetId, ids);
          const after = Number(maxMessage.get(id).id);
          database.prepare('INSERT INTO conversation_members(conversation_id,user_id,joined_at,last_read_message_id,joined_after_message_id) VALUES(?,?,?,?,?)').run(id, targetId, new Date().toISOString(), after, after);
          database.prepare('UPDATE group_conversations SET revision = revision + 1 WHERE conversation_id = ?').run(id);
        });
      } else if ((method === 'POST' && match[2] === 'leave' && !match[3]) || (method === 'DELETE' && match[2] === 'members' && match[3])) {
        const targetId = match[2] === 'leave' ? Number(user.id) : Number(match[3]);
        const removedUploads = [];
        transaction(() => {
          const group = targetId === Number(user.id) ? requireGroup(id, user.id) : requireOwner(id, user.id);
          if (!memberById.get(id, targetId)) fail(404, 'Group member not found.');
          database.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(id, targetId);
          database.prepare('DELETE FROM conversation_pins WHERE conversation_id = ? AND user_id = ?').run(id, targetId);
          database.prepare('DELETE FROM user_conversation_mutes WHERE conversation_id=? AND user_id=?').run(id, targetId);
          const remaining = memberIds(id);
          if (!remaining.length) {
            removedUploads.push(...groupFiles.all(id).map(row => row.storage_name));
            database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
          }
          else database.prepare('UPDATE group_conversations SET revision = revision + 1, owner_id = ? WHERE conversation_id = ?').run(Number(group.owner_id) === targetId ? remaining[0] : group.owner_id, id);
        });
        removeStoredUploads(removedUploads);
        notify(id, [targetId]);
        return sendJson(response, 200, { ok: true });
      } else return sendJson(response, 405, { error: 'Method not allowed.' });
      notify(id);
      return sendJson(response, 200, { conversation: get(id, user.id) });
    } catch (error) {
      if (!error.status) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  };
  const detachUser = (userId, removedUploads = []) => {
    const groups = database.prepare('SELECT g.* FROM group_conversations g JOIN conversation_members m ON m.conversation_id = g.conversation_id WHERE m.user_id = ?').all(userId);
    for (const group of groups) {
      const id = Number(group.conversation_id);
      database.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(id, userId);
      database.prepare('DELETE FROM user_conversation_mutes WHERE conversation_id=? AND user_id=?').run(id, userId);
      const remaining = memberIds(id);
      if (!remaining.length) {
        removedUploads.push(...groupFiles.all(id).map(row => row.storage_name));
        database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      }
      else database.prepare('UPDATE group_conversations SET owner_id = ?, revision = revision + 1 WHERE conversation_id = ?').run(Number(group.owner_id) === Number(userId) ? remaining[0] : group.owner_id, id);
    }
    return groups.map(g => Number(g.conversation_id));
  };
  return { list, get, handle, validateEnvelope, detachUser, notify, nameOf: id => groupById.get(id)?.name || '', isGroup: id => Boolean(groupById.get(id)), historyStart: (id, userId) => Number(memberById.get(id, userId)?.joined_after_message_id || 0) };
}
