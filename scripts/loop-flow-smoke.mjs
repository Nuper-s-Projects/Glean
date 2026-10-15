import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createLoopService } from '../server/loop.mjs';
import { createLoopFlow } from '../server/loopFlow.mjs';

const database=new DatabaseSync(':memory:');
database.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar_url TEXT,bio TEXT,created_at TEXT);
 INSERT INTO users VALUES(1,'Alice',NULL,'','2026-10-10'),(2,'Bob',NULL,'','2026-10-10'),(3,'Cara',NULL,'','2026-10-10'),(4,'NotConnected',NULL,'','2026-10-10');
 CREATE TABLE loop_posts(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT,media_type TEXT,client_id TEXT,created_at TEXT);
 CREATE TABLE loop_post_likes(post_id INTEGER,user_id INTEGER,created_at TEXT,PRIMARY KEY(post_id,user_id));
 CREATE TABLE loop_post_comments(id INTEGER PRIMARY KEY,post_id INTEGER REFERENCES loop_posts(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,body TEXT,created_at TEXT);
 INSERT INTO loop_posts VALUES(1,1,'Legacy post','none',NULL,'2026-10-10');
`);
const options={database,uploadDirectory:'/tmp',parseMultipart:async()=>({files:[],fields:{}}),nameFile:()=>'',sendLocalFile:()=>{},sendJson:(response,status,body)=>Object.assign(response,{status,body}),readJson:async request=>request.body,currentUser:request=>database.prepare('SELECT * FROM users WHERE id=?').get(request.userId),realtimeHub:{broadcastAll:()=>{},send:()=>{}},isAdmin:()=>false};
let service=createLoopService(options);
async function req(path,method='GET',body={},userId=1){const response={};await service.route({url:path,method,body,userId,headers:{host:'localhost'}},response,path.split('?')[0],new Date().toISOString());return response;}
async function ok(...args){const result=await req(...args);assert.ok(result.status>=200&&result.status<300,JSON.stringify(result));return result.body;}
async function round(feed='everyone',size=7,avoid=0){
 const posts=[];let cursor=null,pages=0;
 do {
  const data=await ok(`/api/loop/flow?feed=${feed}&limit=${size}${cursor ? '&cursor='+cursor : avoid ? '&avoid='+avoid : ''}`);
  assert.ok(data.posts.length<=size);posts.push(...data.posts);cursor=data.page.nextCursor;
  assert.equal(Boolean(cursor),data.page.hasMore);assert.ok(++pages<1000,'round terminates');
 } while(cursor);
 assert.equal(new Set(posts.map(post=>post.id)).size,posts.length,'no repeat before round ends');
 return posts;
}
try {
 assert.equal((await req('/api/loop/flow','GET',{},999)).status,401);
 assert.equal((await req('/api/loop/flow','GET',{},4)).status,403);
 for(const id of [1,2,3]) await ok('/api/loop/connection','POST',{confirmed:true,consentVersion:1},id);
 assert.equal((await round()).length,1);
 const legacyRank=database.prepare('SELECT flow_rank FROM loop_posts WHERE id=1').get().flow_rank;
 service=createLoopService(options);
 assert.equal(database.prepare('SELECT flow_rank FROM loop_posts WHERE id=1').get().flow_rank,legacyRank,'migration idempotent');
 const insert=database.prepare("INSERT INTO loop_posts(user_id,body,media_type,created_at) VALUES(?,'Fixture','none','2026-10-10')");
 database.exec('BEGIN');for(let i=0;i<1000;i++)insert.run(i%2 ? 2 : 3);database.exec('COMMIT');
 assert.equal(database.prepare('SELECT COUNT(*) count FROM loop_posts WHERE flow_rank=0').get().count,0,'new posts automatically ranked');
 // Force rank collisions to prove ID tie-breaking across both halves of a round.
 database.exec('UPDATE loop_posts SET flow_rank=42 WHERE id<12');
 const started=performance.now();
 const all=await round('everyone',30);
 assert.equal(all.length,1001);
 console.log('1,001-post random round ms:',Math.round(performance.now()-started));
 assert.deepEqual((await ok('/api/loop/posts?limit=3')).posts.map(post=>post.id),[1001,1000,999],'Home unchanged');
 const starts=new Set();for(let i=0;i<24;i++)starts.add((await ok('/api/loop/flow?limit=1')).posts[0].id);
 assert.ok(starts.size>8,'fresh sessions choose varied first posts');
 const last=all.at(-1).id;
 assert.notEqual((await ok('/api/loop/flow?limit=1&avoid='+last)).posts[0].id,last,'new round avoids immediate repeat');
 assert.equal((await round('following')).length,0);
 await ok('/api/loop/users/2/follow','POST');
 assert.ok((await round('following',30)).every(post=>post.author.id===2));
 const page=await ok('/api/loop/flow?limit=3');
 assert.deepEqual((await ok('/api/loop/flow?cursor='+page.page.nextCursor+'&limit=3')).posts.map(post=>post.id),(await ok('/api/loop/flow?cursor='+page.page.nextCursor+'&limit=3')).posts.map(post=>post.id),'retries preserve cursor order');
 assert.equal((await req('/api/loop/flow?cursor='+page.page.nextCursor,'GET',{},2)).status,400,'cursor viewer isolation');
 assert.equal((await req('/api/loop/flow?feed=following&cursor='+page.page.nextCursor)).status,400,'cursor feed isolation');
 const snapshotIds=new Set((await round()).map(post=>post.id));
 insert.run(2);const added=Number(database.prepare('SELECT MAX(id) id FROM loop_posts').get().id);
 const continued=await ok('/api/loop/flow?cursor='+page.page.nextCursor+'&limit=30');
 assert.ok(continued.posts.every(post=>snapshotIds.has(post.id)),'new posts do not disturb current round');
 assert.ok((await round('everyone',30)).some(post=>post.id===added),'new round sees new posts');
 // Exercise both starting strategies deterministically, including freshness and
 // privacy. Existing cursors retain their unchanged, no-repeat round protocol.
 database.exec("UPDATE loop_posts SET created_at='2020-01-01T00:00:00Z'");
 database.prepare('UPDATE loop_posts SET created_at=? WHERE id=?').run('2026-10-13T12:00:00Z',added);
 const visibility=`NOT EXISTS(SELECT 1 FROM loop_blocks b WHERE (b.user_id=? AND b.target_id=p.user_id) OR (b.user_id=p.user_id AND b.target_id=?)) AND NOT EXISTS(SELECT 1 FROM loop_mutes m WHERE m.user_id=? AND m.target_id=p.user_id)`;
 const recentFlow=createLoopFlow(database,visibility,{random:()=>0.1,now:()=>Date.parse('2026-10-13T14:00:00Z')});
 const recentPage=recentFlow(1,new URLSearchParams({limit:'3'}));
 assert.equal(recentPage.ids[0],added,'recent strategy picks a post within the last week');
 assert.notEqual(recentFlow(1,new URLSearchParams({limit:'1',avoid:String(added)})).ids[0],added,'recent starts avoid immediate repeats');
 const randomFlow=createLoopFlow(database,visibility,{random:()=>0.8,now:()=>Date.parse('2026-10-13T14:00:00Z')});
 const randomStart=randomFlow(1,new URLSearchParams({limit:'3'}));
 assert.equal(randomStart.ids.length,3);
 assert.deepEqual(recentFlow(1,new URLSearchParams({limit:'3',cursor:recentPage.page.nextCursor})),recentFlow(1,new URLSearchParams({limit:'3',cursor:recentPage.page.nextCursor})),'recent starts preserve deterministic continuation');
 const recentPlan=database.prepare('EXPLAIN QUERY PLAN SELECT id FROM loop_posts WHERE deleted_at IS NULL AND created_at>=? ORDER BY created_at DESC,id DESC LIMIT 24').all('2026-10-06');
 assert.ok(recentPlan.some(row=>row.detail.includes('loop_flow_recent_idx')),'recent candidates use the recency index');
 const startPlan=database.prepare('EXPLAIN QUERY PLAN SELECT id,flow_rank FROM loop_posts WHERE deleted_at IS NULL AND flow_rank>=? ORDER BY flow_rank,id LIMIT 1').all(42);
 assert.ok(startPlan.some(row=>row.detail.includes('loop_flow_rank_idx'))&&!startPlan.some(row=>row.detail.includes('TEMP B-TREE')),'random starts seek the index without sorting');
 // Change permissions during an existing round, not just before its first page.
 await ok('/api/loop/users/2/block','POST');await ok('/api/loop/users/3/mute','POST');
 const filtered=await ok('/api/loop/flow?cursor='+page.page.nextCursor+'&limit=30');
 assert.ok(filtered.posts.every(post=>post.author.id===1));
 assert.deepEqual((await round()).map(post=>post.id),[1]);
 assert.deepEqual(recentFlow(1,new URLSearchParams({limit:'30'})).ids,[1],'hidden recent posts fall back to visible older posts');
 assert.deepEqual((await round('everyone',7,1)).map(post=>post.id),[1],'single post still usable');
 database.exec("UPDATE loop_posts SET deleted_at='2026-10-10' WHERE id=1");
 assert.equal((await round()).length,0,'deleted posts disappear');
 for(const query of ['feed=bad','limit=NaN','limit=0','limit=1.5','limit=31','avoid=-1','avoid=9007199254740992','cursor=','cursor=bad','cursor='+ 'a'.repeat(513), 'cursor='+Buffer.from(JSON.stringify({v:1})).toString('base64url')]) assert.equal((await req('/api/loop/flow?'+query)).status,400,query);
 const plan=database.prepare('EXPLAIN QUERY PLAN SELECT id FROM loop_posts WHERE deleted_at IS NULL AND (flow_rank,id)>(?,?) ORDER BY flow_rank,id LIMIT 13').all(42,12);
 assert.ok(plan.some(row=>row.detail.includes('loop_flow_rank_idx')),'continuation uses random-rank index');
 console.log('PASS Flow: indexed recent/random starts, fresh/older fallback, migration/trigger, collision-safe no-repeat rounds, new-session variation, snapshot continuation/retry, viewer/feed isolation, Following/block/mute/delete rules, empty/single-post feeds, validated cursors, unchanged Home.');
}finally{database.close();}
