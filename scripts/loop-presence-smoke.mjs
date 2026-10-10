import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createLoopService } from '../server/loop.mjs';

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar_url TEXT,bio TEXT,presence_hidden INTEGER DEFAULT 0,keep_information_secret INTEGER DEFAULT 0);
  CREATE TABLE loop_posts(id INTEGER PRIMARY KEY,user_id INTEGER,body TEXT,media_type TEXT,created_at TEXT);
  CREATE TABLE loop_post_comments(id INTEGER PRIMARY KEY,post_id INTEGER,user_id INTEGER,body TEXT,created_at TEXT);
`);
for (let id=1;id<=65;id++) database.prepare('INSERT INTO users(id,username) VALUES(?,?)').run(id,'person_'+id);
const statuses=new Map(), events=[];
const service=createLoopService({database,uploadDirectory:'/tmp',parseMultipart:async()=>({}),sendLocalFile:()=>{},sendJson:(response,status,body)=>Object.assign(response,{status,body}),readJson:async request=>request.body,currentUser:request=>database.prepare('SELECT * FROM users WHERE id=?').get(request.userId),realtimeHub:{send:()=>{},broadcast:(ids,event,payload)=>events.push({ids:[...ids],event,payload})},isAdmin:()=>false,nameFile:()=>'',publicPresence:id=>statuses.get(id)||'online'});
const connected=database.prepare('INSERT INTO loop_accounts VALUES(?,?,1)');
for(let id=1;id<=64;id++) connected.run(id,'2026-10-09');
const sockets=Array.from({length:65},()=>({destroyed:false}));
const active=(id,value=true,socket=sockets[id-1])=>service.presence.handle({id},{event:'loop-presence',payload:{active:value,userId:1}},socket);
const get=async(path='/api/loop/online',userId=1)=>{const response={};await service.route({url:path,method:'GET',userId,headers:{host:'localhost'}},response,path.split('?')[0],'2026-10-09');return response;};
try {
  assert.equal((await get('/api/loop/online',999)).status,401);
  assert.equal((await get('/api/loop/online',65)).status,403);
  assert.equal((await get()).body.total,0);
  for(let id=1;id<=65;id++) active(id);
  assert.equal((await get()).body.total,64,'unconnected account cannot advertise Loop presence');
  const first=(await get()).body;assert.equal(first.users.length,30);assert.equal(first.page.nextAfter,30);
  const second=(await get('/api/loop/online?after=30')).body;assert.equal(second.users[0].id,31);assert.equal(second.page.nextAfter,60);
  const third=(await get('/api/loop/online?after=60')).body;assert.equal(third.users.length,4);assert.equal(third.page.hasMore,false);
  const otherTab={destroyed:false};active(2,true,otherTab);active(2,false);assert.equal((await get()).body.total,64,'one tab leaving preserves another');
  service.presence.leave(otherTab);assert.equal((await get()).body.total,63);
  active(2);sockets[2].destroyed=true;assert.equal((await get()).body.total,63,'dead sockets never count');
  service.presence.leave(sockets[2]);sockets[2].destroyed=false;active(3);
  database.prepare('UPDATE users SET presence_hidden=1 WHERE id=4').run();
  database.prepare('UPDATE users SET keep_information_secret=1 WHERE id=5').run();statuses.set(6,'offline');statuses.set(7,'idle');statuses.set(8,'dnd');
  database.prepare('INSERT INTO loop_blocks VALUES(1,9,?)').run('now');database.prepare('INSERT INTO loop_blocks VALUES(10,1,?)').run('now');
  const visible=(await get('/api/loop/online?limit=100')).body;assert.equal(visible.total,59);assert.ok(!visible.users.some(user=>[4,5,6,9,10].includes(user.id)));assert.equal(visible.users.find(user=>user.id===7).presence,'idle');
  active(11,'true');assert.equal((await get()).body.total,59);
  for(const query of ['limit=101','limit=0','limit=1.5','after=-1','after=NaN','after=1.5'])assert.equal((await get('/api/loop/online?'+query)).status,400);
  await delay(300);assert.equal(events.length,1,'joins are coalesced');assert.equal(events[0].event,'loop-online-changed');assert.deepEqual(events[0].payload,{},'no hidden identities in broadcasts');assert.ok(!events[0].ids.includes(65));
  active(2,false);await delay(300);assert.equal(events.length,2);
  console.log('PASS Loop presence: auth/consent, real socket activity, multi-tab leave/disconnect, privacy, bidirectional blocks, all pages, invalid input and coalesced realtime updates.');
} finally { service.presence.close();database.close(); }
