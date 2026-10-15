import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { chmod, copyFile, mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDownloadProxy, isPublicAddress } from './videoDownloadProxy.mjs';

const hosts = ['youtube.com','youtu.be','tiktok.com','reddit.com','redd.it','x.com','twitter.com','instagram.com','vimeo.com'];
const running = new Set(['queued','fetching','downloading','processing']);
const MAX_BYTES = 300 * 1024 * 1024, TTL = 30 * 60_000;
const clean = (value,max=180)=>String(value || '').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max);

export function validateVideoUrl(value) {
  if(typeof value!=='string' || value.length>2048)throw new Error('Enter a video link.');
  let url;
  try {url=new URL(value.trim());}catch {throw new Error('Enter a valid HTTPS video link.');}
  const host=url.hostname.toLowerCase();
  const address=host.replace(/^\[|\]$/g,'');
  const direct=url.pathname.toLowerCase().endsWith('.mp4') && !/^(localhost|.+\.(localhost|local|internal))$/.test(host) && (!isIP(address)||isPublicAddress(address));
  if(url.protocol!=='https:' || url.username || url.password || url.port || !(direct||hosts.some(site=>host===site||host.endsWith(`.${site}`)))) throw new Error('Use a public YouTube, TikTok, Reddit, X, Instagram, Vimeo, or HTTPS MP4 link.');
  url.hash='';return url.href;
}

export function createVideoDownloadService({dataDirectory,sendJson,readJson,requireSignedInUser,sendLocalFile,takeRateLimit}) {
  const directory=join(dataDirectory,'video-downloads');
  const jobs=new Map();
  const accountStarts=new Map(),globalStarts=[];
  let active=false,copying=false,initializationError=null;
  const initialized=(async()=>{
    await mkdir(directory,{recursive:true,mode:0o700});
    // Only our UUID-named temporary job directories are removed after restart.
    for(const item of await readdir(directory,{withFileTypes:true})) if(item.isDirectory()&&/^[a-f0-9-]{36}$/.test(item.name)) await rm(join(directory,item.name),{recursive:true,force:true});
  })().catch(error=>{initializationError=error;console.error('Video download storage unavailable:',error.code||'filesystem error');});
  const visible=job=>({id:job.id,status:job.status,title:job.title,uploader:job.uploader,duration:job.duration,progress:job.progress,error:job.error,size:job.size,expiresAt:job.expiresAt,
    ...(job.status==='ready'?{downloadUrl:`/api/v1/video-downloads/${job.id}/file`,previewUrl:`/api/v1/video-downloads/${job.id}/file?preview=1`}:{})});
  const removeFiles=job=>rm(join(directory,job.id),{recursive:true,force:true});
  const readyCount=()=>[...jobs.values()].filter(job=>job.status==='ready').length;
  const fail=async(job,error)=>{job.status='failed';job.error=error;job.controller?.abort();await removeFiles(job);};
  const prune=async()=>{
    const cutoff=Date.now()-60*60_000;
    while(globalStarts.length&&globalStarts[0]<cutoff)globalStarts.shift();
    for(const [id,entry]of accountStarts)if(entry.resetAt<Date.now())accountStarts.delete(id);
    let freedReadySlot=false;
    for(const [id,job]of jobs)if(!running.has(job.status)&&job.expiresAt<Date.now()){if(job.status==='ready')freedReadySlot=true;jobs.delete(id);await removeFiles(job);}
    if(freedReadySlot)void pump().catch(()=>{});
  };
  const interval=setInterval(()=>prune().catch(error=>console.error('Video download cleanup failed:',error.code||'filesystem error')),60_000);interval.unref();

  async function prepare(job) {
    const controller=new AbortController();job.controller=controller;job.status='fetching';
    const jobDirectory=join(directory,job.id);
    await mkdir(jobDirectory,{mode:0o700});
    const disk=await statfs(directory);
    if(disk.bavail*disk.bsize<1024*1024*1024)throw new Error('Downloads are temporarily unavailable because storage is low.');
    if(controller.signal.aborted)return;
    const proxy=await createDownloadProxy();
    if(controller.signal.aborted){proxy.close();return;}
    const timeout=setTimeout(()=>controller.abort(),8*60_000);timeout.unref();
    const metadataTimeout=setTimeout(()=>{if(job.status==='fetching')controller.abort();},90_000);metadataTimeout.unref();
    let monitoring=false,oversize=false;
    const watcher=setInterval(async()=>{
      if(monitoring)return;monitoring=true;
      try {
        const files=await readdir(jobDirectory);
        const sizes=await Promise.all(files.map(name=>stat(join(jobDirectory,name)).then(info=>info.size).catch(()=>0)));
        if(sizes.reduce((sum,size)=>sum+size,0)>MAX_BYTES*2+8*1024*1024){oversize=true;controller.abort();}
      }catch {/* Directory may be removed by cancellation. */}finally {monitoring=false;}
    },500);watcher.unref();
    try {
      await new Promise((accept,reject)=>{
        const runner=fileURLToPath(new URL('./videoDownloadRunner.py',import.meta.url));
        const python=process.env.GLEAN_VIDEO_PYTHON || 'python3';
        const child=spawn(python,[runner,job.url,jobDirectory,proxy.url],{cwd:jobDirectory,signal:controller.signal,detached:process.platform!=='win32',stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',HOME:jobDirectory,LANG:'C.UTF-8',GLEAN_VIDEO_NODE:process.execPath,PYTHONPATH:process.env.GLEAN_VIDEO_YTDLP || '/usr/local/lib/glean-video/yt-dlp.zip',...(process.env.FFMPEG_PATH?{FFMPEG_PATH:process.env.FFMPEG_PATH}:{}),...(process.env.SSL_CERT_FILE?{SSL_CERT_FILE:process.env.SSL_CERT_FILE}:process.platform==='darwin'&&existsSync('/etc/ssl/cert.pem')?{SSL_CERT_FILE:'/etc/ssl/cert.pem'}:{})}});
        const stop=()=>{if(child.pid&&process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{}}};
        controller.signal.addEventListener('abort',stop,{once:true});
        let buffer='',failed='';
        child.stdout.on('data',chunk=>{
          buffer+=chunk.toString();
          if(buffer.length>128*1024){controller.abort();return;}
          let newline;
          while((newline=buffer.indexOf('\n'))>=0){
            const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
            try {
              const event=JSON.parse(line);
              if(event.status==='failed')failed=clean(event.error,300);
              if(['downloading','processing'].includes(event.status)&&job.status!=='cancelled')job.status=event.status;
              if(event.title)job.title=clean(event.title);
              if(event.uploader)job.uploader=clean(event.uploader,120);
              if(Number.isFinite(event.duration))job.duration=event.duration;
              job.progress=Number.isFinite(event.progress)?Math.max(0,Math.min(99,event.progress)):null;
            }catch {/* Ignore non-event output from a library. */}
          }
        });
        child.on('error',error=>{stop();reject(new Error(error.code==='ENOENT'?'The video downloader is not installed on this server.':'Video preparation was interrupted. Please try again.'));});
        child.on('close',code=>{controller.signal.removeEventListener('abort',stop);code===0?accept():reject(new Error(failed || (oversize?'Video exceeds the 300 MB limit.':'This video could not be prepared. Try another link or retry later.')));});
      });
      if(job.status==='cancelled')return;
      const file=join(jobDirectory,'video.mp4'),info=await stat(file);
      if(!info.isFile()||info.size<=0||info.size>MAX_BYTES)throw new Error('Video exceeds the 300 MB limit or could not be downloaded.');
      job.file=file;job.size=info.size;job.status='ready';job.progress=100;job.expiresAt=Date.now()+TTL;
    }finally {clearTimeout(timeout);clearTimeout(metadataTimeout);clearInterval(watcher);proxy.close();job.controller=null;}
  }
  async function pump(){
    if(active)return;
    const job=[...jobs.values()].find(item=>item.status==='queued');
    if(!job||readyCount()>=3)return;
    active=true;
    try {await prepare(job);}catch(error){if(job.status!=='cancelled')await fail(job,clean(error.message,300));}
    finally {if(job.status==='cancelled')await removeFiles(job);active=false;void pump().catch(()=>{});}
  }
  return {async copyToPost(userId,id,uploadDirectory,storageName){
    await initialized;
    const unavailable=()=>Object.assign(new Error('This prepared video is unavailable or expired. Remove it and prepare the video again.'),{status:404});
    const job=jobs.get(id);
    if(!job||job.userId!==Number(userId))throw unavailable();
    if(job.status!=='ready'||job.expiresAt<=Date.now())throw unavailable();
    if(!/^[a-zA-Z0-9_-]+$/.test(storageName))throw new Error('Invalid media storage name.');
    if(copying)throw Object.assign(new Error('Media attachments are busy. Please try publishing again.'),{status:503});
    copying=true;
    const destination=join(uploadDirectory,storageName);
    let copied=false;
    try {
      const disk=await statfs(uploadDirectory);
      if(disk.bavail*disk.bsize<job.size+1024*1024*1024)throw Object.assign(new Error('Media storage is temporarily low. Please try again later.'),{status:503});
      await copyFile(job.file,destination,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);
      copied=true;
      await chmod(destination,0o600);
      const info=await stat(destination);
      if(job.status!=='ready'||job.expiresAt<=Date.now()||jobs.get(id)!==job)throw unavailable();
      if(!info.isFile()||info.size!==job.size||info.size<=0||info.size>MAX_BYTES)throw new Error('Prepared video could not be attached.');
      return {storageName,name:(clean(job.title,120)||'Glean video')+'.mp4',type:'video/mp4',size:info.size};
    }catch(error){
      if(copied)await rm(destination,{force:true});
      if(error.code==='ENOENT')throw unavailable();
      if(error.code==='ENOSPC')throw Object.assign(new Error('Media storage is temporarily full. Please try again later.'),{status:503});
      throw error;
    }finally{copying=false;}
  },async route(request,response,path){
    if(path!=='/api/video-downloads'&&!path.startsWith('/api/video-downloads/'))return false;
    const user=requireSignedInUser(request,response);if(!user)return true;
    await initialized;await prune();
    if(initializationError){sendJson(response,503,{error:'Video downloads are temporarily unavailable.'});return true;}
    const method=request.method;
    if(path==='/api/video-downloads'&&method==='POST'){
      let url;
      try {url=validateVideoUrl((await readJson(request,4096))?.url);}catch(error){sendJson(response,400,{error:error.message});return true;}
      if([...jobs.values()].some(job=>job.userId===Number(user.id)&&running.has(job.status))){sendJson(response,409,{error:'You already have a video being prepared.'});return true;}
      if([...jobs.values()].filter(job=>running.has(job.status)).length>=20){sendJson(response,503,{error:"Glean's video download queue is full. Please try again shortly."});return true;}
      const starts=accountStarts.get(Number(user.id)) || {count:0,resetAt:Date.now()+60*60_000};
      const retry=starts.count>=6?Math.max(1,Math.ceil((starts.resetAt-Date.now())/1000))
        :globalStarts.length>=20?Math.max(1,Math.ceil((globalStarts[0]+60*60_000-Date.now())/1000))
        :takeRateLimit(request,'video-download-ip',10,60*60_000);
      if(retry){sendJson(response,429,{error:'Download limit reached. Please try again later.'},{'Retry-After':String(retry)});return true;}
      starts.count++;accountStarts.set(Number(user.id),starts);globalStarts.push(Date.now());
      const job={id:randomUUID(),userId:Number(user.id),url,status:'queued',title:'Video',uploader:'',progress:null,expiresAt:Date.now()+TTL};jobs.set(job.id,job);
      // Keep queued work bounded; completed files have their own three-video cap.
      for(const [id,item]of jobs)if(jobs.size>64&&!running.has(item.status)&&item.status!=='ready')jobs.delete(id);
      sendJson(response,202,{job:visible(job)});void pump().catch(error=>console.error('Video worker failed:',error.code||'worker error'));return true;
    }
    if(path==='/api/video-downloads'&&method==='GET'){sendJson(response,200,{jobs:[...jobs.values()].filter(job=>job.userId===Number(user.id)).map(visible).reverse()});return true;}
    const match=path.match(/^\/api\/video-downloads\/([a-f0-9-]{36})(\/file)?$/);
    const job=match&&jobs.get(match[1]);
    if(!job||job.userId!==Number(user.id)){sendJson(response,404,{error:'Download not found or expired.'});return true;}
    if(match[2]&&['GET','HEAD'].includes(method)){
      if(job.status!=='ready'){sendJson(response,409,{error:'This video is not ready to download.'});return true;}
      const name=clean(job.title).replace(/[^\p{L}\p{N}\s._-]/gu,'').trim().slice(0,120)||'Glean video';
      const preview=new URL(request.url,'http://localhost').searchParams.get('preview')==='1';
      sendLocalFile(request,response,job.file,{type:'video/mp4',extra:{'Cache-Control':'private, no-store','Content-Disposition':`${preview?'inline':'attachment'}; filename="Glean-video.mp4"; filename*=UTF-8''${encodeURIComponent(name+'.mp4')}`}});return true;
    }
    if(!match[2]&&method==='GET'){sendJson(response,200,{job:visible(job)});return true;}
    if(!match[2]&&method==='DELETE'){
      const wasRunning=running.has(job.status);job.status='cancelled';job.controller?.abort();
      if(!wasRunning||!job.controller)await removeFiles(job);
      void pump().catch(()=>{});
      sendJson(response,200,{job:visible(job)});return true;
    }
    sendJson(response,405,{error:'Method not allowed.'});return true;
  }};
}
