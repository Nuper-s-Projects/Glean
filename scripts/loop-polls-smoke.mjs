import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLoopService } from '../server/loop.mjs';

const database = new DatabaseSync(':memory:');
database.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar_url TEXT,bio TEXT);
  INSERT INTO users VALUES(1,'Alice',NULL,''),(2,'Bob',NULL,'');
  CREATE TABLE loop_posts(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT,media_type TEXT,client_id TEXT,created_at TEXT);
  CREATE TABLE loop_post_likes(post_id INTEGER,user_id INTEGER);
  CREATE TABLE loop_post_comments(id INTEGER,post_id INTEGER);
`);
const events = [];
const service = createLoopService({ database, uploadDirectory: '/tmp', parseMultipart: async request => ({ files: [], fields: request.fields }), nameFile: () => '', sendLocalFile: () => {}, sendJson: (response, status, body) => Object.assign(response, { status, body }), readJson: async request => request.body, currentUser: request => database.prepare('SELECT * FROM users WHERE id=?').get(request.userId), realtimeHub: { broadcastAll: (...event) => events.push(event), send: () => {} }, isAdmin: () => false });
async function request(path, method = 'GET', body = {}, userId = 1, fields = null) {
  const response = {};
  await service.route({ url: path, method, body, fields, userId, headers: { host: 'localhost', ...(fields ? { 'content-type': 'multipart/form-data' } : {}) } }, response, path.split('?')[0], new Date().toISOString());
  return response;
}
try {
  for (const userId of [1,2]) await request('/api/loop/connection','POST',{confirmed:true,consentVersion:1},userId);
  assert.equal((await request('/api/loop/posts', 'POST', {}, 999)).status, 401);
  for (const poll of [false, {}, {question:'Q',options:['a']}, {question:'Q',options:['a',' A ']}, {question:'Q',options:['a','']}, {question:'Q',options:Array.from({length:7},(_,i)=>String(i))}, {question:'x'.repeat(201),options:['a','b']}, {question:'Q',options:['a','b'.repeat(101)]}]) assert.equal((await request('/api/loop/posts','POST',{poll})).status, 400);
  assert.equal((await request('/api/loop/posts', 'POST', {}, 1, { poll: '{invalid' })).status, 400);
  const created = await request('/api/loop/posts', 'POST', { poll: { question: 'Best snack?', options: ['Chips','Fruit'] }, tags: ['snack'] });
  assert.equal(created.status, 201);
  const id = created.body.post.id;
  assert.equal(created.body.post.poll.voterCount, 0);
  const votePath = `/api/loop/posts/${id}/poll/vote`;
  for (const optionIndex of [-1, 2, 0.5, '0', null]) assert.equal((await request(votePath,'POST',{optionIndex})).status, 400);
  await request(votePath,'POST',{optionIndex:0});
  await request(votePath,'POST',{optionIndex:0});
  const changed = await request(votePath,'POST',{optionIndex:1});
  assert.equal(changed.body.post.poll.voterCount, 1);
  assert.equal(changed.body.post.poll.options[0].votes, 0);
  assert.equal(changed.body.post.poll.options[1].voted, true);
  const second = await request(votePath,'POST',{optionIndex:0},2);
  assert.equal(second.body.post.poll.voterCount, 2);
  assert.deepEqual(second.body.post.poll.options.map(option => option.voted), [true,false]);
  assert.equal((await request(`/api/loop/posts?type=poll&author=1&tag=snack`)).body.posts.length, 1);
  assert.equal((await request('/api/loop/posts?q=Best%20snack')).body.posts.length, 1);
  assert.equal((await request('/api/loop/posts?type=text')).body.posts.length, 0);
  assert.equal((await request(`/api/loop/posts/${id}`, 'PATCH', {content:''})).status, 200);
  database.prepare('INSERT INTO loop_blocks VALUES(?,?,?)').run(1,2,new Date().toISOString());
  assert.equal((await request(votePath,'POST',{optionIndex:1},2)).status, 404);
  assert.equal((await request('/api/loop/posts?type=poll', 'GET', {}, 2)).body.posts.length, 0);
  database.prepare('DELETE FROM loop_blocks').run();
  assert.equal((await request(`/api/loop/posts/${id}`, 'DELETE', {}, 2)).status, 403);
  await request(`/api/loop/posts/${id}`, 'DELETE');
  assert.equal((await request(votePath,'POST',{optionIndex:0})).status, 404);
  assert.equal((await request('/api/loop/posts?type=poll')).body.posts.length, 0);
  assert.ok(events.some(([event]) => event === 'loop-post-updated'));
  console.log('PASS: Loop polls validation, JSON/multipart, author/tag/type filters, per-account voting and changes, blocked users, deletion, realtime events.');
} finally { database.close(); }
