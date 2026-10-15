import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const db = new DatabaseSync(':memory:');
db.exec(`
 CREATE TABLE server_channels(id INTEGER PRIMARY KEY,server_id INTEGER,voice INTEGER);
 CREATE TABLE channel_reads(channel_id INTEGER,user_id INTEGER,last_read_message_id INTEGER);
 CREATE TABLE channel_messages(id INTEGER PRIMARY KEY,channel_id INTEGER,user_id INTEGER,deleted_at TEXT);
 CREATE TABLE channel_message_mentions(message_id INTEGER,user_id INTEGER,PRIMARY KEY(message_id,user_id));
 CREATE INDEX channel_message_mentions_user_index ON channel_message_mentions(user_id,message_id);
 CREATE INDEX channel_messages_live_count_index ON channel_messages(channel_id,id) WHERE deleted_at IS NULL;
 CREATE INDEX channel_messages_live_author_index ON channel_messages(channel_id,user_id,id) WHERE deleted_at IS NULL;
 INSERT INTO server_channels VALUES(1,1,0),(2,1,0),(3,1,1);
`);
const statement = name => db.prepare(source.match(new RegExp(`const ${name} = database.prepare\\('([^']+)'\\);`))[1]);
const original = db.prepare(source.match(/const listChannelUnreadsForServer = database.prepare\(`([\s\S]*?)`\);/)[1]);
const positions = statement('listUnreadReadPositions'), total = statement('countLiveAfter'), own = statement('countOwnLiveAfter'), mentions = statement('countMentionLiveAfter');
const insert = db.prepare('INSERT INTO channel_messages VALUES(?,?,?,?)');
for (let id = 1; id <= 200; id++) {
 insert.run(id, id % 2 + 1, id % 4 + 1, id % 7 === 0 ? 'deleted' : null);
 if (id % 3 === 0) db.prepare('INSERT INTO channel_message_mentions VALUES(?,?)').run(id, id % 5 + 1);
}
const cache = new Map();
for (let user = 1; user <= 25; user++) {
 for (const channel of [1,2]) db.prepare('INSERT INTO channel_reads VALUES(?,?,?)').run(channel,user,user % 5 * 40);
 const expected = original.all(user,user,user,user,1);
 const actual = positions.all(user,1).map(row => {
  const key = `${row.id}:${row.last_read}`;
  if (!cache.has(key)) cache.set(key,Number(total.get(row.id,row.last_read).n));
  return { channel_id:row.id,unread_count:cache.get(key)-Number(own.get(row.id,user,row.last_read).n),mention_count:Number(mentions.get(user,row.id,row.last_read,user).n) };
 });
 assert.deepEqual(actual,expected.map(row=>({...row})));
}
const sql = source.match(/const countMentionLiveAfter = database.prepare\('([^']+)'\);/)[1];
const plan = db.prepare('EXPLAIN QUERY PLAN '+sql).all(1,1,0,1);
assert.match(plan[0].detail,/channel_message_mentions_user_index/);
assert.ok(cache.size < 25 * 2);
db.close();
console.log('PASS unread counts match prior semantics across own messages, mentions, deletions, read positions and voice exclusion; sparse mention index starts the query; equivalent count cohorts are reused.');
