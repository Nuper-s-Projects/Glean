// The reserved server is identified by an internal ID, never by a user-chosen name.
export function createOfficialAnnouncements(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS official_announcements_kicks (
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kicked_at TEXT NOT NULL,
      kicked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (server_id, user_id)
    ) STRICT;
  `);
  const settingKey = 'official_announcements_server_id';
  let serverId = null;
  let ownerId = null;
  let channelId = null;
  let memberRoleId = null;
  let serverCreatedAt = null;
  const currentServer = () => serverId !== null && Boolean(database.prepare('SELECT 1 FROM servers WHERE id=? AND owner_id=? AND created_at=?').get(serverId, ownerId, serverCreatedAt));
  function ensureAll() {
    database.exec('SAVEPOINT official_announcements');
    try {
      let saved;
      try { saved = JSON.parse(database.prepare('SELECT value FROM platform_settings WHERE key = ?').get(settingKey)?.value || 'null'); } catch { saved = null; }
      let server = saved && typeof saved === 'object'
        ? database.prepare('SELECT id,owner_id,created_at FROM servers WHERE id=? AND owner_id=? AND created_at=?').get(saved.id ?? -1, saved.ownerId ?? -1, saved.createdAt ?? '')
        : null;
      if (!server) {
        const owner = database.prepare("SELECT id FROM users WHERE username = 'Nuper' COLLATE NOCASE").get();
        if (!owner) {
          serverId = null; ownerId = null; channelId = null; memberRoleId = null; serverCreatedAt = null;
          database.exec('RELEASE official_announcements');
          return null;
        }
        const now = new Date().toISOString();
        const result = database.prepare('INSERT INTO servers(name,owner_id,created_at,description,is_public) VALUES(?,?,?,?,0)')
          .run('Glean', owner.id, now, 'Official Glean announcements, updates, and news.');
        server = { id: Number(result.lastInsertRowid), owner_id: owner.id, created_at: now };
        database.prepare('INSERT INTO platform_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(settingKey, JSON.stringify({ id: server.id, ownerId: server.owner_id, createdAt: server.created_at }));
      }
      const now = new Date().toISOString();
      const ensureRole = (name, color, permissions, position) => {
        let role = database.prepare('SELECT id FROM server_roles WHERE server_id=? AND permissions=? ORDER BY id LIMIT 1').get(server.id, permissions);
        if (!role) {
          const inserted = database.prepare('INSERT INTO server_roles(server_id,name,color,permissions,position,permission_flags) VALUES(?,?,?,?,?,?)')
            .run(server.id, name, color, permissions, position, '[]');
          role = { id: Number(inserted.lastInsertRowid) };
        }
        return role.id;
      };
      const ownerRole = ensureRole('Owner', '#d97706', 'owner', 1);
      const memberRole = ensureRole('Member', '#99aab5', 'member', 0);
      let channel = database.prepare("SELECT id FROM server_channels WHERE server_id=? AND name='announcements' AND channel_kind='announcement' ORDER BY id LIMIT 1").get(server.id);
      if (!channel) {
        const inserted = database.prepare("INSERT INTO server_channels(server_id,name,kind,voice,channel_kind,locked,slowmode,topic,position) VALUES(?,'announcements','text',0,'announcement',1,0,?,0)")
          .run(server.id, 'Official news and updates from Glean.');
        channel = { id: Number(inserted.lastInsertRowid) };
      }
      // Seed community channels once per official server, not after every deletion.
      const communityKey = 'official_community_channels_v1';
      const communityIdentity = JSON.stringify({ id: server.id, createdAt: server.created_at });
      if (database.prepare('SELECT value FROM platform_settings WHERE key=?').get(communityKey)?.value !== communityIdentity) {
        const insertDefault = (name, voice, topic) => {
          if (database.prepare('SELECT 1 FROM server_channels WHERE server_id=? AND name=? AND voice=?').get(server.id, name, voice)) return;
          const position = database.prepare('SELECT COALESCE(MAX(position),-1)+1 AS position FROM server_channels WHERE server_id=?').get(server.id).position;
          database.prepare("INSERT INTO server_channels(server_id,name,kind,voice,channel_kind,locked,slowmode,topic,position) VALUES(?,?,'text',?,'text',0,0,?,?)")
            .run(server.id, name, voice, topic, position);
        };
        insertDefault('general', 0, 'Chat with the Glean community.');
        insertDefault('voice', 1, 'Hang out with the Glean community.');
        database.prepare('INSERT INTO platform_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(communityKey, communityIdentity);
      }
      database.prepare(`INSERT INTO server_members(server_id,user_id,role_id,joined_at)
        SELECT ?,users.id,CASE WHEN users.id=? THEN ? ELSE ? END,?
        FROM users
        WHERE NOT EXISTS (SELECT 1 FROM server_bans WHERE server_id=? AND user_id=users.id)
          AND NOT EXISTS (SELECT 1 FROM official_announcements_kicks WHERE server_id=? AND user_id=users.id)
        ON CONFLICT(server_id,user_id) DO NOTHING`).run(server.id, server.owner_id, ownerRole, memberRole, now, server.id, server.id);
      database.exec('RELEASE official_announcements');
      serverId = Number(server.id); ownerId = Number(server.owner_id);
      serverCreatedAt = server.created_at;
      channelId = Number(channel.id); memberRoleId = Number(memberRole);
      return serverId;
    } catch (error) {
      database.exec('ROLLBACK TO official_announcements; RELEASE official_announcements');
      throw error;
    }
  }
  function enroll(userId) {
    if (!currentServer()) ensureAll();
    if (!serverId || database.prepare('SELECT 1 FROM server_bans WHERE server_id=? AND user_id=?').get(serverId, userId)
      || database.prepare('SELECT 1 FROM official_announcements_kicks WHERE server_id=? AND user_id=?').get(serverId, userId)) return false;
    const roleId = Number(userId) === ownerId
      ? database.prepare("SELECT id FROM server_roles WHERE server_id=? AND permissions='owner' ORDER BY id LIMIT 1").get(serverId).id
      : memberRoleId;
    const result = database.prepare('INSERT OR IGNORE INTO server_members(server_id,user_id,role_id,joined_at) VALUES(?,?,?,?)')
      .run(serverId, userId, roleId, new Date().toISOString());
    return Boolean(result.changes);
  }
  function kick(userId, actorId, kickedAt = new Date().toISOString()) {
    if (!currentServer() || Number(userId) === ownerId) return false;
    database.prepare(`INSERT OR REPLACE INTO official_announcements_kicks(server_id,user_id,kicked_at,kicked_by)
      VALUES(?,?,?,?)`).run(serverId, Number(userId), String(kickedAt), Number(actorId) || null);
    return true;
  }
  function clearKick(userId) {
    if (!serverId) return false;
    return Boolean(database.prepare('DELETE FROM official_announcements_kicks WHERE server_id=? AND user_id=?')
      .run(serverId, Number(userId)).changes);
  }
  ensureAll();
  return {
    ensureAll, enroll, kick, clearKick,
    isServer: (id) => Number(id) === serverId && currentServer(),
    isRequiredChannel: (id) => channelId !== null && Number(id) === channelId && currentServer(),
    canPost: (userId) => Number(userId) === ownerId,
  };
}
