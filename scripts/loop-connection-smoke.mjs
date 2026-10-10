import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLoopService } from '../server/loop.mjs';
import { loopReturnPath, loopSignInPath } from '../src/app/loopEntry.js';

const database=new DatabaseSync(':memory:');
database.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar_url TEXT,bio TEXT);
 INSERT INTO users VALUES(1,'Alice',NULL,''),(2,'Bob',NULL,'');
 CREATE TABLE loop_posts(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT,media_type TEXT,created_at TEXT);
 CREATE TABLE loop_post_comments(id INTEGER PRIMARY KEY,post_id INTEGER,user_id INTEGER,body TEXT,created_at TEXT);
 CREATE TABLE loop_post_likes(post_id INTEGER,user_id INTEGER);
 INSERT INTO loop_posts VALUES(1,1,'Existing post','none','2026-10-09');
`);
const options={database,uploadDirectory:'/tmp',parseMultipart:async()=>({files:[],fields:{}}),sendLocalFile:()=>{},sendJson:(response,status,body)=>Object.assign(response,{status,body}),readJson:async request=>request.body,currentUser:request=>database.prepare('SELECT * FROM users WHERE id=?').get(request.userId),realtimeHub:{send:()=>{},broadcastAll:()=>{}},isAdmin:()=>false,nameFile:()=>''};
let service=createLoopService(options);
async function req(path,method='GET',body={},userId=1){const response={};await service.route({url:path,method,body,userId,headers:{host:'localhost'}},response,path.split('?')[0],'2026-10-09T12:00:00Z');return response;}
try{
 assert.equal((await req('/api/loop/connection','GET',{},999)).status,401);
 assert.equal((await req('/api/loop/connection')).body.connected,false);
 assert.equal((await req('/api/loop/posts')).body.loopConnectionRequired,true);
 assert.equal((await req('/api/loop/posts','POST',{content:'Cannot bypass'})).status,403);
 for(const body of [{},{confirmed:false,consentVersion:1},{confirmed:'true',consentVersion:1},{confirmed:true,consentVersion:999}])assert.equal((await req('/api/loop/connection','POST',body)).status,400);
 const linked=await req('/api/loop/connection','POST',{confirmed:true,consentVersion:1,userId:2});
 assert.equal(linked.status,201);assert.equal(linked.body.account.id,1);
 assert.equal((await req('/api/loop/connection','GET',{},2)).body.connected,false);
 assert.equal((await req('/api/loop/connection','POST',{confirmed:true,consentVersion:1})).status,200);
 assert.equal(database.prepare('SELECT COUNT(*) n FROM loop_accounts').get().n,1);
 assert.equal((await req('/api/loop/posts')).body.posts[0].content,'Existing post');
 service=createLoopService(options);
 assert.equal((await req('/api/loop/connection')).body.connected,true);
 assert.equal(database.prepare('SELECT COUNT(*) n FROM users').get().n,2);
 assert.equal(loopReturnPath({pathname:'/loop',search:'?post=42'}),'/loop?post=42');
 assert.equal(loopReturnPath({pathname:'/loop',search:'?unknown=1'}),'/loop');
 assert.equal(loopReturnPath({pathname:'/signin',search:'?next=%2Floop'}),'/loop');
 for(const next of ['https://evil.test','//evil.test','/dms','/loop?post=javascript:alert(1)'])assert.equal(loopReturnPath({pathname:'/signin',search:'?next='+encodeURIComponent(next)}),null);
 assert.equal(new URLSearchParams(loopSignInPath('/loop?post=42').split('?')[1]).get('next'),'/loop?post=42');
 console.log('PASS: unauthenticated access, explicit consent, server-side gating, account identity isolation, idempotency/restart, legacy post preservation and safe sign-in return paths.');
}finally{database.close();}
