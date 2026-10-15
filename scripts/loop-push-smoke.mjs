import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLoopService } from '../server/loop.mjs';
const database = new DatabaseSync(':memory:');
database.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar_url TEXT,bio TEXT);
 INSERT INTO users VALUES(1,'Alice',NULL,''),(2,'Bob',NULL,'');
 CREATE TABLE loop_posts(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT,media_type TEXT,client_id TEXT,created_at TEXT);
 CREATE TABLE loop_post_likes(post_id INTEGER,user_id INTEGER);
 CREATE TABLE loop_post_comments(id INTEGER PRIMARY KEY,post_id INTEGER,user_id INTEGER,body TEXT,created_at TEXT);`);
const pushes = [];
const service = createLoopService({ database, uploadDirectory:'/tmp', videoOptions:{autoStart:false}, captionOptions:{autoStart:false},
 currentUser:request=>database.prepare('SELECT * FROM users WHERE id=?').get(request.userId), readJson:async request=>request.body,
 sendJson:(response,status,body)=>Object.assign(response,{status,body}), realtimeHub:{send(){},broadcastAll(){}}, isAdmin:()=>false,
 pushService:{notifyUsers:(users,payload)=>pushes.push({users,payload})} });
async function req(path,method='GET',body={},userId=1) {
 const response={}; await service.route({url:path,method,body,userId,headers:{host:'localhost'}},response,path.split('?')[0],new Date().toISOString());
 assert.ok(response.status>=200&&response.status<300,JSON.stringify(response));return response.body;
}
try {
 for(const userId of [1,2])await req('/api/loop/connection','POST',{confirmed:true,consentVersion:1},userId);
 assert.equal((await req('/api/loop/notification-preferences')).preferences.browserPush,false);
 const post=(await req('/api/loop/posts','POST',{content:'A post'})).post;
 await req(`/api/loop/posts/${post.id}/comments`,'POST',{content:'Default off'},2);
 assert.equal(pushes.length,0);
 await req('/api/loop/notification-preferences','PATCH',{browserPush:true});
 const comment=await req(`/api/loop/posts/${post.id}/comments`,'POST',{content:'Notify Alice'},2);
 assert.equal(pushes.length,1);assert.deepEqual(pushes[0].users,[1]);
 assert.equal(pushes[0].payload.kind,'loop');assert.equal(pushes[0].payload.title,'Loop');
 assert.equal(pushes[0].payload.body,'Bob commented on your post');
 assert.equal(pushes[0].payload.url,`/loop?post=${post.id}&comment=${comment.id}`);
 await req('/api/loop/users/1/follow','POST',{},2);
 assert.equal(pushes.at(-1).payload.url,'/loop?profile=2');
 const count=pushes.length;
 await req('/api/loop/users/1/follow','POST',{},2);await req('/api/loop/users/1/follow','POST',{},2);
 assert.equal(pushes.length,count,'deduplicated notifications do not push twice');
 await req('/api/loop/notification-preferences','PATCH',{comments:false});
 await req(`/api/loop/posts/${post.id}/comments`,'POST',{content:'Suppressed category'},2);
 assert.equal(pushes.length,count);
 await req('/api/loop/notification-preferences','PATCH',{comments:true,browserPush:false});
 await req(`/api/loop/posts/${post.id}/comments`,'POST',{content:'Push disabled'},2);
 assert.equal(pushes.length,count);
 await req('/api/loop/notification-preferences','PATCH',{browserPush:true});
 await req('/api/loop/users/2/mute','POST');
 await req(`/api/loop/posts/${post.id}/comments`,'POST',{content:'Muted actor'},2);
 assert.equal(pushes.length,count);
 console.log('PASS: Loop push opt-in, correct title/body/deep links, deduplication, category filtering, opt-out and mutes.');
} finally {await service.close();database.close();}
