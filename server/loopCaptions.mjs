import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
const MAX_SECONDS = 1800;

export function captionCues(data, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video duration.');
  if (!Array.isArray(data?.segments) && !Array.isArray(data?.words)) throw new Error('Transcription did not include timestamps.');
  const rawSegments = Array.isArray(data.segments) ? data.segments.filter(segment => segment && typeof segment === 'object') : [];
  const rawWords = Array.isArray(data.words) ? data.words.filter(word => word && typeof word === 'object') : [];
  const segments = rawSegments.flatMap(segment => {
    const start = Number(segment.start), end = Math.min(Number(segment.end), duration);
    const text = String(segment.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text || Number(segment.no_speech_prob) > .8) return [];
    return [{ start, end, text }];
  }).sort((a, b) => a.start - b.start).slice(0, 10000);
  const silence = rawSegments.filter(segment => Number(segment.no_speech_prob) > .8).map(segment => ({start:Number(segment.start),end:Number(segment.end)})).sort((a,b)=>a.start-b.start);
  const words = rawWords.flatMap(word => {
    const start = Number(word.start), end = Math.min(Number(word.end), duration);
    const text = String(word.word || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && text ? [{start,end,text}] : [];
  }).sort((a,b)=>a.start-b.start).slice(0, 20000);
  let silenceIndex = 0;
  const spoken = words.filter(word => {
    while (silenceIndex < silence.length && silence[silenceIndex].end <= word.start) silenceIndex++;
    return !silence[silenceIndex] || word.start < silence[silenceIndex].start || word.start >= silence[silenceIndex].end;
  });
  // Some Whisper responses omit punctuation from the word list. Restore it
  // from matching transcript tokens while retaining the real word timings.
  const tokens = segments.flatMap(segment => segment.text.match(/\S+/gu) || []).slice(0,20000);
  const normalized = text => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  let tokenIndex = 0;
  for (const word of spoken) {
    for (let index=tokenIndex; index<Math.min(tokenIndex+6,tokens.length); index++) {
      if (normalized(word.text) !== normalized(tokens[index])) continue;
      word.text=tokens[index]; tokenIndex=index+1; break;
    }
  }
  const groups = [];
  let group = null;
  const joinText = (left,right) => /^[,.;:!?，。！？、]/u.test(right) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(right) ? left + right : `${left} ${right}`;
  for (const word of spoken) {
    // Break at pauses, sentence endings, or a readable phrase length, not a
    // guessed fraction of the complete speech segment.
    const sentenceEnd = group && /[.!?。！？]["'”’)]?$/u.test(group.text) && group.end-group.start >= .7;
    const split = group && word.start > group.start && (word.start-group.end >= .45 || sentenceEnd || word.end-group.start > 3.5 || group.count >= 10 || joinText(group.text,word.text).length > 64);
    if (!group || split) { group={start:word.start,end:word.end,text:word.text,count:1}; groups.push(group); }
    else { group.end=Math.max(group.end,word.end); group.text=joinText(group.text,word.text); group.count++; }
  }
  const source = groups.length ? groups : segments;
  return source.flatMap((cue,index) => {
    const next = source[index+1];
    const start = Math.max(0,cue.start - (groups.length ? .04 : 0));
    // Small reading-time padding, capped before the next phrase. No overlap,
    // no lingering through a long silence, and never past the video ending.
    const end = Math.min(duration,next ? Math.max(0,next.start - (groups.length ? .04 : 0)) : duration,
      groups.length ? Math.min(Math.max(cue.end+.16,start+.8),cue.end+.6) : cue.end);
    return end > start ? [{start,end,text:cue.text}] : [];
  }).slice(0,10000);
}

export function captionVtt(cues) {
  const time = seconds => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return 'WEBVTT\n\n' + cues.map((cue, index) => `${index + 1}\n${time(cue.start)} --> ${time(cue.end)}\n${escape(cue.text)}\n`).join('\n');
}

export function createLoopCaptions({ database, uploadDirectory, realtimeHub, apiKey = process.env.GROQ_API_KEY || '', model = process.env.GLEAN_CAPTION_MODEL || 'whisper-large-v3', fetchImpl = fetch, run = execute, ffmpeg = process.env.GLEAN_CAPTION_FFMPEG || '/usr/bin/ffmpeg', ffprobe = process.env.GLEAN_CAPTION_FFPROBE || '/usr/bin/ffprobe', autoStart = true }) {
  database.exec(`CREATE TABLE IF NOT EXISTS loop_media_captions (
    media_id INTEGER PRIMARY KEY REFERENCES loop_post_media(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('queued','processing','ready','empty','failed')),
    cues_json TEXT NOT NULL DEFAULT '[]', language TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT; CREATE INDEX IF NOT EXISTS loop_caption_queue_idx ON loop_media_captions(status,media_id);`);
  // Interrupted jobs remain durable and resume after a service restart.
  database.prepare("UPDATE loop_media_captions SET status='failed',error='Caption retry limit reached for this video.' WHERE status='processing' AND attempts>=3").run();
  database.prepare("UPDATE loop_media_captions SET status='queued' WHERE status='processing'").run();
  const available = () => Boolean(apiKey.trim() && existsSync(ffmpeg) && existsSync(ffprobe));
  const transcriptionModel = ['whisper-large-v3', 'whisper-large-v3-turbo'].includes(model) ? model : 'whisper-large-v3';
  const get = id => database.prepare('SELECT * FROM loop_media_captions WHERE media_id=?').get(id);
  const statusFor = (id, row) => {
    return row ? { status: row.status, language: row.language || 'und', error: row.error || null, url: row.status === 'ready' ? `/api/v1/loop/media/${id}/captions.vtt` : null } : null;
  };
  const publicStatus = id => statusFor(id, get(id));
  const publicStatuses = ids => {
    if (!ids.length) return new Map();
    return new Map(database.prepare(`SELECT media_id,status,language,error FROM loop_media_captions WHERE media_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      .map(row => [Number(row.media_id), statusFor(Number(row.media_id), row)]));
  };
  const canQueue = userId => {
    if (!available()) return { status: 503, error: 'Auto captions are temporarily unavailable. Turn off auto captions to publish.' };
    const counts = database.prepare(`SELECT COUNT(*) total, SUM(c.status IN ('queued','processing')) pending FROM loop_media_captions c JOIN loop_post_media m ON m.id=c.media_id JOIN loop_posts p ON p.id=m.post_id WHERE p.user_id=? AND datetime(c.created_at)>=datetime('now','-1 day')`).get(userId);
    if (Number(counts.total) >= 10 || Number(counts.pending) >= 3) return { status: 429, error: 'Caption limit reached. Try later, or publish with auto captions off.' };
    if (Number(database.prepare("SELECT COUNT(*) n FROM loop_media_captions WHERE status IN ('queued','processing')").get().n) >= 50) return { status: 429, error: 'The caption queue is busy. Try later, or publish with auto captions off.' };
    return null;
  };
  const queue = (id, now) => database.prepare("INSERT INTO loop_media_captions(media_id,status,created_at,updated_at) VALUES(?,'queued',?,?)").run(id, now, now);
  let busy = false;
  async function drain() {
    if (busy || !available()) return;
    busy = true;
    try {
      database.exec("DELETE FROM loop_media_captions WHERE media_id IN (SELECT m.id FROM loop_post_media m JOIN loop_posts p ON p.id=m.post_id WHERE p.deleted_at IS NOT NULL)");
      for (;;) {
        const job = database.prepare(`SELECT c.*,m.storage_name,m.post_id FROM loop_media_captions c JOIN loop_post_media m ON m.id=c.media_id JOIN loop_posts p ON p.id=m.post_id WHERE c.status='queued' AND p.deleted_at IS NULL ORDER BY c.media_id LIMIT 1`).get();
        if (!job) break;
        let temp;
        database.prepare("UPDATE loop_media_captions SET status='processing',attempts=attempts+1,updated_at=? WHERE media_id=?").run(new Date().toISOString(), job.media_id);
        try {
          const source = resolve(uploadDirectory, job.storage_name);
          if (dirname(source) !== resolve(uploadDirectory)) throw new Error('The video file is unavailable.');
          const probe = await run(ffprobe, ['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-show_entries','format=duration:stream=codec_type','-of','json',source], { timeout: 30000, maxBuffer: 1024 * 1024 });
          const info = JSON.parse(probe.stdout);
          const duration = Number(info.format?.duration);
          if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS) throw new Error('Auto captions support videos up to 30 minutes.');
          if (!info.streams?.some(stream => stream.codec_type === 'audio')) throw new Error('This video has no audio track.');
          temp = await mkdtemp(join(tmpdir(),'glean-captions-'));
          const audio = join(temp,'audio.mp3');
          await run(ffmpeg, ['-nostdin','-v','error','-threads','1','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-i',source,'-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','48k','-threads','1','-t',String(MAX_SECONDS),audio], { timeout: 180000, maxBuffer: 1024 * 1024 });
          // Recheck deletion before sending audio to the provider.
          if (!database.prepare('SELECT 1 FROM loop_posts WHERE id=? AND deleted_at IS NULL').get(job.post_id)) { database.prepare('DELETE FROM loop_media_captions WHERE media_id=?').run(job.media_id); continue; }
          const bytes = await readFile(audio);
          if (bytes.length > 24 * 1024 * 1024) throw new Error('The audio is too large for auto captions.');
          const form = new FormData();
          form.set('file',new Blob([bytes],{type:'audio/mpeg'}),'audio.mp3');
          form.set('model',transcriptionModel); form.set('response_format','verbose_json'); form.append('timestamp_granularities[]','word'); form.append('timestamp_granularities[]','segment'); form.set('temperature','0');
          const response = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form,signal:AbortSignal.timeout(120000)});
          if (!response.ok) throw new Error('Caption service could not process the audio. Please retry later.');
          const data = await response.json();
          const cues = captionCues(data,duration);
          database.prepare("UPDATE loop_media_captions SET status=?,cues_json=?,language=?,error='',updated_at=? WHERE media_id=?").run(cues.length ? 'ready' : 'empty',JSON.stringify(cues),String(data.language || 'und').slice(0,32),new Date().toISOString(),job.media_id);
        } catch (error) {
          const known = ['Auto captions support videos up to 30 minutes.','This video has no audio track.','Caption service could not process the audio. Please retry later.','The audio is too large for auto captions.'];
          database.prepare("UPDATE loop_media_captions SET status='failed',error=?,updated_at=? WHERE media_id=?").run(known.includes(error.message) ? error.message : 'Captions could not be generated. Please retry later.',new Date().toISOString(),job.media_id);
        } finally {
          if (temp) await rm(temp,{recursive:true,force:true});
        }
        realtimeHub.broadcastAll('loop-post-updated',{postId:Number(job.post_id)});
      }
    } finally { busy = false; }
  }
  if (autoStart) { const timer = setInterval(() => { drain().catch(() => console.error('Loop caption queue failed.')); },15000); timer.unref(); }
  return { available, publicStatus, publicStatuses, canQueue, queue, get, drain, kick: () => { if (autoStart) setImmediate(() => drain().catch(() => console.error('Loop caption queue failed.'))); } };
}
