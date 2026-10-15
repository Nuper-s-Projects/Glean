import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLoopService } from '../server/loop.mjs';
import { createLoopVideos } from '../server/loopVideos.mjs';

const run = promisify(execFile), directory = await mkdtemp('/tmp/glean-video-playback-');
const ffmpeg = process.env.GLEAN_VIDEO_FFMPEG || '/opt/homebrew/bin/ffmpeg';
const ffprobe = process.env.GLEAN_VIDEO_FFPROBE || '/opt/homebrew/bin/ffprobe';
const database = new DatabaseSync(':memory:');
database.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,avatar_url TEXT,bio TEXT); INSERT INTO users VALUES(1,'Alice',NULL,''),(2,'Bob',NULL,'');
  CREATE TABLE loop_posts(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT,media_type TEXT,client_id TEXT,created_at TEXT);
  CREATE TABLE loop_post_comments(id INTEGER PRIMARY KEY,post_id INTEGER,user_id INTEGER,body TEXT,created_at TEXT);
  CREATE TABLE loop_post_likes(post_id INTEGER,user_id INTEGER);`);
const events = [], options = { database,uploadDirectory:directory,realtimeHub:{send:()=>{},broadcastAll:(...args)=>events.push(args)},ffmpeg,ffprobe,autoStart:false };
const service = createLoopService({ ...options, videoOptions:options,captionOptions:{autoStart:false},nameFile:()=>'',
  currentUser:request=>database.prepare('SELECT * FROM users WHERE id=?').get(request.userId),parseMultipart:async request=>request.multipart,
  readJson:async request=>request.body,sendJson:(response,status,body)=>Object.assign(response,{status,body}),
  sendLocalFile:(request,response,file,options)=>Object.assign(response,{status:200,file,type:options.type}),isAdmin:()=>false });
const worker = createLoopVideos(options);
async function req(url,method='GET',body={},userId=1,multipart) {
  const response = {};
  await service.route({url,method,body,userId,multipart,headers:{host:'localhost','content-type':multipart?'multipart/form-data':''}},response,url.split('?')[0],new Date().toISOString());
  return response;
}
async function fixture(name,type,encoding,size='160x90',audio=true) {
  const path = join(directory,name);
  await run(ffmpeg,['-nostdin','-v','error','-y','-f','lavfi','-i',`testsrc2=size=${size}:rate=24`,
    ...(audio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[]),'-t','1.5',...encoding,'-threads','1',path],{timeout:60000,maxBuffer:1024*1024});
  return {name,storageName:name,type,size:(await stat(path)).size};
}
try {
  for (const id of [1,2]) assert.equal((await req('/api/loop/connection','POST',{confirmed:true,consentVersion:1},id)).status,201);
  const fixtures = [
    await fixture('hevc.mov','video/quicktime',['-c:v','libx265','-pix_fmt','yuv420p10le','-x265-params','pools=1:frame-threads=1:log-level=error','-c:a','aac']),
    await fixture('vp9.webm','video/webm',['-c:v','libvpx-vp9','-deadline','realtime','-c:a','libopus']),
    await fixture('prores.mov','video/quicktime',['-c:v','prores_ks','-profile:v','2','-c:a','pcm_s16le']),
    await fixture('silent.mov','video/quicktime',['-c:v','libx265','-pix_fmt','yuv420p10le','-x265-params','pools=1:frame-threads=1:log-level=error'],'180x320',false),
    await fixture('compatible.mp4','video/mp4',['-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac']),
    await fixture('hdr.mov','video/quicktime',['-c:v','libx265','-pix_fmt','yuv420p10le','-color_trc','smpte2084','-color_primaries','bt2020','-colorspace','bt2020nc','-x265-params','pools=1:frame-threads=1:log-level=error','-c:a','aac']),
  ];
  const ids = [];
  for (const file of fixtures) {
    const original = await readFile(join(directory,file.storageName));
    const uploaded = await req('/api/loop/posts','POST',{},1,{fields:{content:file.name},files:[file]});
    assert.equal(uploaded.status,201,JSON.stringify(uploaded));
    const id = uploaded.body.post.media[0].id; ids.push(id);
    assert.equal(uploaded.body.post.media[0].playback.status,'queued');
    assert.equal((await req(`/api/loop/media/${id}/playback`,'POST')).status,202);
    assert.equal(database.prepare('SELECT COUNT(*) n FROM loop_media_playback WHERE media_id=?').get(id).n,1);
    await worker.drain();
    const playback = worker.publicStatus(id);
    assert.equal(playback.status,'ready',JSON.stringify(playback));
    assert.equal((await req(`/api/loop/media/${id}/playback`,'POST')).status,200);
    const output = worker.file(id), data = JSON.parse((await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',output])).stdout);
    assert.equal(data.streams.find(s=>s.codec_type==='video').codec_name,'h264');
    assert.equal(data.streams.find(s=>s.codec_type==='video').pix_fmt,'yuv420p');
    const audio = data.streams.find(s=>s.codec_type==='audio'); if (audio) assert.equal(audio.codec_name,'aac');
    assert.ok(Number(data.format.duration)>=1.4);
    const bytes = await readFile(output); assert.ok(bytes.indexOf(Buffer.from('moov'))<bytes.indexOf(Buffer.from('mdat')),'MP4 metadata precedes video payload');
    assert.deepEqual(await readFile(join(directory,file.storageName)),original,'original remains unchanged');
    assert.equal((await req(`/api/loop/media/${id}`,'HEAD')).type,'video/mp4');
    assert.equal((await req(`/api/loop/media/${id}?original=1`)).file,join(directory,file.storageName));
    console.log(`PASS: ${file.name} -> complete, seekable H.264/AAC MP4`);
  }
  database.exec("INSERT INTO loop_blocks VALUES(2,1,'now')");
  for (const suffix of ['', '/playback','/playback.mp4']) assert.equal((await req(`/api/loop/media/${ids[0]}${suffix}`,'GET',{},2)).status,404);
  database.exec('DELETE FROM loop_blocks');
  const first = ids[0], firstPost = database.prepare('SELECT post_id FROM loop_post_media WHERE id=?').get(first).post_id;
  const derivative = worker.file(first);
  assert.equal((await req(`/api/loop/posts/${firstPost}`,'DELETE')).status,200);
  assert.equal((await req(`/api/loop/media/${first}/playback.mp4`)).status,404);
  await assert.rejects(stat(derivative),{code:'ENOENT'});
  const remaining = ids[1]; database.prepare("UPDATE loop_media_playback SET status='processing',attempts=1 WHERE media_id=?").run(remaining);
  const resumed = createLoopVideos(options); assert.equal(resumed.publicStatus(remaining).status,'queued'); await resumed.drain(); assert.equal(resumed.publicStatus(remaining).status,'ready'); await resumed.close();
  await writeFile(join(directory,'invalid.mp4'),'not a video');
  const bad = await req('/api/loop/posts','POST',{},1,{fields:{content:'Broken media'},files:[{name:'invalid.mp4',storageName:'invalid.mp4',type:'video/mp4',size:11}]});
  const badId = bad.body.post.media[0].id;
  for (let attempt=0;attempt<3;attempt++) { if (attempt) assert.equal((await req(`/api/loop/media/${badId}/playback`,'POST',{retry:true})).status,202); await worker.drain(); assert.equal(worker.publicStatus(badId).status,'failed'); }
  assert.equal((await req(`/api/loop/media/${badId}/playback`,'POST',{retry:true})).status,422);
  assert.equal((await req(`/api/loop/media/${badId}/playback`,'POST',{retry:'yes'})).status,400);
  database.exec("INSERT INTO loop_notifications(user_id,actor_id,type,body,read_at,created_at) VALUES(1,2,'follow','followed you','now','2026-10-12'),(1,2,'like','liked your post',NULL,'2026-10-12')");
  assert.equal((await req('/api/loop/notifications?unread=1')).body.notifications.length,1);
  assert.equal((await req('/api/loop/notifications')).body.notifications.length,2);
  assert.ok(events.some(([event])=>event==='loop-post-updated'));
  console.log('PASS: deduplicated jobs, restart recovery, original preservation, deletion cleanup, blocked access, bounded invalid-file retries, unread filtering.');
} finally { await worker.close(); await service.close(); database.close(); await rm(directory,{recursive:true,force:true}); }
