import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createLoopCaptions, captionVtt } from './loopCaptions.mjs';
import { createLoopPresence } from './loopPresence.mjs';
import { createLoopFlow } from './loopFlow.mjs';
import { createLoopVideos } from './loopVideos.mjs';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo', 'video/avi', 'video/mpeg', 'video/ogg', 'video/3gpp', 'video/x-m4v']);
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm']);

function safeJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function cleanTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set(source.map((tag) => String(tag).trim().replace(/^#/, '').toLowerCase()).filter((tag) => /^[a-z0-9_]{1,32}$/.test(tag)))].slice(0, 10);
}

export function createLoopService({ database, uploadDirectory, parseMultipart, sendLocalFile, sendJson, readJson, currentUser, realtimeHub, isAdmin, nameFile, publicPresence = () => 'online', captionOptions = {}, videoOptions = {}, copyVideoDownload = null, pushService = null }) {
  for (const sql of [
    'ALTER TABLE loop_posts ADD COLUMN edited_at TEXT',
    'ALTER TABLE loop_posts ADD COLUMN deleted_at TEXT',
    'ALTER TABLE loop_posts ADD COLUMN original_post_id INTEGER REFERENCES loop_posts(id) ON DELETE SET NULL',
    "ALTER TABLE loop_posts ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE users ADD COLUMN loop_background_json TEXT NOT NULL DEFAULT '{}'",
    'ALTER TABLE loop_post_comments ADD COLUMN parent_id INTEGER REFERENCES loop_post_comments(id) ON DELETE SET NULL',
    'ALTER TABLE loop_post_comments ADD COLUMN deleted_at TEXT',
  ]) { try { database.exec(sql); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; } }
  if (!database.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'is_verified')) database.exec('ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0 CHECK(is_verified IN (0,1))');

  database.exec(`
    CREATE TABLE IF NOT EXISTS loop_accounts (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      connected_at TEXT NOT NULL,
      consent_version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_aura_balances (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
      streak_days INTEGER NOT NULL DEFAULT 0 CHECK(streak_days >= 0),
      last_checkin_date TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_aura_ledger (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL CHECK(amount > 0),
      reason TEXT NOT NULL,
      event_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS loop_aura_ledger_daily_idx ON loop_aura_ledger(user_id,reason,created_at);
    CREATE INDEX IF NOT EXISTS loop_aura_leaderboard_idx ON loop_aura_balances(balance DESC,user_id ASC);
    CREATE INDEX IF NOT EXISTS loop_comment_thread_idx ON loop_post_comments(post_id,parent_id,id);
    CREATE TABLE IF NOT EXISTS loop_notification_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_post_polls (
      post_id INTEGER PRIMARY KEY REFERENCES loop_posts(id) ON DELETE CASCADE,
      question TEXT NOT NULL, options_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_poll_votes (
      post_id INTEGER NOT NULL REFERENCES loop_post_polls(post_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option_index INTEGER NOT NULL CHECK(option_index BETWEEN 0 AND 5),
      PRIMARY KEY(post_id, user_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS loop_poll_votes_option_idx ON loop_poll_votes(post_id, option_index, user_id);
    CREATE TABLE IF NOT EXISTS loop_post_media (
      id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES loop_posts(id) ON DELETE CASCADE,
      storage_name TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL, mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS loop_post_media_post_idx ON loop_post_media(post_id, position, id);
    CREATE INDEX IF NOT EXISTS loop_posts_author_idx ON loop_posts(user_id, id DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS loop_posts_original_idx ON loop_posts(original_post_id) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS loop_bookmarks (
      post_id INTEGER NOT NULL REFERENCES loop_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY(post_id, user_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followed_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY(follower_id, followed_id), CHECK(follower_id != followed_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_notifications (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL,
      post_id INTEGER REFERENCES loop_posts(id) ON DELETE CASCADE, body TEXT NOT NULL DEFAULT '',
      read_at TEXT, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS loop_notifications_user_idx ON loop_notifications(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS loop_blocks (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, target_id), CHECK(user_id != target_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_mutes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, target_id), CHECK(user_id != target_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_reports (
      id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      post_id INTEGER REFERENCES loop_posts(id) ON DELETE SET NULL,
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, reviewed_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_conversations (
      id INTEGER PRIMARY KEY, created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_conversation_members (
      conversation_id INTEGER NOT NULL REFERENCES loop_conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id, user_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loop_messages (
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES loop_conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL,
      edited_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS loop_messages_conversation_idx ON loop_messages(conversation_id, id DESC);
  `);
  for (const sql of [
    'ALTER TABLE loop_notifications ADD COLUMN comment_id INTEGER REFERENCES loop_post_comments(id) ON DELETE SET NULL',
    'ALTER TABLE loop_notifications ADD COLUMN event_key TEXT',
  ]) { try { database.exec(sql); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; } }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS loop_notification_event_idx ON loop_notifications(event_key) WHERE event_key IS NOT NULL');
  const captions = createLoopCaptions({ database, uploadDirectory, realtimeHub, ...captionOptions });
  const videos = createLoopVideos({ database, uploadDirectory, realtimeHub, ...videoOptions });

  const postVisibility = `NOT EXISTS(SELECT 1 FROM loop_blocks b WHERE (b.user_id=? AND b.target_id=p.user_id) OR (b.user_id=p.user_id AND b.target_id=?))
      AND NOT EXISTS(SELECT 1 FROM loop_mutes m WHERE m.user_id=? AND m.target_id=p.user_id)`;
  // Follow references, rather than duplicating uploads. UNION also terminates corrupt cycles.
  // Stop at the first post with its own media and never cross a hidden/deleted original.
  const mediaSources = (seed) => `WITH RECURSIVE media_sources(id,original_post_id) AS (
    ${seed}
    UNION
    SELECT source.id,source.original_post_id FROM media_sources parent
    JOIN loop_posts source ON source.id=parent.original_post_id
    WHERE source.deleted_at IS NULL AND ${postVisibility.replaceAll('p.user_id', 'source.user_id')}
      AND NOT EXISTS(SELECT 1 FROM loop_post_media own WHERE own.post_id=parent.id)
  )`;
  const flowPage = createLoopFlow(database, postVisibility);
  const postSelect = (where = '1=1') => `
    SELECT p.*, u.username, u.avatar_url, u.bio, u.is_verified,
      (SELECT COUNT(*) FROM loop_post_likes l WHERE l.post_id=p.id) likes,
      (SELECT COUNT(*) FROM loop_post_comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) comments,
      (SELECT COUNT(*) FROM loop_posts r WHERE r.original_post_id=p.id AND r.deleted_at IS NULL) reposts,
      EXISTS(SELECT 1 FROM loop_post_likes l WHERE l.post_id=p.id AND l.user_id=?) liked,
      EXISTS(SELECT 1 FROM loop_bookmarks b WHERE b.post_id=p.id AND b.user_id=?) bookmarked
    FROM loop_posts p JOIN users u ON u.id=p.user_id
    WHERE p.deleted_at IS NULL AND ${where}
      AND ${postVisibility}`;

  function mediaFor(ids) {
    if (!ids.length) return new Map();
    const rows = database.prepare(`SELECT * FROM loop_post_media WHERE post_id IN (${ids.map(() => '?').join(',')}) ORDER BY position,id`).all(...ids);
    const playbackStatuses = videos.publicStatuses(rows.filter(row => row.mime_type.startsWith('video/')).map(row => Number(row.id)));
    const captionStatuses = captions.publicStatuses(rows.map(row => Number(row.id)));
    const map = new Map();
    for (const row of rows) {
      const list = map.get(Number(row.post_id)) || [];
      const playback = playbackStatuses.get(Number(row.id)) || null;
      list.push({ id: Number(row.id), name: row.original_name, mimeType: playback?.status === 'ready' ? 'video/mp4' : row.mime_type, size: Number(row.size_bytes), url: playback?.url || `/api/v1/loop/media/${row.id}`, originalUrl: `/api/v1/loop/media/${row.id}?original=1`, playback, captions: captionStatuses.get(Number(row.id)) || null });
      map.set(Number(row.post_id), list);
    }
    return map;
  }

  function publicPosts(rows, viewerId) {
    const sources = rows.some(row => row.original_post_id)
      ? database.prepare(`${mediaSources(`SELECT id,original_post_id FROM loop_posts WHERE id IN (${rows.map(() => '?').join(',')})`)} SELECT id,original_post_id FROM media_sources`)
        .all(...rows.map(row => Number(row.id)), viewerId, viewerId, viewerId)
      : rows;
    const parents = new Map(sources.map(row => [Number(row.id), Number(row.original_post_id) || null]));
    const map = mediaFor([...parents.keys()]);
    const postMedia = (postId) => {
      const seen = new Set();
      while (parents.has(postId) && !seen.has(postId)) {
        seen.add(postId);
        const files = map.get(postId);
        if (files?.length) return files;
        postId = parents.get(postId);
      }
      return [];
    };
    const originalIds = [...new Set(rows.map(row => Number(row.original_post_id)).filter(Boolean))];
    const originals = new Map(originalIds.length ? database.prepare(`SELECT p.id,p.user_id,u.username,u.is_verified
      FROM loop_posts p JOIN users u ON u.id=p.user_id
      WHERE p.id IN (${originalIds.map(() => '?').join(',')}) AND p.deleted_at IS NULL AND ${postVisibility}`)
      .all(...originalIds, viewerId, viewerId, viewerId)
      .map(row => [Number(row.id), { id: Number(row.id), author: { id: Number(row.user_id), username: row.username, verified:Boolean(row.is_verified) } }]) : []);
    const polls = new Map();
    if (rows.length) {
      const ids = rows.map(row => Number(row.id));
      const marks = ids.map(() => '?').join(',');
      for (const row of database.prepare(`SELECT * FROM loop_post_polls WHERE post_id IN (${marks})`).all(...ids)) {
        polls.set(Number(row.post_id), { question: row.question, options: safeJson(row.options_json, []).map((text, index) => ({ index, text, votes: 0, voted: false })), voterCount: 0 });
      }
      for (const row of database.prepare(`SELECT post_id, option_index, COUNT(*) votes, MAX(user_id=?) voted FROM loop_poll_votes WHERE post_id IN (${marks}) GROUP BY post_id,option_index`).all(viewerId, ...ids)) {
        const poll = polls.get(Number(row.post_id));
        if (!poll?.options[row.option_index]) continue;
        poll.options[row.option_index].votes = Number(row.votes);
        poll.options[row.option_index].voted = Boolean(row.voted);
        poll.voterCount += Number(row.votes);
      }
    }
    return rows.map((row) => ({
      id: Number(row.id), author: { id: Number(row.user_id), username: row.username || 'Unknown', verified:Boolean(row.is_verified), avatarUrl: row.avatar_url || null },
      content: row.body, createdAt: row.created_at, editedAt: row.edited_at || null,
      tags: cleanTags(safeJson(row.tags_json, [])), media: postMedia(Number(row.id)),
      poll: polls.get(Number(row.id)) || null,
      originalPostId: row.original_post_id ? Number(row.original_post_id) : null,
      originalPost: originals.get(Number(row.original_post_id)) || null,
      likes: Number(row.likes || 0), comments: Number(row.comments || 0), reposts: Number(row.reposts || 0),
      liked: Boolean(row.liked), bookmarked: Boolean(row.bookmarked), own: Number(row.user_id) === Number(viewerId),
    }));
  }

  function loadPost(postId, viewerId) {
    const row = database.prepare(`${postSelect('p.id=?')} LIMIT 1`).get(viewerId, viewerId, postId, viewerId, viewerId, viewerId);
    return row ? publicPosts([row], viewerId)[0] : null;
  }

  function homePage(viewerId) {
    const rows = database.prepare(`${postSelect()} ORDER BY p.id DESC LIMIT 13`).all(viewerId, viewerId, viewerId, viewerId, viewerId);
    const page = rows.slice(0, 12), hasMore = rows.length > 12;
    return { posts: publicPosts(page, viewerId), page: { hasMore, nextBefore: hasMore ? Number(page.at(-1).id) : null } };
  }

  const notificationDefaults = { comments: true, replies: true, likes: true, follows: true, mentions: true, reposts: true, browserPush: false };
  function preferences(userId) {
    return { ...notificationDefaults, ...safeJson(database.prepare('SELECT settings_json FROM loop_notification_preferences WHERE user_id=?').get(userId)?.settings_json, {}) };
  }
  function blocked(a, b) {
    return Boolean(database.prepare('SELECT 1 FROM loop_blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)').get(a,b,b,a));
  }
  function notify(userId, actorId, type, postId, body, now, commentId = null) {
    if (!userId || Number(userId) === Number(actorId)) return;
    const setting = { comment:'comments', reply:'replies', like:'likes', follow:'follows', mention:'mentions', repost:'reposts' }[type];
    if (!preferences(userId)[setting] || blocked(userId, actorId) || database.prepare('SELECT 1 FROM loop_mutes WHERE user_id=? AND target_id=?').get(userId,actorId)) return;
    if (postId) {
      const post = database.prepare('SELECT user_id FROM loop_posts WHERE id=? AND deleted_at IS NULL').get(postId);
      if (!post || blocked(userId, post.user_id) || database.prepare('SELECT 1 FROM loop_mutes WHERE user_id=? AND target_id=?').get(userId,post.user_id)) return;
    }
    const key = `${userId}:${actorId}:${type}:${postId || 0}:${commentId || 0}`;
    const result = database.prepare('INSERT OR IGNORE INTO loop_notifications(user_id,actor_id,type,post_id,body,created_at,comment_id,event_key) VALUES(?,?,?,?,?,?,?,?)').run(userId,actorId,type,postId || null,body || '',now,commentId,key);
    if (result.changes) {
      const id = Number(result.lastInsertRowid);
      realtimeHub.send(userId, 'loop-notification', { id, type, postId: postId || null, commentId });
      if (preferences(userId).browserPush && pushService) {
        const actor = database.prepare('SELECT username FROM users WHERE id=?').get(actorId);
        pushService.notifyUsers([userId], {
          kind: 'loop', title: 'Loop', body: `${actor?.username || 'Someone'} ${body || 'has new activity for you'}`,
          url: postId ? `/loop?post=${postId}${commentId ? `&comment=${commentId}` : ''}` : `/loop?profile=${actorId}`,
          tag: `loop:${id}`, postId: postId || null, commentId, profileId: postId ? null : actorId,
        });
      }
    }
    return true;
  }
  function mentionUsers(content) {
    const names = [...new Set([...content.matchAll(/(?:^|[\s(])@([^\s@]{1,32})/gu)].map(match => match[1].replace(/[.,!?;:)]+$/, '').toLowerCase()))].slice(0,10);
    if (!names.length) return [];
    return database.prepare(`SELECT id,username FROM users WHERE lower(username) IN (${names.map(() => '?').join(',')})`).all(...names);
  }
  function notifyMentions(content, actorId, postId, now, commentId = null, skip = new Set()) {
    for (const target of mentionUsers(content)) if (!skip.has(Number(target.id))) notify(target.id,actorId,'mention',postId,commentId ? 'mentioned you in a comment' : 'mentioned you in a post',now,commentId);
  }

  function publishAuraUpdate(userId, amount, reason, now) {
    const account = database.prepare('SELECT balance,streak_days,last_checkin_date FROM loop_aura_balances WHERE user_id=?').get(userId);
    realtimeHub.send(userId, 'loop-aura-updated', {
      balance: Number(account?.balance || 0), delta: amount, reason,
      streakDays: Number(account?.streak_days || 0), lastCheckinDate: account?.last_checkin_date || null,
      updatedAt: now,
    });
  }

  function awardAura(userId, amount, reason, eventKey, now, dailyLimit = 0) {
    const day = String(now).slice(0, 10);
    database.exec('BEGIN IMMEDIATE');
    let awarded = false;
    try {
      if (!database.prepare('SELECT 1 FROM loop_aura_ledger WHERE event_key=?').get(eventKey)) {
        const count = dailyLimit ? Number(database.prepare('SELECT COUNT(*) count FROM loop_aura_ledger WHERE user_id=? AND reason=? AND substr(created_at,1,10)=?').get(userId, reason, day).count) : 0;
        if (!dailyLimit || count < dailyLimit) {
          const result = database.prepare('INSERT OR IGNORE INTO loop_aura_ledger(user_id,amount,reason,event_key,created_at) VALUES(?,?,?,?,?)').run(userId, amount, reason, eventKey, now);
          if (result.changes) {
            database.prepare(`INSERT INTO loop_aura_balances(user_id,balance,updated_at) VALUES(?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET balance=balance+excluded.balance,updated_at=excluded.updated_at`).run(userId, amount, now);
            awarded = true;
          }
        }
      }
      database.exec('COMMIT');
    } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
    if (awarded) publishAuraUpdate(userId, amount, reason, now);
    return awarded;
  }

  function auraSummary(userId) {
    const balance = database.prepare('SELECT balance,streak_days,last_checkin_date FROM loop_aura_balances WHERE user_id=?').get(userId);
    const total = Number(balance?.balance || 0);
    const rank = Number(database.prepare(`SELECT COUNT(*)+1 rank FROM loop_aura_balances
      WHERE balance>? OR (balance=? AND user_id<?)`).get(total, total, userId).rank);
    const leaderboard = database.prepare(`SELECT a.user_id id,u.username,u.avatar_url avatarUrl,u.is_verified verified,a.balance,a.streak_days streakDays
      FROM loop_aura_balances a JOIN users u ON u.id=a.user_id
      WHERE a.balance>0 ORDER BY a.balance DESC,a.user_id ASC LIMIT 20`).all()
      .map(row => ({ id:Number(row.id),username:row.username,verified:Boolean(row.verified),avatarUrl:row.avatarUrl || null,balance:Number(row.balance),streakDays:Number(row.streakDays) }));
    return { userId:Number(userId),balance:total,streakDays:Number(balance?.streak_days || 0),lastCheckinDate:balance?.last_checkin_date || null,rank,leaderboard };
  }

  function checkInAura(userId, now) {
    const today = String(now).slice(0, 10);
    const yesterday = new Date(`${today}T00:00:00.000Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    let checkIn;
    database.exec('BEGIN IMMEDIATE');
    try {
      const current = database.prepare('SELECT streak_days,last_checkin_date FROM loop_aura_balances WHERE user_id=?').get(userId);
      const alreadyClaimed = current?.last_checkin_date === today;
      let streakDays = Number(current?.streak_days || 0);
      let award = 0;
      let streakBonus = 0;
      if (!alreadyClaimed) {
        streakDays = current?.last_checkin_date === yesterdayKey ? streakDays + 1 : 1;
        streakBonus = ({2:5,7:20,30:100})[streakDays] || 0;
        award = 5 + streakBonus;
        database.prepare('INSERT INTO loop_aura_ledger(user_id,amount,reason,event_key,created_at) VALUES(?,?,?,?,?)').run(userId, 5, 'daily_visit', `visit:${userId}:${today}`, now);
        if (streakBonus) database.prepare('INSERT INTO loop_aura_ledger(user_id,amount,reason,event_key,created_at) VALUES(?,?,?,?,?)').run(userId, streakBonus, 'streak_milestone', `streak:${userId}:${today}:${streakDays}`, now);
        database.prepare(`INSERT INTO loop_aura_balances(user_id,balance,streak_days,last_checkin_date,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET balance=balance+excluded.balance,streak_days=excluded.streak_days,last_checkin_date=excluded.last_checkin_date,updated_at=excluded.updated_at`).run(userId, award, streakDays, today, now);
      }
      const todayAura = Number(database.prepare(`SELECT COALESCE(SUM(amount),0) total FROM loop_aura_ledger
        WHERE user_id=? AND substr(created_at,1,10)=? AND reason IN ('daily_visit','streak_milestone')`).get(userId, today).total);
      database.exec('COMMIT');
      checkIn = { date:today,claimed:!alreadyClaimed,alreadyClaimed,aura:todayAura,streakBonus:alreadyClaimed ? Number(database.prepare(`SELECT COALESCE(SUM(amount),0) total FROM loop_aura_ledger WHERE user_id=? AND substr(created_at,1,10)=? AND reason='streak_milestone'`).get(userId,today).total) : streakBonus,streakDays };
    } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
    if (checkIn.claimed) publishAuraUpdate(userId, checkIn.aura, checkIn.streakBonus ? 'streak_milestone' : 'daily_visit', now);
    return { ...auraSummary(userId),checkIn };
  }

  const connectedAccount = database.prepare('SELECT 1 FROM loop_accounts WHERE user_id=?');
  const presence = createLoopPresence({
    canJoin: id => Boolean(connectedAccount.get(id)),
    notify: (ids, event, payload) => realtimeHub.broadcast(ids, event, payload),
    visibleUsers: (ids, viewerId) => database.prepare(`
      SELECT u.id,u.username,u.avatar_url,u.is_verified FROM users u JOIN loop_accounts a ON a.user_id=u.id
      WHERE u.id IN (SELECT value FROM json_each(?)) AND u.presence_hidden=0 AND u.keep_information_secret=0
      AND NOT EXISTS(SELECT 1 FROM loop_blocks b WHERE (b.user_id=? AND b.target_id=u.id) OR (b.target_id=? AND b.user_id=u.id))
      ORDER BY u.id
    `).all(JSON.stringify(ids),viewerId,viewerId).map(row => ({ id:Number(row.id), username:row.username, verified:Boolean(row.is_verified), avatarUrl:row.avatar_url || null, presence:publicPresence(row.id) })).filter(row => row.presence !== 'offline'),
  });

  const auth = (request, response) => {
    const user = currentUser(request);
    if (!user?.username) { sendJson(response, 401, { error: 'Sign in to use Glean Loop.' }); return null; }
    return user;
  };

  async function route(request, response, path, now) {
    if (!path.startsWith('/api/loop/')) return false;
    const user = auth(request, response);
    if (!user) return true;
    const method = request.method;
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (path === '/api/loop/connection' && (method === 'GET' || method === 'POST')) {
      let created = false;
      if (method === 'POST') {
        const body = await readJson(request);
        if (body?.confirmed !== true || body?.consentVersion !== 1) return sendJson(response,400,{error:'Confirm the account connection before continuing.'}),true;
        const result = database.prepare('INSERT INTO loop_accounts(user_id,connected_at,consent_version) VALUES(?,?,1) ON CONFLICT(user_id) DO NOTHING').run(user.id,now);
        created = Boolean(result.changes);
      }
      const connection = database.prepare('SELECT connected_at,consent_version FROM loop_accounts WHERE user_id=?').get(user.id);
      return sendJson(response,created ? 201 : 200,{connected:Boolean(connection),connectedAt:connection?.connected_at || null,consentVersion:connection?.consent_version || 1,account:{id:Number(user.id),username:user.username,avatarUrl:user.avatar_url || null},...(connection && url.searchParams.get('includePosts') === '1' ? { feed: homePage(user.id) } : {})}),true;
    }
    if (!database.prepare('SELECT 1 FROM loop_accounts WHERE user_id=?').get(user.id)) return sendJson(response,403,{error:'Connect your Glean account to Glean Loop before continuing.',loopConnectionRequired:true}),true;

    if (method === 'GET' && path === '/api/loop/aura') return sendJson(response,200,auraSummary(Number(user.id))),true;
    if (method === 'POST' && path === '/api/loop/aura/check-in') return sendJson(response,200,checkInAura(Number(user.id),now)),true;

    if (method === 'GET' && path === '/api/loop/online') {
      const after = Number(url.searchParams.get('after') || 0);
      const limit = Number(url.searchParams.get('limit') || 30);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return sendJson(response,400,{error:'Choose a valid online people page.'}),true;
      const people = presence.list(user.id);
      const remaining = people.filter(person => person.id > after);
      const page = remaining.slice(0,limit);
      return sendJson(response,200,{users:page,total:people.length,page:{hasMore:remaining.length>limit,nextAfter:remaining.length>limit ? page.at(-1).id : null}}),true;
    }

    if (method === 'GET' && path === '/api/loop/captions/config') return sendJson(response,200,{available:captions.available(),maxDurationSeconds:1800}),true;
    const captionMatch = path.match(/^\/api\/loop\/media\/(\d+)\/captions(?:\.vtt)?$/);
    if (captionMatch && (method === 'GET' || method === 'POST')) {
      const id = Number(captionMatch[1]);
      const media = database.prepare('SELECT * FROM loop_post_media WHERE id=?').get(id);
      const post = media && loadPost(Number(media.post_id),user.id);
      if (!post) return sendJson(response,404,{error:'Video unavailable.'}),true;
      const record = captions.get(id);
      if (method === 'POST') {
        if (!post.own) return sendJson(response,403,{error:'Only the uploader can retry captions.'}),true;
        if (!record || record.status !== 'failed') return sendJson(response,409,{error:'There are no failed captions to retry.'}),true;
        if (!captions.available()) return sendJson(response,503,{error:'Auto captions are temporarily unavailable.'}),true;
        if (record.attempts >= 3) return sendJson(response,429,{error:'Caption retry limit reached for this video.'}),true;
        database.prepare("UPDATE loop_media_captions SET status='queued',error='',updated_at=? WHERE media_id=?").run(now,id);
        captions.kick(); return sendJson(response,202,{captions:captions.publicStatus(id)}),true;
      }
      if (path.endsWith('.vtt')) {
        if (record?.status !== 'ready') return sendJson(response,404,{error:'Captions are not ready.'}),true;
        response.writeHead(200,{'Content-Type':'text/vtt; charset=utf-8','Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});
        response.end(captionVtt(safeJson(record.cues_json,[]))); return true;
      }
      return sendJson(response,200,{captions:captions.publicStatus(id)}),true;
    }

    if (method === 'GET' && path === '/api/loop/flow') {
      let result;
      try { result = flowPage(Number(user.id), url.searchParams); }
      catch (failure) { if (failure.status !== 400) throw failure; return sendJson(response,400,{error:failure.message}),true; }
      const rows = result.ids.length ? database.prepare(postSelect(`p.id IN (${result.ids.map(() => '?').join(',')})`)).all(user.id,user.id,...result.ids,user.id,user.id,user.id) : [];
      const posts = new Map(publicPosts(rows,user.id).map(post => [post.id,post]));
      return sendJson(response,200,{posts:result.ids.map(id => posts.get(id)).filter(Boolean),page:result.page}),true;
    }

    if (method === 'GET' && path === '/api/loop/posts') {
      if (url.searchParams.has('ids')) {
        const raw = url.searchParams.get('ids').split(',');
        if (!raw.length || raw.length > 60 || raw.some(id => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
          return sendJson(response, 400, { error: 'Choose between 1 and 60 valid post IDs.' }), true;
        }
        const ids = [...new Set(raw.map(Number))];
        // Refresh already-loaded posts after reconnect without losing history.
        // The same viewer block/mute and deletion checks apply as to the feed.
        const rows = database.prepare(`${postSelect(`p.id IN (${ids.map(() => '?').join(',')})`)} ORDER BY p.id DESC`)
          .all(user.id, user.id, ...ids, user.id, user.id, user.id);
        return sendJson(response, 200, { posts: publicPosts(rows, user.id) }), true;
      }
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 12));
      const before = Math.max(0, Number(url.searchParams.get('before')) || 0);
      const author = Math.max(0, Number(url.searchParams.get('author')) || 0);
      const query = String(url.searchParams.get('q') || '').trim().slice(0, 80);
      const tag = String(url.searchParams.get('tag') || '').replace(/^#/, '').toLowerCase();
      const bookmarked = url.searchParams.get('bookmarked') === '1';
      const feed = url.searchParams.get('feed') || 'everyone';
      if (!['everyone','following'].includes(feed)) return sendJson(response,400,{error:'Choose Everyone or Following.'}),true;
      const type = String(url.searchParams.get('type') || 'all');
      if (!['all', 'text', 'photo', 'gif', 'video', 'audio', 'poll'].includes(type)) return sendJson(response, 400, { error: 'Choose a valid post type.' }), true;
      if (limit === 12 && !before && !author && !query && !tag && !bookmarked && feed === 'everyone' && type === 'all') return sendJson(response,200,homePage(user.id)),true;
      const clauses = ['(?=0 OR p.id<?)', author ? 'p.user_id=?' : '(?=0 OR p.user_id=?)', "(?='' OR lower(p.body) LIKE '%'||lower(?)||'%' OR lower(u.username) LIKE '%'||lower(?)||'%' OR EXISTS(SELECT 1 FROM loop_post_polls x WHERE x.post_id=p.id AND lower(x.question) LIKE '%'||lower(?)||'%'))", "(?='' OR EXISTS(SELECT 1 FROM json_each(p.tags_json) WHERE value=?))", '(?=0 OR EXISTS(SELECT 1 FROM loop_bookmarks x WHERE x.post_id=p.id AND x.user_id=?))'];
      const sourceIds = `${mediaSources('SELECT p.id,p.original_post_id')} SELECT id FROM media_sources`;
      const mediaTypes = { text: `NOT EXISTS(SELECT 1 FROM loop_post_media f WHERE f.post_id IN (${sourceIds}))`, photo: `EXISTS(SELECT 1 FROM loop_post_media f WHERE f.post_id IN (${sourceIds}) AND f.mime_type LIKE 'image/%' AND f.mime_type!='image/gif')`, gif: `EXISTS(SELECT 1 FROM loop_post_media f WHERE f.post_id IN (${sourceIds}) AND f.mime_type='image/gif')`, video: `EXISTS(SELECT 1 FROM loop_post_media f WHERE f.post_id IN (${sourceIds}) AND f.mime_type LIKE 'video/%')`, audio: `EXISTS(SELECT 1 FROM loop_post_media f WHERE f.post_id IN (${sourceIds}) AND f.mime_type LIKE 'audio/%')` };
      if (type === 'poll') clauses.push('EXISTS(SELECT 1 FROM loop_post_polls x WHERE x.post_id=p.id)');
      else if (type !== 'all') clauses.push(mediaTypes[type]);
      if (type === 'text') clauses.push('NOT EXISTS(SELECT 1 FROM loop_post_polls x WHERE x.post_id=p.id)');
      if (feed === 'following') clauses.push('EXISTS(SELECT 1 FROM loop_follows f WHERE f.follower_id=? AND f.followed_id=p.user_id)');
      const sql = `${postSelect(clauses.join(' AND '))} ORDER BY p.id DESC LIMIT ?`;
      const rows = database.prepare(sql).all(user.id, user.id, before, before, ...(author ? [author] : [0, 0]), query, query, query, query, tag, tag, bookmarked ? 1 : 0, user.id, ...(mediaTypes[type] ? [user.id, user.id, user.id] : []), ...(feed === 'following' ? [user.id] : []), user.id, user.id, user.id, limit + 1);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const tags = author ? database.prepare(`SELECT value tag, COUNT(*) count FROM loop_posts p, json_each(p.tags_json) WHERE p.user_id=? AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM loop_blocks b WHERE (b.user_id=? AND b.target_id=p.user_id) OR (b.user_id=p.user_id AND b.target_id=?)) AND NOT EXISTS(SELECT 1 FROM loop_mutes m WHERE m.user_id=? AND m.target_id=p.user_id) GROUP BY value ORDER BY count DESC,value LIMIT 50`).all(author, user.id, user.id, user.id).map(row => ({ tag: row.tag, count: Number(row.count) })) : undefined;
      return sendJson(response, 200, { posts: publicPosts(page, user.id), ...(tags ? { tags } : {}), page: { hasMore, nextBefore: hasMore ? Number(page.at(-1)?.id || 0) : null } }), true;
    }

    if (method === 'POST' && path === '/api/loop/posts') {
      let content = '', tags = [], originalPostId = null, files = [], pollInput = null, autoCaptions = false, videoDownloadId = null;
      if (String(request.headers['content-type'] || '').startsWith('multipart/form-data')) {
        const parsed = await parseMultipart(request, { directory: uploadDirectory, nameFile });
        files = parsed.files; content = String(parsed.fields.content || '').trim(); tags = cleanTags(parsed.fields.tags); originalPostId = Number(parsed.fields.originalPostId) || null;
        if (parsed.fields.poll) pollInput = safeJson(parsed.fields.poll, false);
        autoCaptions = parsed.fields.autoCaptions === 'true';
        videoDownloadId = parsed.fields.videoDownloadId ?? null;
      } else {
        const body = await readJson(request); content = String(body.content || '').trim(); tags = cleanTags(body.tags); originalPostId = Number(body.originalPostId) || null;
        pollInput = body.poll ?? null;
        videoDownloadId = body.videoDownloadId ?? null;
      }
      const discardFiles = () => { for (const file of files) try { unlinkSync(join(uploadDirectory,file.storageName)); } catch {} };
      const videoExtensions = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ogv: 'video/ogg', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp' };
      for (const file of files) if (!file.type || file.type === 'application/octet-stream') file.type = videoExtensions[String(file.name).split('.').at(-1).toLowerCase()] || file.type;
      if (videoDownloadId !== null && (typeof videoDownloadId !== 'string' || !/^[a-f0-9-]{36}$/.test(videoDownloadId) || files.length)) { discardFiles(); return sendJson(response,400,{error:'Use one prepared video without other attachments.'}),true; }
      const valid = files.every((file) => IMAGE_TYPES.has(file.type) || VIDEO_TYPES.has(file.type) || AUDIO_TYPES.has(file.type));
      const imageOnly = files.every((file) => IMAGE_TYPES.has(file.type));
      if (!valid || (files.length > 1 && !imageOnly)) { for (const file of files) try { unlinkSync(join(uploadDirectory,file.storageName)); } catch {} return sendJson(response,400,{error:'Add up to 10 images, or one GIF, video, or audio file.'}), true; }
      let poll = null;
      if (pollInput !== null) {
        const question = typeof pollInput?.question === 'string' ? pollInput.question.trim() : '';
        const options = Array.isArray(pollInput?.options) ? pollInput.options.map(option => typeof option === 'string' ? option.trim() : '') : [];
        if (!question || question.length > 200 || options.length < 2 || options.length > 6 || options.some(option => !option || option.length > 100) || new Set(options.map(option => option.toLowerCase())).size !== options.length) {
          for (const file of files) try { unlinkSync(join(uploadDirectory, file.storageName)); } catch {}
          return sendJson(response, 400, { error: 'Add a poll question (up to 200 characters) and 2–6 different choices (up to 100 characters each).' }), true;
        }
        poll = { question, options };
      }
      if (content.length > 2000) { discardFiles(); return sendJson(response,400,{error:'Loop posts can be up to 2,000 characters.'}), true; }
      if (originalPostId && !loadPost(originalPostId,user.id)) { discardFiles(); return sendJson(response,404,{error:'That post no longer exists.'}), true; }
      if (videoDownloadId !== null) {
        if (!copyVideoDownload) return sendJson(response,503,{error:'Prepared video attachments are temporarily unavailable.'}),true;
        try { files = [await copyVideoDownload(user.id,videoDownloadId,nameFile())]; }
        catch (failure) { if (![400,404,409,503].includes(failure.status)) throw failure; return sendJson(response,failure.status,{error:failure.message}),true; }
        if (request.aborted || response.destroyed) { discardFiles(); return true; }
      }
      if (autoCaptions) {
        const failure = files.length !== 1 || !VIDEO_TYPES.has(files[0].type) ? {status:400,error:'Auto captions require one video.'} : captions.canQueue(user.id);
        if (failure) { discardFiles(); return sendJson(response,failure.status,{error:failure.error}),true; }
      }
      if (!content && !files.length && !originalPostId && !poll) return sendJson(response,400,{error:'Write something, add media, or create a poll before posting.'}), true;
      let postId;
      try {
        database.exec('BEGIN IMMEDIATE');
        const type = files[0] ? (IMAGE_TYPES.has(files[0].type) ? (files[0].type === 'image/gif' ? 'gif' : 'photo') : VIDEO_TYPES.has(files[0].type) ? 'video' : 'none') : 'none';
        postId = Number(database.prepare('INSERT INTO loop_posts(user_id,body,media_type,client_id,created_at,original_post_id,tags_json) VALUES(?,?,?,?,?,?,?)').run(user.id,content,type,null,now,originalPostId,JSON.stringify(tags)).lastInsertRowid);
        const insert = database.prepare('INSERT INTO loop_post_media(post_id,storage_name,original_name,mime_type,size_bytes,position) VALUES(?,?,?,?,?,?)');
        files.forEach((file,index) => {
          const result=insert.run(postId,file.storageName,String(file.name).slice(0,240),file.type,file.size,index);
          if (autoCaptions) captions.queue(Number(result.lastInsertRowid),now);
          if (VIDEO_TYPES.has(file.type)) {
            try { videos.queue(Number(result.lastInsertRowid),now); }
            catch (failure) { if (![429,503].includes(failure.status)) throw failure; }
          }
        });
        if (poll) database.prepare('INSERT INTO loop_post_polls(post_id,question,options_json) VALUES(?,?,?)').run(postId, poll.question, JSON.stringify(poll.options));
        database.exec('COMMIT');
      } catch (error) { try { database.exec('ROLLBACK'); } catch {} for (const file of files) try { unlinkSync(join(uploadDirectory,file.storageName)); } catch {} throw error; }
      if (originalPostId) { const owner = database.prepare('SELECT user_id FROM loop_posts WHERE id=?').get(originalPostId); notify(owner?.user_id,user.id,'repost',originalPostId,'reposted your post',now); }
      awardAura(Number(user.id),10,'post',`post:${postId}`,now,3);
      notifyMentions(content,user.id,postId,now);
      const post = loadPost(postId,user.id); realtimeHub.broadcastAll('loop-post-created',{ postId });
      if (autoCaptions) captions.kick();
      videos.kick();
      return sendJson(response,201,{post}), true;
    }

    const playbackMatch = path.match(/^\/api\/loop\/media\/(\d+)\/playback(?:\.mp4)?$/);
    if (playbackMatch && ['GET','HEAD','POST'].includes(method)) {
      const id = Number(playbackMatch[1]);
      const row = database.prepare('SELECT * FROM loop_post_media WHERE id=?').get(id);
      if (!row || !row.mime_type.startsWith('video/') || !loadPost(Number(row.post_id),user.id)) return sendJson(response,404,{error:'Video unavailable.'}),true;
      if (path.endsWith('.mp4')) {
        if (method === 'POST') return sendJson(response,405,{error:'Use the video preparation endpoint.'}),true;
        const file = videos.file(id);
        if (!file || !existsSync(file)) return sendJson(response,409,{error:'This video is still being prepared.'}),true;
        sendLocalFile(request,response,file,{type:'video/mp4',extra:{'Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'}}); return true;
      }
      if (method === 'POST') {
        const body = await readJson(request);
        if (body?.retry !== undefined && typeof body.retry !== 'boolean') return sendJson(response,400,{error:'Choose a valid video retry option.'}),true;
        try { const playback = videos.queue(id,now,body?.retry === true); videos.kick(); return sendJson(response,playback.status === 'ready' ? 200 : 202,{playback}),true; }
        catch (failure) { if (!failure.status) throw failure; return sendJson(response,failure.status,{error:failure.message}),true; }
      }
      return sendJson(response,200,{playback:videos.publicStatus(id)}),true;
    }

    const mediaMatch = path.match(/^\/api\/loop\/media\/(\d+)$/);
    if (['GET','HEAD'].includes(method) && mediaMatch) {
      const row = database.prepare('SELECT * FROM loop_post_media WHERE id=?').get(Number(mediaMatch[1]));
      if (!row || !loadPost(Number(row.post_id),user.id)) return sendJson(response,404,{error:'Media not found.'}), true;
      const compatible = row.mime_type.startsWith('video/') && url.searchParams.get('original') !== '1' ? videos.file(Number(row.id)) : null;
      if (compatible && existsSync(compatible)) { sendLocalFile(request,response,compatible,{type:'video/mp4',extra:{'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'}}); return true; }
      const file = join(uploadDirectory,row.storage_name);
      if (!existsSync(file)) return sendJson(response,404,{error:'Media file is unavailable.'}), true;
      sendLocalFile(request,response,file,{type:row.mime_type,extra:{'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'}}); return true;
    }

    const singlePostMatch = path.match(/^\/api\/loop\/posts\/(\d+)$/);
    if (method === 'GET' && singlePostMatch) {
      const post = loadPost(Number(singlePostMatch[1]), user.id);
      return post ? (sendJson(response, 200, { post }), true) : (sendJson(response, 404, { error: 'Post not found.' }), true);
    }
    const postMatch = path.match(/^\/api\/loop\/posts\/(\d+)$/);
    if (postMatch && (method === 'PATCH' || method === 'DELETE')) {
      const postId = Number(postMatch[1]); const row = database.prepare('SELECT * FROM loop_posts WHERE id=? AND deleted_at IS NULL').get(postId);
      if (!row) return sendJson(response,404,{error:'Post not found.'}), true;
      if (Number(row.user_id)!==Number(user.id) && !isAdmin(user)) return sendJson(response,403,{error:'You cannot change this post.'}), true;
      if (method === 'DELETE') { database.prepare('UPDATE loop_posts SET deleted_at=? WHERE id=?').run(now,postId); database.prepare('DELETE FROM loop_media_captions WHERE media_id IN (SELECT id FROM loop_post_media WHERE post_id=?)').run(postId); await videos.removePost(postId); realtimeHub.broadcastAll('loop-post-deleted',{postId}); return sendJson(response,200,{ok:true}), true; }
      const body = await readJson(request); const content = String(body.content ?? row.body).trim(); const tags = cleanTags(body.tags ?? safeJson(row.tags_json,[]));
      if (!content && !mediaFor([postId]).get(postId)?.length && !row.original_post_id && !database.prepare('SELECT 1 FROM loop_post_polls WHERE post_id=?').get(postId)) return sendJson(response,400,{error:'A post cannot be empty.'}), true;
      database.prepare('UPDATE loop_posts SET body=?,tags_json=?,edited_at=? WHERE id=?').run(content.slice(0,2000),JSON.stringify(tags),now,postId);
      realtimeHub.broadcastAll('loop-post-updated',{postId}); return sendJson(response,200,{post:loadPost(postId,user.id)}), true;
    }

    const votersMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/poll\/voters$/);
    if (method === 'GET' && votersMatch) {
      const postId = Number(votersMatch[1]);
      const post = loadPost(postId, user.id);
      if (!post?.poll) return sendJson(response, 404, { error: 'Poll not found.' }), true;
      const url = new URL(request.url, 'http://localhost');
      const option = Number(url.searchParams.get('option')), after = Number(url.searchParams.get('after') || 0);
      if (!Number.isInteger(option) || option < 0 || option >= post.poll.options.length || !Number.isSafeInteger(after) || after < 0) return sendJson(response, 400, { error: 'Invalid voter page.' }), true;
      const rows = database.prepare('SELECT users.id, users.username, users.avatar_url AS avatarUrl FROM loop_poll_votes v JOIN users ON users.id = v.user_id WHERE v.post_id = ? AND v.option_index = ? AND v.user_id > ? ORDER BY v.user_id LIMIT 51').all(postId, option, after);
      return sendJson(response, 200, { voters: rows.slice(0, 50), next: rows.length > 50 ? Number(rows[49].id) : null }), true;
    }
    const voteMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/poll\/vote$/);
    if (method === 'POST' && voteMatch) {
      const postId = Number(voteMatch[1]);
      const post = loadPost(postId, user.id);
      if (!post?.poll) return sendJson(response, 404, { error: 'Poll not found.' }), true;
      const { optionIndex } = await readJson(request);
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= post.poll.options.length) return sendJson(response, 400, { error: 'Choose a valid poll option.' }), true;
      database.prepare('INSERT INTO loop_poll_votes(post_id,user_id,option_index) VALUES(?,?,?) ON CONFLICT(post_id,user_id) DO UPDATE SET option_index=excluded.option_index').run(postId, user.id, optionIndex);
      realtimeHub.broadcastAll('loop-post-updated', { postId });
      return sendJson(response, 200, { post: loadPost(postId, user.id) }), true;
    }

    const toggleMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/(like|bookmark)$/);
    if (method === 'POST' && toggleMatch) {
      const postId=Number(toggleMatch[1]); const visible=loadPost(postId,user.id); const post=visible ? {user_id:visible.author.id} : null;
      if (!post) return sendJson(response,404,{error:'Post not found.'}), true;
      const table=toggleMatch[2]==='like'?'loop_post_likes':'loop_bookmarks'; const found=database.prepare(`SELECT 1 FROM ${table} WHERE post_id=? AND user_id=?`).get(postId,user.id);
      if(found) database.prepare(`DELETE FROM ${table} WHERE post_id=? AND user_id=?`).run(postId,user.id); else database.prepare(`INSERT INTO ${table}(post_id,user_id,created_at) VALUES(?,?,?)`).run(postId,user.id,now);
      if(!found&&toggleMatch[2]==='like') notify(post.user_id,user.id,'like',postId,'liked your post',now);
      if(!found&&toggleMatch[2]==='like'&&Number(post.user_id)!==Number(user.id)) awardAura(Number(post.user_id),1,'received_like',`like:${postId}:${user.id}`,now,50);
      realtimeHub.broadcastAll('loop-post-updated',{postId}); return sendJson(response,200,{active:!found,post:loadPost(postId,user.id)}), true;
    }

    const repostMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/repost$/);
    if (method === 'POST' && repostMatch) {
      const originalPostId = Number(repostMatch[1]);
      const original = loadPost(originalPostId,user.id);
      if (!original) return sendJson(response, 404, { error: 'Post not found.' }), true;
      const duplicate = database.prepare('SELECT id FROM loop_posts WHERE user_id=? AND original_post_id=? AND deleted_at IS NULL').get(user.id, originalPostId);
      if (duplicate) return sendJson(response, 200, { post: loadPost(Number(duplicate.id), user.id) }), true;
      const id = Number(database.prepare('INSERT INTO loop_posts(user_id,body,media_type,created_at,original_post_id,tags_json) VALUES(?,?,?,?,?,?)').run(user.id, '', 'none', now, originalPostId, '[]').lastInsertRowid);
      awardAura(Number(user.id),10,'post',`post:${id}`,now,3);
      notify(database.prepare('SELECT user_id FROM loop_posts WHERE id=?').get(originalPostId)?.user_id, user.id, 'repost', originalPostId, 'reposted your post', now);
      realtimeHub.broadcastAll('loop-post-created', { postId: id });
      return sendJson(response, 201, { post: loadPost(id, user.id) }), true;
    }

    const commentsMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/comments$/);
    if (commentsMatch && method === 'GET') {
      const postId = Number(commentsMatch[1]);
      if (!loadPost(postId,user.id)) return sendJson(response,404,{error:'Post not found.'}),true;
      const parent = Number(url.searchParams.get('parent')) || null;
      if (parent && !database.prepare('SELECT 1 FROM loop_post_comments WHERE id=? AND post_id=?').get(parent,postId)) return sendJson(response,404,{error:'Thread not found.'}),true;
      const focus = Number(url.searchParams.get('focus')) || 0;
      const after = focus ? Math.max(0,focus-1) : Math.max(0,Number(url.searchParams.get('after')) || 0);
      const rows = database.prepare(`SELECT c.*,u.username,u.avatar_url,u.is_verified,
        (SELECT COUNT(*) FROM loop_post_comments child WHERE child.parent_id=c.id) reply_count
        FROM loop_post_comments c JOIN users u ON u.id=c.user_id
        WHERE c.post_id=? AND c.parent_id IS ? AND c.id>?
        AND NOT EXISTS(SELECT 1 FROM loop_blocks b WHERE (b.user_id=? AND b.target_id=c.user_id) OR (b.user_id=c.user_id AND b.target_id=?))
        ORDER BY c.id LIMIT 21`).all(postId,parent,after,user.id,user.id);
      const page = rows.slice(0,20);
      return sendJson(response,200,{comments:page.map(r => ({id:Number(r.id),parentId:r.parent_id ? Number(r.parent_id) : null,content:r.deleted_at ? '' : r.body,deleted:Boolean(r.deleted_at),replyCount:Number(r.reply_count),createdAt:r.created_at,own:Number(r.user_id)===Number(user.id),author:{id:Number(r.user_id),username:r.username,verified:Boolean(r.is_verified),avatarUrl:r.avatar_url || null}})),page:{hasMore:rows.length>20,nextAfter:rows.length>20 ? Number(page.at(-1).id) : null}}),true;
    }
    if (commentsMatch && method === 'POST') {
      const postId=Number(commentsMatch[1]); const visible=loadPost(postId,user.id); const post=visible ? {user_id:visible.author.id} : null; if(!post) return sendJson(response,404,{error:'Post not found.'}), true;
      const body=await readJson(request); const content=String(body.content||'').trim(); if(!content||content.length>1000) return sendJson(response,400,{error:'Comments must be 1 to 1,000 characters.'}), true;
      const parentId = body.parentId ?? null;
      if (parentId !== null && (!Number.isSafeInteger(parentId) || parentId <= 0)) return sendJson(response,400,{error:'Choose a valid comment to reply to.'}),true;
      const parent = parentId ? database.prepare('SELECT * FROM loop_post_comments WHERE id=? AND post_id=? AND deleted_at IS NULL').get(parentId,postId) : null;
      if (parentId && (!parent || blocked(user.id,parent.user_id))) return sendJson(response,404,{error:'Comment unavailable.'}),true;
      const id=Number(database.prepare('INSERT INTO loop_post_comments(post_id,user_id,body,created_at,parent_id) VALUES(?,?,?,?,?)').run(postId,user.id,content,now,parentId).lastInsertRowid);
      awardAura(Number(user.id),2,'comment',`comment:${id}`,now,10);
      const notified = new Set();
      if (parent && notify(parent.user_id,user.id,'reply',postId,'replied to your comment',now,id)) notified.add(Number(parent.user_id));
      if (!notified.has(Number(post.user_id)) && notify(post.user_id,user.id,'comment',postId,parent ? 'replied in your post’s discussion' : 'commented on your post',now,id)) notified.add(Number(post.user_id));
      notifyMentions(content,user.id,postId,now,id,notified);
      realtimeHub.broadcastAll('loop-comment-created',{postId,commentId:id,parentId}); return sendJson(response,201,{id,parentId}), true;
    }
    const commentDelete=path.match(/^\/api\/loop\/comments\/(\d+)$/);
    if(commentDelete&&method==='DELETE'){const row=database.prepare('SELECT * FROM loop_post_comments WHERE id=? AND deleted_at IS NULL').get(Number(commentDelete[1]));if(!row)return sendJson(response,404,{error:'Comment not found.'}),true;if(Number(row.user_id)!==Number(user.id)&&!isAdmin(user))return sendJson(response,403,{error:'You cannot delete this comment.'}),true;database.prepare("UPDATE loop_post_comments SET deleted_at=?,body='' WHERE id=?").run(now,row.id);database.prepare('DELETE FROM loop_notifications WHERE comment_id=?').run(row.id);realtimeHub.broadcastAll('loop-comment-deleted',{postId:Number(row.post_id),commentId:Number(row.id),parentId:row.parent_id});return sendJson(response,200,{ok:true}),true;}

    if(method==='GET'&&path==='/api/loop/trending'){const tags=database.prepare(`SELECT value tag,COUNT(*) count FROM loop_posts,json_each(loop_posts.tags_json) WHERE deleted_at IS NULL GROUP BY value ORDER BY count DESC,value LIMIT 12`).all();return sendJson(response,200,{tags:tags.map((x)=>({tag:x.tag,count:Number(x.count)}))}),true;}
    if(method==='GET'&&path==='/api/loop/users'){const q=String(url.searchParams.get('q')||'').trim();const rows=database.prepare(`SELECT id,username,avatar_url,bio,is_verified FROM users WHERE username IS NOT NULL AND id!=? AND (?='' OR lower(username) LIKE '%'||lower(?)||'%') AND NOT EXISTS(SELECT 1 FROM loop_blocks WHERE (user_id=? AND target_id=users.id) OR (user_id=users.id AND target_id=?)) ORDER BY username LIMIT 30`).all(user.id,q,q,user.id,user.id);return sendJson(response,200,{users:rows.map((r)=>({id:Number(r.id),username:r.username,verified:Boolean(r.is_verified),avatarUrl:r.avatar_url||null,bio:r.bio||''}))}),true;}

    const profileMatch=path.match(/^\/api\/loop\/profiles\/(\d+)$/);
    if(method==='GET'&&profileMatch){const id=Number(profileMatch[1]);const row=database.prepare(`SELECT id,username,avatar_url,bio,is_verified,loop_background_json,created_at,(SELECT COUNT(*) FROM loop_follows WHERE followed_id=users.id) followers,(SELECT COUNT(*) FROM loop_follows WHERE follower_id=users.id) following,EXISTS(SELECT 1 FROM loop_follows WHERE follower_id=? AND followed_id=users.id) followed FROM users WHERE id=?`).get(user.id,id);if(!row)return sendJson(response,404,{error:'User not found.'}),true;return sendJson(response,200,{profile:{id,username:row.username,verified:Boolean(row.is_verified),avatarUrl:row.avatar_url||null,bio:row.bio||'',background:safeJson(row.loop_background_json,{}),followers:Number(row.followers),following:Number(row.following),followed:Boolean(row.followed),own:id===Number(user.id)}}),true;}
    if(method==='PATCH'&&path==='/api/loop/profile'){const body=await readJson(request);const background={color:/^#[0-9a-f]{6}$/i.test(body.background?.color||'')?body.background.color:'#0c2439',imageUrl:String(body.background?.imageUrl||'').slice(0,500)};database.prepare('UPDATE users SET loop_background_json=? WHERE id=?').run(JSON.stringify(background),user.id);return sendJson(response,200,{background}),true;}
    const followMatch=path.match(/^\/api\/loop\/users\/(\d+)\/follow$/);
    if(method==='POST'&&followMatch){const target=Number(followMatch[1]);if(target===Number(user.id))return sendJson(response,400,{error:'You cannot follow yourself.'}),true;if(!database.prepare('SELECT 1 FROM users WHERE id=?').get(target)||blocked(user.id,target))return sendJson(response,404,{error:'User unavailable.'}),true;const found=database.prepare('SELECT 1 FROM loop_follows WHERE follower_id=? AND followed_id=?').get(user.id,target);if(found)database.prepare('DELETE FROM loop_follows WHERE follower_id=? AND followed_id=?').run(user.id,target);else database.prepare('INSERT INTO loop_follows(follower_id,followed_id,created_at) VALUES(?,?,?)').run(user.id,target,now);if(!found){notify(target,user.id,'follow',null,'followed you',now);awardAura(target,2,'new_follower',`follow:${user.id}:${target}`,now,20);}realtimeHub.send(user.id,'loop-follow-updated',{targetId:target,followed:!found});return sendJson(response,200,{followed:!found}),true;}

    const visibleNotifications = `n.user_id=?
      AND (n.post_id IS NULL OR EXISTS(SELECT 1 FROM loop_posts p WHERE p.id=n.post_id AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM loop_blocks b WHERE (b.user_id=n.user_id AND b.target_id=p.user_id) OR (b.target_id=n.user_id AND b.user_id=p.user_id)) AND NOT EXISTS(SELECT 1 FROM loop_mutes m WHERE m.user_id=n.user_id AND m.target_id=p.user_id)))
      AND NOT EXISTS(SELECT 1 FROM loop_blocks b WHERE (b.user_id=n.user_id AND b.target_id=n.actor_id) OR (b.user_id=n.actor_id AND b.target_id=n.user_id))
      AND NOT EXISTS(SELECT 1 FROM loop_mutes m WHERE m.user_id=n.user_id AND m.target_id=n.actor_id)`;
    if(method==='GET'&&path==='/api/loop/notifications'){
      const before = Math.max(0,Number(url.searchParams.get('before')) || 0);
      const unreadOnly = url.searchParams.get('unread') === '1';
      const rows=database.prepare(`SELECT n.*,u.username,u.avatar_url,u.is_verified,c.body preview FROM loop_notifications n LEFT JOIN users u ON u.id=n.actor_id LEFT JOIN loop_post_comments c ON c.id=n.comment_id WHERE ${visibleNotifications} AND (?=0 OR n.id<?) ${unreadOnly ? 'AND n.read_at IS NULL' : ''} ORDER BY n.id DESC LIMIT 31`).all(user.id,before,before);
      const page = rows.slice(0,30);
      const unreadCount = Number(database.prepare(`SELECT COUNT(*) count FROM loop_notifications n WHERE ${visibleNotifications} AND n.read_at IS NULL`).get(user.id).count);
      return sendJson(response,200,{unreadCount,notifications:page.map(r=>({id:Number(r.id),type:r.type,body:r.body,preview:r.preview?.slice(0,180) || '',postId:r.post_id?Number(r.post_id):null,commentId:r.comment_id?Number(r.comment_id):null,read:Boolean(r.read_at),createdAt:r.created_at,actor:r.actor_id?{id:Number(r.actor_id),username:r.username,verified:Boolean(r.is_verified),avatarUrl:r.avatar_url||null}:null})),page:{hasMore:rows.length>30,nextBefore:rows.length>30 ? Number(page.at(-1).id) : null}}),true;
    }
    if(method==='POST'&&path==='/api/loop/notifications/read'){
      const body = await readJson(request);
      if (body.ids !== undefined) {
        if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length>100 || body.ids.some(id=>!Number.isSafeInteger(id)||id<=0)) return sendJson(response,400,{error:'Choose valid notifications.'}),true;
        database.prepare(`UPDATE loop_notifications SET read_at=COALESCE(read_at,?) WHERE user_id=? AND id IN (${body.ids.map(()=>'?').join(',')})`).run(now,user.id,...body.ids);
      } else database.prepare('UPDATE loop_notifications SET read_at=COALESCE(read_at,?) WHERE user_id=?').run(now,user.id);
      realtimeHub.send(user.id,'loop-notifications-read',{});
      return sendJson(response,200,{ok:true}),true;
    }
    if(path==='/api/loop/notification-preferences' && method==='GET') return sendJson(response,200,{preferences:preferences(user.id)}),true;
    if(path==='/api/loop/notification-preferences' && method==='PATCH') {
      const body = await readJson(request);
      if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!Object.hasOwn(notificationDefaults,key)||typeof body[key]!=='boolean')) return sendJson(response,400,{error:'Notification preferences must be on or off.'}),true;
      const settings = {...preferences(user.id),...body};
      database.prepare('INSERT INTO loop_notification_preferences(user_id,settings_json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json').run(user.id,JSON.stringify(settings));
      return sendJson(response,200,{preferences:settings}),true;
    }
    const threadMatch = path.match(/^\/api\/loop\/comments\/(\d+)\/thread$/);
    if (method==='GET' && threadMatch) {
      const comment = database.prepare('SELECT * FROM loop_post_comments WHERE id=?').get(Number(threadMatch[1]));
      if (!comment || !loadPost(Number(comment.post_id),user.id) || blocked(user.id,comment.user_id)) return sendJson(response,404,{error:'Comment unavailable.'}),true;
      const ancestors = []; let current = comment;
      while (current?.parent_id && ancestors.length<100) { ancestors.unshift(Number(current.parent_id)); current=database.prepare('SELECT parent_id FROM loop_post_comments WHERE id=? AND post_id=?').get(current.parent_id,comment.post_id); }
      return sendJson(response,200,{postId:Number(comment.post_id),ancestors,commentId:Number(comment.id)}),true;
    }

    const safetyMatch=path.match(/^\/api\/loop\/users\/(\d+)\/(block|mute)$/);
    if(method==='POST'&&safetyMatch){const target=Number(safetyMatch[1]);if(target===Number(user.id))return sendJson(response,400,{error:'You cannot do that to yourself.'}),true;const table=safetyMatch[2]==='block'?'loop_blocks':'loop_mutes';const found=database.prepare(`SELECT 1 FROM ${table} WHERE user_id=? AND target_id=?`).get(user.id,target);if(found)database.prepare(`DELETE FROM ${table} WHERE user_id=? AND target_id=?`).run(user.id,target);else database.prepare(`INSERT INTO ${table}(user_id,target_id,created_at) VALUES(?,?,?)`).run(user.id,target,now);presence.invalidate();return sendJson(response,200,{active:!found}),true;}
    if(method==='POST'&&path==='/api/loop/reports'){const body=await readJson(request);const reason=String(body.reason||'').trim().slice(0,500);const postId=Number(body.postId)||null;const targetId=Number(body.userId)||null;if(!reason||(!postId&&!targetId))return sendJson(response,400,{error:'Choose what to report and include a reason.'}),true;const id=Number(database.prepare('INSERT INTO loop_reports(reporter_id,target_user_id,post_id,reason,created_at) VALUES(?,?,?,?,?)').run(user.id,targetId,postId,reason,now).lastInsertRowid);return sendJson(response,201,{id}),true;}
    if(method==='GET'&&path==='/api/loop/moderation/reports'){if(!isAdmin(user))return sendJson(response,403,{error:'Moderator access required.'}),true;return sendJson(response,200,{reports:database.prepare('SELECT * FROM loop_reports ORDER BY id DESC LIMIT 100').all()}),true;}
    const reviewMatch = path.match(/^\/api\/loop\/moderation\/reports\/(\d+)$/);
    if (method === 'PATCH' && reviewMatch) {
      if (!isAdmin(user)) return sendJson(response, 403, { error: 'Moderator access required.' }), true;
      const reviewBody = await readJson(request);
      const status = ['open', 'resolved', 'dismissed'].includes(String(reviewBody.status)) ? String(reviewBody.status) : null;
      if (!status) return sendJson(response, 400, { error: 'Choose open, resolved, or dismissed.' }), true;
      database.prepare('UPDATE loop_reports SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(status, user.id, now, Number(reviewMatch[1]));
      return sendJson(response, 200, { ok: true }), true;
    }

    if(method==='GET'&&path==='/api/loop/conversations'){const rows=database.prepare(`SELECT c.id,other.id other_id,other.username,other.avatar_url,other.is_verified,(SELECT body FROM loop_messages WHERE conversation_id=c.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) preview FROM loop_conversations c JOIN loop_conversation_members me ON me.conversation_id=c.id AND me.user_id=? JOIN loop_conversation_members them ON them.conversation_id=c.id AND them.user_id!=? JOIN users other ON other.id=them.user_id ORDER BY COALESCE((SELECT id FROM loop_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1),c.id) DESC`).all(user.id,user.id);return sendJson(response,200,{conversations:rows.map((r)=>({id:Number(r.id),user:{id:Number(r.other_id),username:r.username,verified:Boolean(r.is_verified),avatarUrl:r.avatar_url||null},preview:r.preview||''}))}),true;}
    if(method==='POST'&&path==='/api/loop/conversations'){const body=await readJson(request);const target=Number(body.userId);if(!target||target===Number(user.id))return sendJson(response,400,{error:'Choose another user.'}),true;const blocked=database.prepare('SELECT 1 FROM loop_blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)').get(user.id,target,target,user.id);if(blocked)return sendJson(response,403,{error:'Messaging is unavailable for this user.'}),true;let row=database.prepare(`SELECT c.id FROM loop_conversations c JOIN loop_conversation_members a ON a.conversation_id=c.id AND a.user_id=? JOIN loop_conversation_members b ON b.conversation_id=c.id AND b.user_id=? WHERE (SELECT COUNT(*) FROM loop_conversation_members WHERE conversation_id=c.id)=2`).get(user.id,target);if(!row){database.exec('BEGIN IMMEDIATE');try{const id=Number(database.prepare('INSERT INTO loop_conversations(created_by,created_at) VALUES(?,?)').run(user.id,now).lastInsertRowid);const ins=database.prepare('INSERT INTO loop_conversation_members(conversation_id,user_id,joined_at) VALUES(?,?,?)');ins.run(id,user.id,now);ins.run(id,target,now);database.exec('COMMIT');row={id};}catch(error){database.exec('ROLLBACK');throw error;}}return sendJson(response,201,{id:Number(row.id)}),true;}
    const messagesMatch=path.match(/^\/api\/loop\/conversations\/(\d+)\/messages$/);
    if(messagesMatch){const id=Number(messagesMatch[1]);const member=database.prepare('SELECT 1 FROM loop_conversation_members WHERE conversation_id=? AND user_id=?').get(id,user.id);if(!member)return sendJson(response,403,{error:'Conversation unavailable.'}),true;if(method==='GET'){const before=Number(url.searchParams.get('before'))||0;const rows=database.prepare(`SELECT m.*,u.username,u.avatar_url FROM loop_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? AND (?=0 OR m.id<?) ORDER BY m.id DESC LIMIT 51`).all(id,before,before);const hasMore=rows.length>50;const page=rows.slice(0,50).reverse();return sendJson(response,200,{messages:page.map((r)=>({id:Number(r.id),content:r.deleted_at?'':r.body,deleted:Boolean(r.deleted_at),createdAt:r.created_at,own:Number(r.sender_id)===Number(user.id),sender:{id:Number(r.sender_id),username:r.username,avatarUrl:r.avatar_url||null}})),page:{hasMore,nextBefore:hasMore?Number(page[0]?.id||0):null}}),true;}if(method==='POST'){const body=await readJson(request);const content=String(body.content||'').trim();if(!content||content.length>4000)return sendJson(response,400,{error:'Messages must be 1 to 4,000 characters.'}),true;const id2=Number(database.prepare('INSERT INTO loop_messages(conversation_id,sender_id,body,created_at) VALUES(?,?,?,?)').run(id,user.id,content,now).lastInsertRowid);const members=database.prepare('SELECT user_id FROM loop_conversation_members WHERE conversation_id=?').all(id).map((r)=>Number(r.user_id));realtimeHub.broadcast(members,'loop-message-created',{conversationId:id,messageId:id2});return sendJson(response,201,{id:id2}),true;}}
    return false;
  }

  return { route, presence, close: videos.close };
}
