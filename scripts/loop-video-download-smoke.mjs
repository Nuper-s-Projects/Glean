import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createVideoDownloadService } from '../server/videoDownloads.mjs';

const directory = await mkdtemp(join(tmpdir(), 'glean-media-smoke-'));
const uploads = join(directory, 'uploads');
const worker = join(directory, 'fixture-worker');
const previousWorker = process.env.GLEAN_VIDEO_PYTHON;
// This fixture tests file promotion and ownership, not provider extraction or
// video decoding. The browser integration separately uses a real playable MP4.
await mkdir(uploads);
await writeFile(worker, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const target=path.join(process.argv[4],'video.mp4');
fs.writeFileSync(target,Buffer.from('0000ftypfixture'));
if(process.argv[3].includes('large'))fs.truncateSync(target,101*1024*1024);
console.log(JSON.stringify({status:'processing',title:'Prepared video'}));
`, {mode:0o700});
process.env.GLEAN_VIDEO_PYTHON = worker;
const service = createVideoDownloadService({
  dataDirectory: directory,
  sendJson: (response,status,body) => Object.assign(response,{status,body}),
  readJson: async request => request.body,
  requireSignedInUser: request => ({id:request.userId}),
  takeRateLimit: () => 0,
});
const call = async (method,path,body,userId=1) => {
  const response = {};
  assert.equal(await service.route({method,url:path,body,userId},response,path),true);
  return response;
};
const prepare = async url => {
  const started = await call('POST','/api/video-downloads',{url});
  assert.equal(started.status,202);
  for (let attempts=0;attempts<100;attempts++) {
    const result = await call('GET',`/api/video-downloads/${started.body.job.id}`);
    if(result.body.job.status==='ready')return result.body.job;
    assert.notEqual(result.body.job.status,'failed',result.body.job.error);
    await delay(50);
  }
  throw new Error('Fixture worker timeout');
};
try {
  const job = await prepare('https://example.test/small.mp4');
  await assert.rejects(service.copyToPost(2,job.id,uploads,'other-account'),error=>error.status===404);
  await assert.rejects(service.copyToPost(1,'missing',uploads,'missing'),error=>error.status===404);
  await assert.rejects(service.copyToPost(1,job.id,uploads,'../unsafe'));
  const media = await service.copyToPost(1,job.id,uploads,'small-post');
  assert.equal(media.type,'video/mp4');
  assert.equal(media.size,job.size);
  assert.equal((await stat(join(uploads,media.storageName))).mode&0o777,0o600);
  const bytes = await readFile(join(uploads,media.storageName));
  await assert.rejects(service.copyToPost(1,job.id,uploads,'small-post'),error=>error.code==='EEXIST');
  assert.deepEqual(await readFile(join(uploads,media.storageName)),bytes);
  const clock = Date.now;
  try {
    Date.now = () => job.expiresAt+1;
    await assert.rejects(service.copyToPost(1,job.id,uploads,'expired'),error=>error.status===404);
  } finally { Date.now=clock; }
  await call('DELETE',`/api/video-downloads/${job.id}`);
  await assert.rejects(service.copyToPost(1,job.id,uploads,'cancelled'),error=>error.status===404);
  assert.deepEqual(await readFile(join(uploads,media.storageName)),bytes,'Published copy survives job removal');
  const large = await prepare('https://example.test/large.mp4');
  const [copied,busy] = await Promise.allSettled([
    service.copyToPost(1,large.id,uploads,'large-post'),
    service.copyToPost(1,large.id,uploads,'busy-post'),
  ]);
  assert.equal(copied.status,'fulfilled');
  assert.equal(busy.status,'rejected');
  assert.equal(busy.reason.status,503,'Concurrent large copies apply backpressure');
  const largeMedia = copied.value;
  assert.equal(largeMedia.size,101*1024*1024,'Prepared media can exceed the normal browser upload limit');
  await call('DELETE',`/api/video-downloads/${large.id}`);
  assert.equal((await stat(join(uploads,largeMedia.storageName))).size,largeMedia.size);
  console.log('PASS prepared-video promotion: owner/expiry/cancellation guards, exclusive private copies, persistence after job removal and >100 MB server-side attachment. Fixture worker used.');
} finally {
  if(previousWorker===undefined)delete process.env.GLEAN_VIDEO_PYTHON;
  else process.env.GLEAN_VIDEO_PYTHON=previousWorker;
  await rm(directory,{recursive:true,force:true});
}
