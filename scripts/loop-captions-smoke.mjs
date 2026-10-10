import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLoopService } from '../server/loop.mjs';
import { createLoopCaptions, captionCues, captionVtt } from '../server/loopCaptions.mjs';

const directory = await mkdtemp('/tmp/glean-caption-test-');
const db = new DatabaseSync(':memory:');
db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar_url TEXT,bio TEXT); INSERT INTO users VALUES(1,'Alice',NULL,''),(2,'Bob',NULL,''); CREATE TABLE loop_posts(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT,media_type TEXT,client_id TEXT,created_at TEXT); CREATE TABLE loop_post_comments(id INTEGER PRIMARY KEY,post_id INTEGER,user_id INTEGER,body TEXT,created_at TEXT); CREATE TABLE loop_post_likes(post_id INTEGER,user_id INTEGER);`);
let calls=0, duration=8, noAudio=false, providerFails=false, deletedDuringExtraction=false;
const events=[];
const options={database:db,uploadDirectory:directory,realtimeHub:{broadcastAll:(...args)=>events.push(args),send:()=>{}},apiKey:'test-only',ffmpeg:process.execPath,ffprobe:process.execPath,autoStart:false,
 run:async(binary,args)=>{if(args.includes('-show_entries'))return {stdout:JSON.stringify({format:{duration},streams:noAudio?[]:[{codec_type:'audio'}]})};await writeFile(args.at(-1),'audio');if(deletedDuringExtraction)db.exec("UPDATE loop_posts SET deleted_at='now'");return {stdout:''};},
fetchImpl:async(url,request)=>{calls++;assert.equal(url,'https://api.groq.com/openai/v1/audio/transcriptions');assert.equal(request.body.get('model'),'whisper-large-v3');assert.deepEqual(request.body.getAll('timestamp_granularities[]'),['word','segment']);return {ok:!providerFails,json:async()=>({language:'english',segments:[{start:1.2,end:3.4,text:'Hello <Glean> & everyone.'}]})};}};
const service=createLoopService({database:db,uploadDirectory:directory,realtimeHub:options.realtimeHub,captionOptions:options,parseMultipart:async request=>request.multipart,readJson:async request=>request.body,currentUser:request=>db.prepare('SELECT * FROM users WHERE id=?').get(request.userId),sendJson:(response,status,body)=>Object.assign(response,{status,body}),sendLocalFile:()=>{},isAdmin:()=>false,nameFile:()=>''});
const worker=createLoopCaptions(options);
async function req(path,method='GET',body={},userId=1,multipart){const response={writeHead(status,headers){this.status=status;this.headers=headers;},end(text){this.text=text;}};await service.route({url:path,method,body,userId,multipart,headers:{host:'localhost','content-type':multipart?'multipart/form-data':''}},response,path,new Date().toISOString());return response;}
let serial=0;
async function upload(enabled=true){const storageName='video-'+(++serial);await writeFile(join(directory,storageName),'video');return req('/api/loop/posts','POST',{},1,{fields:{content:'Caption post',autoCaptions:String(enabled)},files:[{name:'video.mp4',storageName,type:'video/mp4',size:5}]});}
try {
 for(const userId of [1,2])await req('/api/loop/connection','POST',{confirmed:true,consentVersion:1},userId);
 assert.equal((await req('/api/loop/captions/config')).body.available,true);
 const off=await upload(false);assert.equal(off.status,201);assert.equal(off.body.post.media[0].captions,null);await worker.drain();assert.equal(calls,0);
 const on=await upload();const id=on.body.post.media[0].id;assert.equal(on.body.post.media[0].captions.status,'queued');await worker.drain();assert.equal(calls,1);assert.equal(worker.get(id).status,'ready');
 const vtt=await req(`/api/loop/media/${id}/captions.vtt`);assert.equal(vtt.status,200);assert.match(vtt.text,/00:00:01.200 --> 00:00:03.400/);assert.match(vtt.text,/Hello &lt;Glean&gt; &amp; everyone/);
 db.exec('INSERT INTO loop_blocks VALUES(2,1,\'now\')');assert.equal((await req(`/api/loop/media/${id}/captions.vtt`,'GET',{},2)).status,404);db.exec('DELETE FROM loop_blocks');
 duration=1801;const tooLong=(await upload()).body.post.media[0].id;await worker.drain();assert.equal(worker.get(tooLong).status,'failed');assert.equal(calls,1);
 assert.equal((await req(`/api/loop/media/${tooLong}/captions`,'POST',{},2)).status,403);
 duration=8;noAudio=true;const silent=(await upload()).body.post.media[0].id;await worker.drain();assert.equal(worker.get(silent).status,'failed');assert.equal(calls,1);noAudio=false;
 providerFails=true;const failed=(await upload()).body.post.media[0].id;await worker.drain();assert.equal(worker.get(failed).status,'failed');providerFails=false;assert.equal((await req(`/api/loop/media/${failed}/captions`,'POST')).status,202);await worker.drain();assert.equal(worker.get(failed).status,'ready');
 assert.equal((await req(`/api/loop/media/${failed}/captions`,'POST')).status,409);
 const interrupted=(await upload()).body.post.media[0].id;db.prepare("UPDATE loop_media_captions SET status='processing' WHERE media_id=?").run(interrupted);createLoopCaptions(options);assert.equal(worker.get(interrupted).status,'queued');await worker.drain();
 const deleted=(await upload()).body.post.media[0].id;const before=calls;deletedDuringExtraction=true;await worker.drain();assert.equal(calls,before);assert.equal(worker.get(deleted),undefined);
 assert.deepEqual(captionCues({segments:[{start:-1,end:1,text:'bad'},{start:2,end:1,text:'bad'},{start:NaN,end:2,text:'bad'}]},8),[]);
 assert.throws(()=>captionCues({},8));assert.ok(events.length>0);
 const phrases=captionCues({words:[{start:1,end:1.4,word:'Hello'},{start:1.5,end:2,word:'everyone.'},{start:4,end:4.3,word:'Welcome'},{start:4.4,end:4.6,word:'to'},{start:4.7,end:5.2,word:'Glean.'}]},8);
 assert.deepEqual(phrases.map(cue=>cue.text),['Hello everyone.','Welcome to Glean.']);
 assert.equal(phrases[0].start,.96);assert.ok(phrases[0].end<2.7,'no caption lingers through silence');assert.equal(phrases[1].start,3.96);
 const fast=captionCues({words:Array.from({length:35},(_,i)=>({start:i*.2,end:i*.2+.18,word:'word'+i}))},7);
 assert.ok(fast.length>3);assert.ok(fast.every((cue,i)=>cue.text.length<=64&&cue.end>cue.start&&cue.end<=7&&(!i||fast[i-1].end<=cue.start)));
 assert.equal(fast.map(cue=>cue.text).join(' ').split(' ').length,35,'no words dropped when splitting');
 const edge=captionCues({words:[{start:0,end:.01,word:'Hi.'},{start:.03,end:.04,word:'Yes.'},{start:7.9,end:99,word:'Bye.'},{start:9,end:10,word:'Outside'},{start:-1,end:1,word:'Invalid'}]},8);
 assert.ok(edge.every((cue,i)=>cue.start>=0&&cue.end<=8&&cue.end>cue.start&&(!i||edge[i-1].end<=cue.start)));
 assert.deepEqual(captionCues({words:[{start:1,end:2,word:'noise'}],segments:[{start:0,end:3,text:'noise',no_speech_prob:.99}]},8),[]);
 assert.equal(captionCues({words:[{start:1,end:1.4,word:'你'},{start:1.4,end:1.8,word:'好'}]},8)[0].text,'你好');
 const punctuation=captionCues({segments:[{start:0,end:2.4,text:'Hello everyone. Next sentence.'}],words:[{start:0,end:.4,word:'Hello'},{start:.5,end:1.2,word:'everyone'},{start:1.3,end:1.7,word:'Next'},{start:1.8,end:2.4,word:'sentence'}]},3);
 assert.deepEqual(punctuation.map(cue=>cue.text),['Hello everyone.','Next sentence.']);assert.ok(punctuation[0].end<=punctuation[1].start);
 console.log('PASS: opt-in only, queue/processing/timestamps/WebVTT escaping, duration/no-audio failures, authorization, provider retry, restart recovery, deletion privacy, realtime updates.');
} finally { db.close();await rm(directory,{recursive:true,force:true}); }
