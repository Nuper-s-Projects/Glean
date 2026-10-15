import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLoopService } from '../server/loop.mjs';

const database = new DatabaseSync(':memory:');
database.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar_url TEXT,bio TEXT,created_at TEXT);
  INSERT INTO users VALUES(1,'Nuper',NULL,'','2026-10-01'),(2,'Friend',NULL,'','2026-10-01'),(3,'AuraPeer',NULL,'','2026-10-01');
  CREATE TABLE loop_posts(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT,media_type TEXT,client_id TEXT,created_at TEXT);
  CREATE TABLE loop_post_likes(post_id INTEGER,user_id INTEGER,created_at TEXT,PRIMARY KEY(post_id,user_id));
  CREATE TABLE loop_post_comments(id INTEGER PRIMARY KEY,post_id INTEGER REFERENCES loop_posts(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,body TEXT,created_at TEXT);
`);
const options = {
  database, uploadDirectory:'/tmp', videoOptions:{autoStart:false,ffmpeg:'',ffprobe:''}, captionOptions:{apiKey:''},
  parseMultipart:async()=>({files:[],fields:{}}), nameFile:()=>'', sendLocalFile:()=>{},
  sendJson:(response,status,body)=>Object.assign(response,{status,body}), readJson:async request=>request.body,
  currentUser:request=>database.prepare('SELECT * FROM users WHERE id=?').get(request.userId),
  realtimeHub:{broadcastAll:()=>{},send:()=>{}}, isAdmin:()=>false,
};
const service = createLoopService(options);
async function request(path, method='GET', body={}, userId=1, day='2026-10-01') {
  const response = {};
  await service.route({url:path,method,body,userId,headers:{host:'localhost'}},response,path.split('?')[0],`${day}T12:00:00.000Z`);
  return response;
}
async function ok(...args) {
  const response = await request(...args);
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
  return response.body;
}
try {
  await ok('/api/loop/connection','POST',{confirmed:true,consentVersion:1},1);
  await ok('/api/loop/connection','POST',{confirmed:true,consentVersion:1},2);
  await ok('/api/loop/connection','POST',{confirmed:true,consentVersion:1},3);
  let result = await ok('/api/loop/aura/check-in','POST',{},1,'2026-10-01');
  assert.deepEqual(result.checkIn,{date:'2026-10-01',claimed:true,alreadyClaimed:false,aura:5,streakBonus:0,streakDays:1});
  result = await ok('/api/loop/aura/check-in','POST',{},1,'2026-10-01');
  assert.equal(result.checkIn.claimed,false,'repeat same-day check-in is not awarded again');
  assert.equal(result.balance,5);
  for (let day=2;day<=30;day++) {
    const date = new Date(Date.UTC(2026,9,day)).toISOString().slice(0,10);
    result = await ok('/api/loop/aura/check-in','POST',{},1,date);
    if (day===2) assert.equal(result.checkIn.streakBonus,5,'2-day milestone');
    if (day===7) assert.equal(result.checkIn.streakBonus,20,'7-day milestone');
    if (day===30) assert.equal(result.checkIn.streakBonus,100,'30-day milestone');
  }
  assert.equal(result.streakDays,30);
  assert.equal(result.balance,275,'30 daily rewards plus the 2, 7, and 30-day streak bonuses');
  const original = (await ok('/api/loop/posts','POST',{content:'Like target'},1,'2026-10-30')).post;
  for (let index=0;index<3;index++) await ok('/api/loop/posts','POST',{content:`Daily post ${index}`},1,'2026-10-30');
  const commentTarget = (await ok('/api/loop/posts','POST',{content:'Comment target'},2,'2026-10-30')).post;
  for (let index=0;index<12;index++) await ok(`/api/loop/posts/${commentTarget.id}/comments`,'POST',{content:`Comment ${index}`},1,'2026-10-30');
  await ok(`/api/loop/posts/${original.id}/like`,'POST',{},2,'2026-10-30');
  await ok(`/api/loop/posts/${original.id}/like`,'POST',{},2,'2026-10-30');
  await ok('/api/loop/users/1/follow','POST',{},2,'2026-10-30');
  await ok('/api/loop/aura/check-in','POST',{},2,'2026-10-30');
  await ok('/api/loop/posts','POST',{content:'Friend earns Aura'},2,'2026-10-30');
  await ok('/api/loop/aura/check-in','POST',{},3,'2026-10-30');
  database.prepare('UPDATE users SET is_verified=1 WHERE id=?').run(2);
  const final = await ok('/api/loop/aura','GET',{},1,'2026-10-30');
  assert.equal(final.balance,328,'daily caps and unique like/follower rewards are enforced');
  assert.deepEqual(final.leaderboard.slice(0,3).map(person => [person.username,person.balance]),[['Nuper',328],['Friend',25],['AuraPeer',5]],'leaderboard ranks multiple accounts by balance');
  assert.equal(final.leaderboard[1].verified,true,'Loop leaderboard carries the Verified badge state');
  const afterMissedDay = await ok('/api/loop/aura/check-in','POST',{},2,'2026-11-01');
  assert.equal(afterMissedDay.checkIn.streakDays,1,'a missed day resets the consecutive streak');
  console.log('PASS: 30 simulated daily check-ins, 2/7/30-day bonuses, streak reset, multi-account leaderboard, Verified propagation, caps, and deduplication.');
} finally { database.close(); }
