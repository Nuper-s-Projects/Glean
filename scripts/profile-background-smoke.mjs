import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { readProfileBackgroundImage } from '../server/profileBackground.mjs';
import { PROFILE_BACKGROUND_MAX_BYTES, PROFILE_BACKGROUND_URL, profileImageAdjustments } from '../src/app/profileBackground.js';

assert.deepEqual(profileImageAdjustments(), { contrast: 100, saturation: 100, blur: 25 });
assert.deepEqual(profileImageAdjustments({ contrast: 0, saturation: 200, blur: 100 }, true), { contrast: 0, saturation: 200, blur: 100 });
for (const value of [-1, 101, Infinity, NaN, '25', null]) assert.equal(profileImageAdjustments({ blur: value }, true), null);
assert.equal(profileImageAdjustments({ saturation: 201 }, true), null);
assert.equal(profileImageAdjustments({ contrast: -1 }, true), null);
assert.deepEqual(profileImageAdjustments({ blur: 400, contrast: -50, saturation: NaN }), { blur: 100, contrast: 0, saturation: 100 });
assert.ok(PROFILE_BACKGROUND_URL.test('/api/v1/profile-backgrounds/profile-background-abc234.jpg'));
for (const url of ['https://example.com/test.jpg', '/api/v1/banners/banner-abc234.jpg', '/api/v1/profile-backgrounds/../../secret', 'blob:abc']) assert.equal(PROFILE_BACKGROUND_URL.test(url), false);

const server = createServer(async (request, response) => {
  try {
    const output = await readProfileBackgroundImage(request);
    const metadata = await sharp(output.bytes).metadata();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ adjustments: output.adjustments, format: metadata.format, width: metadata.width, height: metadata.height }));
  } catch (error) { response.writeHead(400); response.end(error.message); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const png = await sharp({ create: { width: 1800, height: 900, channels: 3, background: '#186fa3' } }).png().toBuffer();
const submit = async (bytes, type, adjustments = { contrast: 125, saturation: 70, blur: 100 }, extra = false) => {
  const form = new FormData();
  form.append('background', new Blob([bytes], { type }), 'background');
  form.append('adjustments', JSON.stringify(adjustments));
  if (extra) form.append('background', new Blob([bytes], { type }), 'second');
  return fetch(url, { method: 'POST', body: form });
};
try {
  const result = await submit(png, 'image/png');
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), { adjustments: { contrast: 125, saturation: 70, blur: 100 }, format: 'jpeg', width: 1600, height: 800 });
  assert.equal((await submit(await sharp(png).jpeg().toBuffer(), 'image/jpeg')).status, 200);
  assert.equal((await submit(await sharp(png).webp().toBuffer(), 'image/webp')).status, 200);
  assert.equal((await submit(png, 'image/png', { blur: 101 })).status, 400);
  assert.equal((await submit(png, 'image/png', null)).status, 400);
  assert.equal((await submit(Buffer.from('not an image'), 'image/png')).status, 400);
  assert.equal((await submit(png, 'image/gif')).status, 400);
  assert.equal((await submit(png, 'image/png', {}, true)).status, 400);
  assert.equal((await submit(Buffer.alloc(PROFILE_BACKGROUND_MAX_BYTES + 1), 'image/png')).status, 400);
  const jpeg = await sharp(png).jpeg().toBuffer();
  assert.equal((await submit(Buffer.concat([jpeg, Buffer.alloc(PROFILE_BACKGROUND_MAX_BYTES - jpeg.length)]), 'image/jpeg')).status, 200, 'exactly 8 MB is allowed');
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: 'invalid' })).status, 400);
  assert.equal((await submit(png, 'image/png', { blur: 0 })).status, 200, 'server remains healthy after rejected uploads');
  console.log('Profile background validation, bounded uploads, image sanitization, resizing, and adjustment limits passed.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
