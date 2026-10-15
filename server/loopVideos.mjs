import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const inputFormats = 'mov,matroska,webm,avi,ogg,mpeg,mpegts,flv';
const findBinary = name => [`/usr/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find(existsSync) || `/usr/bin/${name}`;
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createLoopVideos({ database, uploadDirectory, realtimeHub, run = execute,
  ffmpeg = process.env.GLEAN_VIDEO_FFMPEG || findBinary('ffmpeg'), ffprobe = process.env.GLEAN_VIDEO_FFPROBE || findBinary('ffprobe'), autoStart = true }) {
  database.exec(`CREATE TABLE IF NOT EXISTS loop_media_playback (
    media_id INTEGER PRIMARY KEY REFERENCES loop_post_media(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('queued','processing','ready','failed')),
    storage_name TEXT, size_bytes INTEGER, width INTEGER, height INTEGER, duration REAL,
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS loop_playback_queue_idx ON loop_media_playback(status,media_id);`);
  database.prepare("UPDATE loop_media_playback SET status='failed',error='Video preparation was interrupted. Please retry.' WHERE status='processing' AND attempts>=3").run();
  database.prepare("UPDATE loop_media_playback SET status='queued' WHERE status='processing'").run();
  const get = database.prepare('SELECT * FROM loop_media_playback WHERE media_id=?');
  const media = database.prepare("SELECT m.*,p.user_id FROM loop_post_media m JOIN loop_posts p ON p.id=m.post_id WHERE m.id=? AND p.deleted_at IS NULL AND m.mime_type LIKE 'video/%'");
  const next = database.prepare("SELECT c.*,m.storage_name source_name,m.post_id FROM loop_media_playback c JOIN loop_post_media m ON m.id=c.media_id JOIN loop_posts p ON p.id=m.post_id WHERE c.status='queued' AND p.deleted_at IS NULL ORDER BY c.updated_at,c.media_id LIMIT 1");
  const live = database.prepare('SELECT 1 FROM loop_post_media m JOIN loop_posts p ON p.id=m.post_id WHERE m.id=? AND p.deleted_at IS NULL');
  const available = () => existsSync(ffmpeg) && existsSync(ffprobe);
  const safePath = name => {
    const path = resolve(uploadDirectory, name || '');
    if (dirname(path) !== resolve(uploadDirectory)) throw fail(404, 'Video unavailable.');
    return path;
  };
  let busy = false, closed = false, task = Promise.resolve(), controller;
  const statusFor = (id, row) => {
    return row ? { status: row.status, error: row.error || null, url: row.status === 'ready' ? `/api/v1/loop/media/${id}/playback.mp4` : null,
      mimeType: 'video/mp4', width: row.width, height: row.height, duration: row.duration, retryable: row.status === 'failed' && row.attempts < 3 }
      : { status: 'pending', url: null, error: null };
  };
  const publicStatus = id => statusFor(id, get.get(id));
  const publicStatuses = ids => {
    if (!ids.length) return new Map();
    const rows = new Map(database.prepare(`SELECT * FROM loop_media_playback WHERE media_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(row => [Number(row.media_id), row]));
    return new Map(ids.map(id => [id, statusFor(id, rows.get(id))]));
  };
  const queue = (id, now = new Date().toISOString(), retry = false) => {
    if (closed || !available()) throw fail(503, 'Video preparation is temporarily unavailable. Please try again.');
    if (!media.get(id)) throw fail(404, 'Video unavailable.');
    const record = get.get(id);
    if (record?.status === 'ready' && !existsSync(safePath(record.storage_name))) {
      database.prepare('DELETE FROM loop_media_playback WHERE media_id=?').run(id);
    } else if (record?.status === 'failed' && retry) {
      if (record.attempts >= 3) throw fail(422, 'This video could not be converted. The uploader can try uploading a new copy.');
      database.prepare("UPDATE loop_media_playback SET status='queued',error='',updated_at=? WHERE media_id=?").run(now,id);
      return publicStatus(id);
    } else if (record) return publicStatus(id);
    if (Number(database.prepare("SELECT COUNT(*) n FROM loop_media_playback WHERE status IN ('queued','processing')").get().n) >= 100) throw fail(429, 'Video preparation is busy. Please try again shortly.');
    database.prepare("INSERT OR IGNORE INTO loop_media_playback(media_id,status,created_at,updated_at) VALUES(?,'queued',?,?)").run(id,now,now);
    return publicStatus(id);
  };
  const probe = (path, signal) => run(ffprobe, ['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',inputFormats,'-show_streams','-show_format','-of','json',path], { timeout: 30000, maxBuffer: 1024 * 1024, signal, killSignal: 'SIGKILL' }).then(result => JSON.parse(result.stdout));
  async function drain() {
    if (busy || closed || !available()) return;
    busy = true;
    try {
      for (;;) {
        if (closed) break;
        const job = next.get();
        if (!job) break;
        controller = new AbortController();
        const partial = join(uploadDirectory, `loop-playback-${job.media_id}.partial.mp4`);
        const storageName = `loop-playback-${job.media_id}-v1.mp4`, output = join(uploadDirectory, storageName);
        database.prepare("UPDATE loop_media_playback SET status='processing',attempts=attempts+1,updated_at=? WHERE media_id=?").run(new Date().toISOString(),job.media_id);
        try {
          await rm(partial,{force:true});
          const source = safePath(job.source_name);
          const storage = await statfs(uploadDirectory), sourceSize = (await stat(source)).size;
          if (storage.bavail * storage.bsize < 512 * 1024 * 1024 + Math.min(200 * 1024 * 1024,sourceSize * 3)) throw Error('Insufficient video storage');
          const info = await probe(source, controller.signal);
          const video = info.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
          const duration = Number(info.format?.duration || video?.duration);
          if (!video || !Number.isFinite(duration) || duration <= 0 || video.width > 8192 || video.height > 8192) throw Error('Invalid video stream');
          const sourceRate = String(video.avg_frame_rate || '30/1');
          const [a,b] = sourceRate.split('/').map(Number);
          const fps = a / (b || 1);
          const rate = Number.isFinite(fps) && fps > 0 && fps <= 30 ? sourceRate : '30';
          const maxrate = Math.max(64000,Math.min(8000000,Math.floor(200 * 1024 * 1024 * 8 / duration)));
          const filters = [];
          if (['smpte2084','arib-std-b67'].includes(video.color_transfer)) filters.push('zscale=t=linear:npl=100','format=gbrpf32le','zscale=p=bt709','tonemap=tonemap=hable:desat=0','zscale=t=bt709:m=bt709:r=tv');
          filters.push('scale=trunc(iw*sar/2)*2:trunc(ih/2)*2','setsar=1',"scale=w='if(gte(iw,ih),min(iw,1920),min(iw,1080))':h='if(gte(iw,ih),min(ih,1080),min(ih,1920))':force_original_aspect_ratio=decrease:force_divisible_by=2",'format=yuv420p');
          if (video.field_order && video.field_order !== 'progressive' && video.field_order !== 'unknown') filters.unshift('bwdif');
          const sourceAudio = info.streams?.find(item => item.codec_type === 'audio');
          const copy = video.codec_name === 'h264' && video.pix_fmt === 'yuv420p' && video.level <= 41 && fps > 0 && fps <= 30
            && Math.max(video.width,video.height) <= 1920 && Math.min(video.width,video.height) <= 1080
            && !filters.includes('bwdif') && (!sourceAudio || (sourceAudio.codec_name === 'aac' && sourceAudio.channels <= 2));
          const encoding = copy ? ['-c:v','copy','-c:a','copy'] : ['-vf',filters.join(','),'-c:v','libx264','-preset','veryfast','-crf','22','-profile:v','baseline','-level:v','4.0',
            '-pix_fmt','yuv420p','-r',String(rate),'-fps_mode','cfr','-maxrate',String(maxrate),'-bufsize',String(maxrate * 2),'-threads','1',
            '-c:a','aac','-profile:a','aac_low','-b:a','128k','-ar','48000','-ac','2'];
          await run(ffmpeg, ['-nostdin','-hide_banner','-v','error','-y','-threads','1','-filter_threads','1','-filter_complex_threads','1',
            '-protocol_whitelist','file,pipe','-format_whitelist',inputFormats,'-i',source,'-map','0:V:0','-map','0:a:0?',
            '-sn','-dn','-map_metadata','-1',...encoding,'-movflags','+faststart','-max_muxing_queue_size','1024','-fs',String(256 * 1024 * 1024),partial],
          { timeout: Math.max(120000,Math.min(1800000,duration * 2000)), maxBuffer: 2 * 1024 * 1024, signal: controller.signal, killSignal: 'SIGKILL' });
          const checked = await probe(partial, controller.signal), stream = checked.streams?.find(item => item.codec_type === 'video');
          const audio = checked.streams?.find(item => item.codec_type === 'audio'), size = (await stat(partial)).size;
          if (!size || stream?.codec_name !== 'h264' || stream.pix_fmt !== 'yuv420p' || (audio && audio.codec_name !== 'aac') || Number(checked.format?.duration) < duration - .5) throw Error('Invalid playback output');
          if (closed) break;
          if (!live.get(job.media_id) || !get.get(job.media_id)) continue;
          await rename(partial,output);
          const published = database.prepare("UPDATE loop_media_playback SET status='ready',storage_name=?,size_bytes=?,width=?,height=?,duration=?,error='',updated_at=? WHERE media_id=? AND EXISTS(SELECT 1 FROM loop_post_media m JOIN loop_posts p ON p.id=m.post_id WHERE m.id=? AND p.deleted_at IS NULL)").run(storageName,size,stream.width,stream.height,Number(checked.format?.duration) || duration,new Date().toISOString(),job.media_id,job.media_id);
          if (!published.changes) await rm(output,{force:true});
        } catch (failure) {
          if (!closed) {
            console.error(`Loop video ${job.media_id} preparation failed (${failure.code || failure.name}).`);
            database.prepare("UPDATE loop_media_playback SET status='failed',error='This video could not be prepared. Please retry or upload a new copy.',updated_at=? WHERE media_id=?").run(new Date().toISOString(),job.media_id);
          }
        } finally { await rm(partial,{force:true}); controller = null; }
        if (!closed) realtimeHub.broadcastAll('loop-post-updated',{postId:Number(job.post_id)});
      }
    } finally { busy = false; }
  }
  const kick = () => { if (autoStart && !busy && !closed) task = drain().catch(() => console.error('Loop video queue failed.')); };
  const timer = autoStart ? setInterval(kick,15000) : null;
  timer?.unref();
  if (autoStart) setImmediate(kick);
  const removePost = async postId => {
    const rows = database.prepare('SELECT c.storage_name FROM loop_media_playback c JOIN loop_post_media m ON m.id=c.media_id WHERE m.post_id=?').all(postId);
    database.prepare('DELETE FROM loop_media_playback WHERE media_id IN (SELECT id FROM loop_post_media WHERE post_id=?)').run(postId);
    await Promise.all(rows.filter(row => row.storage_name).map(row => rm(safePath(row.storage_name),{force:true})));
  };
  return { available, publicStatus, publicStatuses, queue, kick, drain, removePost, file: id => { const row = get.get(id); return row?.status === 'ready' ? safePath(row.storage_name) : null; },
    close: async () => { closed = true; clearInterval(timer); controller?.abort(); await task; } };
}
