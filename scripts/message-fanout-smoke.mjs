import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createMessageFanoutQueue } from '../server/messageFanout.mjs';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE unread(user_id INTEGER PRIMARY KEY,n INTEGER);');
const insert = db.prepare('INSERT INTO unread VALUES(?,?)');
for (let id = 1; id <= 1000; id++) insert.run(id, id % 9);
const lookup = db.prepare('SELECT n FROM unread WHERE user_id=?');
let baselineLookups = 0, optimizedLookups = 0, delivered = 0;
const started = performance.now();
for (let message = 0; message < 100; message++) for (let user = 1; user <= 1000; user++) { lookup.get(user); baselineLookups++; }
const baselineMs = performance.now() - started;
const ids = [], queue = createMessageFanoutQueue((serverId, items) => {
  assert.equal(serverId, 1);
  for (let user = 1; user <= 1000; user++) {
    lookup.get(user); optimizedLookups++;
    for (const item of items) { delivered++; if (user === 1) ids.push(item.payload.message.id); }
  }
});
const next = performance.now();
for (let id = 1; id <= 100; id++) queue.enqueue(1, { prepared: { prefix: Buffer.alloc(100) }, payload: { message: { id } }, senderId: 1 });
queue.flush();
const optimizedMs = performance.now() - next;
assert.equal(baselineLookups, 100000); assert.equal(optimizedLookups, 1000); assert.equal(delivered, 100000);
assert.deepEqual(ids, Array.from({ length: 100 }, (_, i) => i + 1));
let groups = [];
const bounded = createMessageFanoutQueue((serverId, items) => groups.push({ serverId, ids: items.map(item => item.id) }), { maxMessages: 2, maxBytes: 20 });
for (let id = 1; id <= 5; id++) bounded.enqueue(id === 5 ? 2 : 1, { id, prepared: { prefix: Buffer.alloc(8) } });
bounded.flush(); assert.deepEqual(groups, [{ serverId: 1, ids: [1, 2] }, { serverId: 1, ids: [3, 4] }, { serverId: 2, ids: [5] }]);
let asynchronous = 0;
const scheduled = createMessageFanoutQueue(() => asynchronous++);
scheduled.enqueue(1, { prepared: { prefix: Buffer.alloc(1) } });
await new Promise(resolve => setImmediate(resolve)); assert.equal(asynchronous, 1);
let errors = 0;
const failed = createMessageFanoutQueue(() => { throw Error('fixture failure'); }, { onError: () => errors++ });
failed.enqueue(1, { prepared: { prefix: Buffer.alloc(1) } });
await new Promise(resolve => setImmediate(resolve)); assert.equal(errors, 1);
db.close();
console.log(`PASS fanout: 100 messages × 1,000 recipients, all ordered deliveries; unread SQLite lookups ${baselineLookups} -> ${optimizedLookups}. Local synthetic work ${baselineMs.toFixed(2)} ms -> ${optimizedMs.toFixed(2)} ms, not internet latency. Bounded queue and next-turn delivery verified.`);
