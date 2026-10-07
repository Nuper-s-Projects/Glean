import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm']);

function safeJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function cleanTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set(source.map((tag) => String(tag).trim().replace(/^#/, '').toLowerCase()).filter((tag) => /^[a-z0-9_]{1,32}$/.test(tag)))].slice(0, 10);
}

export function createLoopService({ database, uploadDirectory, parseMultipart, sendLocalFile, sendJson, readJson, currentUser, realtimeHub, isAdmin, nameFile }) {
  for (const sql of [
    'ALTER TABLE loop_posts ADD COLUMN edited_at TEXT',
    'ALTER TABLE loop_posts ADD COLUMN deleted_at TEXT',
    'ALTER TABLE loop_posts ADD COLUMN original_post_id INTEGER REFERENCES loop_posts(id) ON DELETE SET NULL',
    "ALTER TABLE loop_posts ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE users ADD COLUMN loop_background_json TEXT NOT NULL DEFAULT '{}'",
  ]) { try { database.exec(sql); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; } }

  database.exec(`
    CREATE TABLE IF NOT EXISTS loop_post_media (
      id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES loop_posts(id) ON DELETE CASCADE,
      storage_name TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL, mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS loop_post_media_post_idx ON loop_post_media(post_id, position, id);
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

  const postSelect = (where = '1=1') => `
    SELECT p.*, u.username, u.avatar_url, u.bio,
      (SELECT COUNT(*) FROM loop_post_likes l WHERE l.post_id=p.id) likes,
      (SELECT COUNT(*) FROM loop_post_comments c WHERE c.post_id=p.id) comments,
      (SELECT COUNT(*) FROM loop_posts r WHERE r.original_post_id=p.id AND r.deleted_at IS NULL) reposts,
      EXISTS(SELECT 1 FROM loop_post_likes l WHERE l.post_id=p.id AND l.user_id=?) liked,
      EXISTS(SELECT 1 FROM loop_bookmarks b WHERE b.post_id=p.id AND b.user_id=?) bookmarked
    FROM loop_posts p JOIN users u ON u.id=p.user_id
    WHERE p.deleted_at IS NULL AND ${where}
      AND NOT EXISTS(SELECT 1 FROM loop_blocks b WHERE (b.user_id=? AND b.target_id=p.user_id) OR (b.user_id=p.user_id AND b.target_id=?))
      AND NOT EXISTS(SELECT 1 FROM loop_mutes m WHERE m.user_id=? AND m.target_id=p.user_id)`;

  function mediaFor(ids) {
    if (!ids.length) return new Map();
    const rows = database.prepare(`SELECT * FROM loop_post_media WHERE post_id IN (${ids.map(() => '?').join(',')}) ORDER BY position,id`).all(...ids);
    const map = new Map();
    for (const row of rows) {
      const list = map.get(Number(row.post_id)) || [];
      list.push({ id: Number(row.id), name: row.original_name, mimeType: row.mime_type, size: Number(row.size_bytes), url: `/api/v1/loop/media/${row.id}` });
      map.set(Number(row.post_id), list);
    }
    return map;
  }

  function publicPosts(rows, viewerId) {
    const map = mediaFor(rows.map((row) => Number(row.id)));
    return rows.map((row) => ({
      id: Number(row.id), author: { id: Number(row.user_id), username: row.username || 'Unknown', avatarUrl: row.avatar_url || null },
      content: row.body, createdAt: row.created_at, editedAt: row.edited_at || null,
      tags: cleanTags(safeJson(row.tags_json, [])), media: map.get(Number(row.id)) || [],
      originalPostId: row.original_post_id ? Number(row.original_post_id) : null,
      likes: Number(row.likes || 0), comments: Number(row.comments || 0), reposts: Number(row.reposts || 0),
      liked: Boolean(row.liked), bookmarked: Boolean(row.bookmarked), own: Number(row.user_id) === Number(viewerId),
    }));
  }

  function loadPost(postId, viewerId) {
    const row = database.prepare(`${postSelect('p.id=?')} LIMIT 1`).get(viewerId, viewerId, postId, viewerId, viewerId, viewerId);
    return row ? publicPosts([row], viewerId)[0] : null;
  }

  function notify(userId, actorId, type, postId, body, now) {
    if (!userId || Number(userId) === Number(actorId)) return;
    const result = database.prepare('INSERT INTO loop_notifications(user_id,actor_id,type,post_id,body,created_at) VALUES(?,?,?,?,?,?)').run(userId, actorId, type, postId || null, body || '', now);
    realtimeHub.send(userId, 'loop-notification', { id: Number(result.lastInsertRowid), type, postId: postId || null });
  }

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

    if (method === 'GET' && path === '/api/loop/posts') {
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 12));
      const before = Math.max(0, Number(url.searchParams.get('before')) || 0);
      const author = Math.max(0, Number(url.searchParams.get('author')) || 0);
      const query = String(url.searchParams.get('q') || '').trim().slice(0, 80);
      const tag = String(url.searchParams.get('tag') || '').replace(/^#/, '').toLowerCase();
      const bookmarked = url.searchParams.get('bookmarked') === '1';
      const clauses = ['(?=0 OR p.id<?)', '(?=0 OR p.user_id=?)', "(?='' OR lower(p.body) LIKE '%'||lower(?)||'%' OR lower(u.username) LIKE '%'||lower(?)||'%')", "(?='' OR EXISTS(SELECT 1 FROM json_each(p.tags_json) WHERE value=?))", '(?=0 OR EXISTS(SELECT 1 FROM loop_bookmarks x WHERE x.post_id=p.id AND x.user_id=?))'];
      const sql = `${postSelect(clauses.join(' AND '))} ORDER BY p.id DESC LIMIT ?`;
      const rows = database.prepare(sql).all(user.id, user.id, before, before, author, author, query, query, query, tag, tag, bookmarked ? 1 : 0, user.id, user.id, user.id, user.id, limit + 1);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return sendJson(response, 200, { posts: publicPosts(page, user.id), page: { hasMore, nextBefore: hasMore ? Number(page.at(-1)?.id || 0) : null } }), true;
    }

    if (method === 'POST' && path === '/api/loop/posts') {
      let content = '', tags = [], originalPostId = null, files = [];
      if (String(request.headers['content-type'] || '').startsWith('multipart/form-data')) {
        const parsed = await parseMultipart(request, { directory: uploadDirectory, nameFile });
        files = parsed.files; content = String(parsed.fields.content || '').trim(); tags = cleanTags(parsed.fields.tags); originalPostId = Number(parsed.fields.originalPostId) || null;
      } else {
        const body = await readJson(request); content = String(body.content || '').trim(); tags = cleanTags(body.tags); originalPostId = Number(body.originalPostId) || null;
      }
      const valid = files.every((file) => IMAGE_TYPES.has(file.type) || VIDEO_TYPES.has(file.type) || AUDIO_TYPES.has(file.type));
      const imageOnly = files.every((file) => IMAGE_TYPES.has(file.type));
      if (!valid || (files.length > 1 && !imageOnly)) { for (const file of files) try { unlinkSync(join(uploadDirectory,file.storageName)); } catch {} return sendJson(response,400,{error:'Add up to 10 images, or one GIF, video, or audio file.'}), true; }
      if (!content && !files.length && !originalPostId) return sendJson(response,400,{error:'Write something or add media before posting.'}), true;
      if (content.length > 2000) return sendJson(response,400,{error:'Loop posts can be up to 2,000 characters.'}), true;
      if (originalPostId && !database.prepare('SELECT 1 FROM loop_posts WHERE id=? AND deleted_at IS NULL').get(originalPostId)) return sendJson(response,404,{error:'That post no longer exists.'}), true;
      let postId;
      database.exec('BEGIN IMMEDIATE');
      try {
        const type = files[0] ? (IMAGE_TYPES.has(files[0].type) ? (files[0].type === 'image/gif' ? 'gif' : 'photo') : VIDEO_TYPES.has(files[0].type) ? 'video' : 'none') : 'none';
        postId = Number(database.prepare('INSERT INTO loop_posts(user_id,body,media_type,client_id,created_at,original_post_id,tags_json) VALUES(?,?,?,?,?,?,?)').run(user.id,content,type,null,now,originalPostId,JSON.stringify(tags)).lastInsertRowid);
        const insert = database.prepare('INSERT INTO loop_post_media(post_id,storage_name,original_name,mime_type,size_bytes,position) VALUES(?,?,?,?,?,?)');
        files.forEach((file,index) => insert.run(postId,file.storageName,String(file.name).slice(0,240),file.type,file.size,index));
        database.exec('COMMIT');
      } catch (error) { try { database.exec('ROLLBACK'); } catch {} for (const file of files) try { unlinkSync(join(uploadDirectory,file.storageName)); } catch {} throw error; }
      if (originalPostId) { const owner = database.prepare('SELECT user_id FROM loop_posts WHERE id=?').get(originalPostId); notify(owner?.user_id,user.id,'repost',originalPostId,'reposted your post',now); }
      const post = loadPost(postId,user.id); realtimeHub.broadcastAll('loop-post-created',{ postId });
      return sendJson(response,201,{post}), true;
    }

    const mediaMatch = path.match(/^\/api\/loop\/media\/(\d+)$/);
    if (method === 'GET' && mediaMatch) {
      const row = database.prepare('SELECT * FROM loop_post_media WHERE id=?').get(Number(mediaMatch[1]));
      if (!row) return sendJson(response,404,{error:'Media not found.'}), true;
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
      if (method === 'DELETE') { database.prepare('UPDATE loop_posts SET deleted_at=? WHERE id=?').run(now,postId); realtimeHub.broadcastAll('loop-post-deleted',{postId}); return sendJson(response,200,{ok:true}), true; }
      const body = await readJson(request); const content = String(body.content ?? row.body).trim(); const tags = cleanTags(body.tags ?? safeJson(row.tags_json,[]));
      if (!content && !mediaFor([postId]).get(postId)?.length && !row.original_post_id) return sendJson(response,400,{error:'A post cannot be empty.'}), true;
      database.prepare('UPDATE loop_posts SET body=?,tags_json=?,edited_at=? WHERE id=?').run(content.slice(0,2000),JSON.stringify(tags),now,postId);
      realtimeHub.broadcastAll('loop-post-updated',{postId}); return sendJson(response,200,{post:loadPost(postId,user.id)}), true;
    }

    const toggleMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/(like|bookmark)$/);
    if (method === 'POST' && toggleMatch) {
      const postId=Number(toggleMatch[1]); const post=database.prepare('SELECT user_id FROM loop_posts WHERE id=? AND deleted_at IS NULL').get(postId);
      if (!post) return sendJson(response,404,{error:'Post not found.'}), true;
      const table=toggleMatch[2]==='like'?'loop_post_likes':'loop_bookmarks'; const found=database.prepare(`SELECT 1 FROM ${table} WHERE post_id=? AND user_id=?`).get(postId,user.id);
      if(found) database.prepare(`DELETE FROM ${table} WHERE post_id=? AND user_id=?`).run(postId,user.id); else database.prepare(`INSERT INTO ${table}(post_id,user_id,created_at) VALUES(?,?,?)`).run(postId,user.id,now);
      if(!found&&toggleMatch[2]==='like') notify(post.user_id,user.id,'like',postId,'liked your post',now);
      realtimeHub.broadcastAll('loop-post-updated',{postId}); return sendJson(response,200,{active:!found,post:loadPost(postId,user.id)}), true;
    }

    const repostMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/repost$/);
    if (method === 'POST' && repostMatch) {
      const originalPostId = Number(repostMatch[1]);
      const original = database.prepare('SELECT id FROM loop_posts WHERE id=? AND deleted_at IS NULL').get(originalPostId);
      if (!original) return sendJson(response, 404, { error: 'Post not found.' }), true;
      const duplicate = database.prepare('SELECT id FROM loop_posts WHERE user_id=? AND original_post_id=? AND deleted_at IS NULL').get(user.id, originalPostId);
      if (duplicate) return sendJson(response, 200, { post: loadPost(Number(duplicate.id), user.id) }), true;
      const id = Number(database.prepare('INSERT INTO loop_posts(user_id,body,media_type,created_at,original_post_id,tags_json) VALUES(?,?,?,?,?,?)').run(user.id, '', 'none', now, originalPostId, '[]').lastInsertRowid);
      notify(database.prepare('SELECT user_id FROM loop_posts WHERE id=?').get(originalPostId)?.user_id, user.id, 'repost', originalPostId, 'reposted your post', now);
      realtimeHub.broadcastAll('loop-post-created', { postId: id });
      return sendJson(response, 201, { post: loadPost(id, user.id) }), true;
    }

    const commentsMatch = path.match(/^\/api\/loop\/posts\/(\d+)\/comments$/);
    if (commentsMatch && method === 'GET') {
      const rows=database.prepare(`SELECT c.id,c.body,c.created_at,c.user_id,u.username,u.avatar_url FROM loop_post_comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id`).all(Number(commentsMatch[1]));
      return sendJson(response,200,{comments:rows.map((r)=>({id:Number(r.id),content:r.body,createdAt:r.created_at,own:Number(r.user_id)===Number(user.id),author:{id:Number(r.user_id),username:r.username,avatarUrl:r.avatar_url||null}}))}), true;
    }
    if (commentsMatch && method === 'POST') {
      const postId=Number(commentsMatch[1]); const post=database.prepare('SELECT user_id FROM loop_posts WHERE id=? AND deleted_at IS NULL').get(postId); if(!post) return sendJson(response,404,{error:'Post not found.'}), true;
      const body=await readJson(request); const content=String(body.content||'').trim(); if(!content||content.length>1000) return sendJson(response,400,{error:'Comments must be 1 to 1,000 characters.'}), true;
      const id=Number(database.prepare('INSERT INTO loop_post_comments(post_id,user_id,body,created_at) VALUES(?,?,?,?)').run(postId,user.id,content,now).lastInsertRowid);
      notify(post.user_id,user.id,'comment',postId,'commented on your post',now); realtimeHub.broadcastAll('loop-comment-created',{postId,commentId:id}); return sendJson(response,201,{id}), true;
    }
    const commentDelete=path.match(/^\/api\/loop\/comments\/(\d+)$/);
    if(commentDelete&&method==='DELETE'){const row=database.prepare('SELECT * FROM loop_post_comments WHERE id=?').get(Number(commentDelete[1]));if(!row)return sendJson(response,404,{error:'Comment not found.'}),true;if(Number(row.user_id)!==Number(user.id)&&!isAdmin(user))return sendJson(response,403,{error:'You cannot delete this comment.'}),true;database.prepare('DELETE FROM loop_post_comments WHERE id=?').run(row.id);realtimeHub.broadcastAll('loop-comment-deleted',{postId:Number(row.post_id),commentId:Number(row.id)});return sendJson(response,200,{ok:true}),true;}

    if(method==='GET'&&path==='/api/loop/trending'){const tags=database.prepare(`SELECT value tag,COUNT(*) count FROM loop_posts,json_each(loop_posts.tags_json) WHERE deleted_at IS NULL GROUP BY value ORDER BY count DESC,value LIMIT 12`).all();return sendJson(response,200,{tags:tags.map((x)=>({tag:x.tag,count:Number(x.count)}))}),true;}
    if(method==='GET'&&path==='/api/loop/users'){const q=String(url.searchParams.get('q')||'').trim();const rows=database.prepare(`SELECT id,username,avatar_url,bio FROM users WHERE username IS NOT NULL AND id!=? AND (?='' OR lower(username) LIKE '%'||lower(?)||'%') AND NOT EXISTS(SELECT 1 FROM loop_blocks WHERE (user_id=? AND target_id=users.id) OR (user_id=users.id AND target_id=?)) ORDER BY username LIMIT 30`).all(user.id,q,q,user.id,user.id);return sendJson(response,200,{users:rows.map((r)=>({id:Number(r.id),username:r.username,avatarUrl:r.avatar_url||null,bio:r.bio||''}))}),true;}

    const profileMatch=path.match(/^\/api\/loop\/profiles\/(\d+)$/);
    if(method==='GET'&&profileMatch){const id=Number(profileMatch[1]);const row=database.prepare(`SELECT id,username,avatar_url,bio,loop_background_json,created_at,(SELECT COUNT(*) FROM loop_follows WHERE followed_id=users.id) followers,(SELECT COUNT(*) FROM loop_follows WHERE follower_id=users.id) following,EXISTS(SELECT 1 FROM loop_follows WHERE follower_id=? AND followed_id=users.id) followed FROM users WHERE id=?`).get(user.id,id);if(!row)return sendJson(response,404,{error:'User not found.'}),true;return sendJson(response,200,{profile:{id,username:row.username,avatarUrl:row.avatar_url||null,bio:row.bio||'',background:safeJson(row.loop_background_json,{}),followers:Number(row.followers),following:Number(row.following),followed:Boolean(row.followed),own:id===Number(user.id)}}),true;}
    if(method==='PATCH'&&path==='/api/loop/profile'){const body=await readJson(request);const background={color:/^#[0-9a-f]{6}$/i.test(body.background?.color||'')?body.background.color:'#0c2439',imageUrl:String(body.background?.imageUrl||'').slice(0,500)};database.prepare('UPDATE users SET loop_background_json=? WHERE id=?').run(JSON.stringify(background),user.id);return sendJson(response,200,{background}),true;}
    const followMatch=path.match(/^\/api\/loop\/users\/(\d+)\/follow$/);
    if(method==='POST'&&followMatch){const target=Number(followMatch[1]);if(target===Number(user.id))return sendJson(response,400,{error:'You cannot follow yourself.'}),true;const found=database.prepare('SELECT 1 FROM loop_follows WHERE follower_id=? AND followed_id=?').get(user.id,target);if(found)database.prepare('DELETE FROM loop_follows WHERE follower_id=? AND followed_id=?').run(user.id,target);else database.prepare('INSERT INTO loop_follows(follower_id,followed_id,created_at) VALUES(?,?,?)').run(user.id,target,now);if(!found)notify(target,user.id,'follow',null,'followed you',now);return sendJson(response,200,{followed:!found}),true;}

    if(method==='GET'&&path==='/api/loop/notifications'){const rows=database.prepare(`SELECT n.*,u.username,u.avatar_url FROM loop_notifications n LEFT JOIN users u ON u.id=n.actor_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 80`).all(user.id);return sendJson(response,200,{notifications:rows.map((r)=>({id:Number(r.id),type:r.type,body:r.body,postId:r.post_id?Number(r.post_id):null,read:Boolean(r.read_at),createdAt:r.created_at,actor:r.actor_id?{id:Number(r.actor_id),username:r.username,avatarUrl:r.avatar_url||null}:null}))}),true;}
    if(method==='POST'&&path==='/api/loop/notifications/read'){database.prepare('UPDATE loop_notifications SET read_at=COALESCE(read_at,?) WHERE user_id=?').run(now,user.id);return sendJson(response,200,{ok:true}),true;}

    const safetyMatch=path.match(/^\/api\/loop\/users\/(\d+)\/(block|mute)$/);
    if(method==='POST'&&safetyMatch){const target=Number(safetyMatch[1]);if(target===Number(user.id))return sendJson(response,400,{error:'You cannot do that to yourself.'}),true;const table=safetyMatch[2]==='block'?'loop_blocks':'loop_mutes';const found=database.prepare(`SELECT 1 FROM ${table} WHERE user_id=? AND target_id=?`).get(user.id,target);if(found)database.prepare(`DELETE FROM ${table} WHERE user_id=? AND target_id=?`).run(user.id,target);else database.prepare(`INSERT INTO ${table}(user_id,target_id,created_at) VALUES(?,?,?)`).run(user.id,target,now);return sendJson(response,200,{active:!found}),true;}
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

    if(method==='GET'&&path==='/api/loop/conversations'){const rows=database.prepare(`SELECT c.id,other.id other_id,other.username,other.avatar_url,(SELECT body FROM loop_messages WHERE conversation_id=c.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) preview FROM loop_conversations c JOIN loop_conversation_members me ON me.conversation_id=c.id AND me.user_id=? JOIN loop_conversation_members them ON them.conversation_id=c.id AND them.user_id!=? JOIN users other ON other.id=them.user_id ORDER BY COALESCE((SELECT id FROM loop_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1),c.id) DESC`).all(user.id,user.id);return sendJson(response,200,{conversations:rows.map((r)=>({id:Number(r.id),user:{id:Number(r.other_id),username:r.username,avatarUrl:r.avatar_url||null},preview:r.preview||''}))}),true;}
    if(method==='POST'&&path==='/api/loop/conversations'){const body=await readJson(request);const target=Number(body.userId);if(!target||target===Number(user.id))return sendJson(response,400,{error:'Choose another user.'}),true;const blocked=database.prepare('SELECT 1 FROM loop_blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)').get(user.id,target,target,user.id);if(blocked)return sendJson(response,403,{error:'Messaging is unavailable for this user.'}),true;let row=database.prepare(`SELECT c.id FROM loop_conversations c JOIN loop_conversation_members a ON a.conversation_id=c.id AND a.user_id=? JOIN loop_conversation_members b ON b.conversation_id=c.id AND b.user_id=? WHERE (SELECT COUNT(*) FROM loop_conversation_members WHERE conversation_id=c.id)=2`).get(user.id,target);if(!row){database.exec('BEGIN IMMEDIATE');try{const id=Number(database.prepare('INSERT INTO loop_conversations(created_by,created_at) VALUES(?,?)').run(user.id,now).lastInsertRowid);const ins=database.prepare('INSERT INTO loop_conversation_members(conversation_id,user_id,joined_at) VALUES(?,?,?)');ins.run(id,user.id,now);ins.run(id,target,now);database.exec('COMMIT');row={id};}catch(error){database.exec('ROLLBACK');throw error;}}return sendJson(response,201,{id:Number(row.id)}),true;}
    const messagesMatch=path.match(/^\/api\/loop\/conversations\/(\d+)\/messages$/);
    if(messagesMatch){const id=Number(messagesMatch[1]);const member=database.prepare('SELECT 1 FROM loop_conversation_members WHERE conversation_id=? AND user_id=?').get(id,user.id);if(!member)return sendJson(response,403,{error:'Conversation unavailable.'}),true;if(method==='GET'){const before=Number(url.searchParams.get('before'))||0;const rows=database.prepare(`SELECT m.*,u.username,u.avatar_url FROM loop_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? AND (?=0 OR m.id<?) ORDER BY m.id DESC LIMIT 51`).all(id,before,before);const hasMore=rows.length>50;const page=rows.slice(0,50).reverse();return sendJson(response,200,{messages:page.map((r)=>({id:Number(r.id),content:r.deleted_at?'':r.body,deleted:Boolean(r.deleted_at),createdAt:r.created_at,own:Number(r.sender_id)===Number(user.id),sender:{id:Number(r.sender_id),username:r.username,avatarUrl:r.avatar_url||null}})),page:{hasMore,nextBefore:hasMore?Number(page[0]?.id||0):null}}),true;}if(method==='POST'){const body=await readJson(request);const content=String(body.content||'').trim();if(!content||content.length>4000)return sendJson(response,400,{error:'Messages must be 1 to 4,000 characters.'}),true;const id2=Number(database.prepare('INSERT INTO loop_messages(conversation_id,sender_id,body,created_at) VALUES(?,?,?,?)').run(id,user.id,content,now).lastInsertRowid);const members=database.prepare('SELECT user_id FROM loop_conversation_members WHERE conversation_id=?').all(id).map((r)=>Number(r.user_id));realtimeHub.broadcast(members,'loop-message-created',{conversationId:id,messageId:id2});return sendJson(response,201,{id:id2}),true;}}
    return false;
  }

  return { route };
}
