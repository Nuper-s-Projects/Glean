import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLoopService } from '../server/loop.mjs';
import { createLoopVideos } from '../server/loopVideos.mjs';
import { createLoopCaptions } from '../server/loopCaptions.mjs';
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar_url TEXT,bio TEXT,created_at TEXT);
INSERT INTO users VALUES(1,'PerfUser',NULL,'','2026-10-13');
CREATE TABLE loop_posts(id INTEGER PRIMARY KEY,user_id INTEGER,body TEXT,media_type TEXT,client_id TEXT,created_at TEXT);
CREATE TABLE loop_post_likes(post_id INTEGER,user_id INTEGER,created_at TEXT,PRIMARY KEY(post_id,user_id));
CREATE TABLE loop_post_comments(id INTEGER PRIMARY KEY,post_id INTEGER,user_id INTEGER,body TEXT,created_at TEXT);`);
let queries=0;
const database=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{const statement=target.prepare(sql);return new Proxy(statement,{get(s,method){const value=s[method];if(typeof value!=='function')return value;return (...args)=>{if(['get','all','run'].includes(method))queries++;return value.apply(s,args);};}});};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
const service=createLoopService({database,uploadDirectory:'/tmp',captionOptions:{apiKey:'',autoStart:false},videoOptions:{autoStart:false,ffmpeg:'',ffprobe:''},sendJson:(r,status,body)=>Object.assign(r,{status,body}),currentUser:()=>({id:1,username:'PerfUser'}),realtimeHub:{broadcastAll(){},send(){}},isAdmin:()=>false});
db.exec("INSERT INTO loop_accounts VALUES(1,'2026-10-13',1)");
const post=db.prepare("INSERT INTO loop_posts(id,user_id,body,media_type,created_at) VALUES(?,1,'Perf fixture','video','2026-10-13')");
const media=db.prepare("INSERT INTO loop_post_media(post_id,storage_name,original_name,mime_type,size_bytes,position) VALUES(?,?,'Fixture','video/mp4',42,?)");
db.exec('BEGIN');for(let id=1;id<=10000;id++){post.run(id);if(id>9988)for(let n=0;n<4;n++)media.run(id,`perf-${id}-${n}`,n);}db.exec('COMMIT');
async function request(){const r={};await service.route({url:'/api/loop/posts?limit=12',method:'GET',headers:{host:'localhost'}},r,'/api/loop/posts',new Date().toISOString());if(r.status!==200)throw Error(JSON.stringify(r));return r;}
await request();queries=0;const times=[];for(let i=0;i<60;i++){const start=performance.now();await request();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
const queriesPerPage = queries/60;
assert.ok(queriesPerPage <= 7, 'attachment status reads must be batched, independent of gallery size');
const plan=db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM loop_posts WHERE original_post_id=? AND deleted_at IS NULL').all(1);
assert.ok(plan.some(row=>row.detail.includes('loop_posts_original_idx')), 'repost counts must use the index');
const {body}=await request();assert.equal(body.posts.length,12);
for(const post of body.posts){assert.equal(post.media.length,4);for(const file of post.media){assert.equal(file.playback.status,'pending');assert.equal(file.captions,null);}}
const videos=createLoopVideos({database,uploadDirectory:'/tmp',autoStart:false,ffmpeg:'',ffprobe:''});
const captions=createLoopCaptions({database,uploadDirectory:'/tmp',autoStart:false,apiKey:''});
for(const [index,status] of ['ready','queued','processing','failed'].entries()) {
  db.prepare("INSERT INTO loop_media_playback(media_id,status,attempts,width,height,duration,created_at,updated_at) VALUES(?,?,1,320,180,1,'now','now')").run(index+1,status);
  db.prepare("INSERT INTO loop_media_captions(media_id,status,language,created_at,updated_at) VALUES(?,?,'english','now','now')").run(index+1,status);
}
db.prepare("INSERT INTO loop_media_captions(media_id,status,created_at,updated_at) VALUES(5,'empty','now','now')").run();
const ids=[1,2,3,4,5,999];
const playback=videos.publicStatuses(ids), caption=captions.publicStatuses(ids);
for(const id of ids){assert.deepEqual(playback.get(id),videos.publicStatus(id));assert.deepEqual(caption.get(id)||null,captions.publicStatus(id));}
assert.equal(videos.publicStatuses([]).size,0);assert.equal(captions.publicStatuses([]).size,0);
await videos.close();
console.log('PASS: bounded page query count, indexed repost counts, complete ordered media and pending playback/captions fallback.');
console.log(JSON.stringify({queriesPerPage,medianMs:times[30],p95Ms:times[57],posts:10000,attachmentsPerPage:48}));
await service.close();db.close();
