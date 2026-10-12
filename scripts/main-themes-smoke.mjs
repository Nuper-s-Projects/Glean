import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { createMainThemeService } from '../server/mainThemes.mjs';
import { sendLocalFile } from '../server/files.mjs';
import { encodeBase32 } from '../src/app/base32.js';
import { randomBytes } from 'node:crypto';
import { MAIN_THEME_PRESETS, MAX_CUSTOM_THEMES, normalizeMainTheme, normalizeMainThemes, selectedMainTheme, mainThemeBackdropStyle } from '../src/app/mainTheme.js';

const gradient = { name: 'Custom', kind: 'gradient', from: '#123456', to: '#654321', angle: 125 };
assert.equal(MAIN_THEME_PRESETS.length, 6);
assert.ok(MAIN_THEME_PRESETS.every(normalizeMainTheme));
for (const bad of [null, [], { ...gradient, kind: 'solid' }, { ...gradient, from: '#fff' }, { ...gradient, to: gradient.from }, { ...gradient, angle: '125' }, { ...gradient, angle: 361 }, { ...gradient, name: ' ' }, { ...gradient, name: 'x'.repeat(41) }, { name: 'Photo', kind: 'image', imageUrl: 'https://example.com/a.jpg' }]) assert.equal(normalizeMainTheme(bad), null);
assert.deepEqual(normalizeMainThemes('invalid'), { active: null, custom: [] });
assert.equal(selectedMainTheme({ active: 'missing', custom: [] }), null);
assert.deepEqual(mainThemeBackdropStyle({ name: 'No', kind: 'image', imageUrl: 'url("evil")' }), {});
assert.ok(mainThemeBackdropStyle({ ...gradient, name: '' })['--glean-theme-background']);

const directory = mkdtempSync('/tmp/glean-main-themes-test-');
const db = new DatabaseSync(join(directory, 'test.sqlite'));
db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY,main_theme_json TEXT) STRICT;INSERT INTO users VALUES(1,NULL),(2,NULL)');
const sendJson = (response, status, body, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json', ...headers }); response.end(JSON.stringify(body)); };
const handle = createMainThemeService({
  database: db, uploadDirectory: directory, sendJson, sendLocalFile,
  requireSignedInUser: (request, response) => { const user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(request.headers['x-test-user'])); if (!user) sendJson(response, 401, { error: 'Not signed in.' }); return user; },
  readJson: async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); },
  takeRateLimit: () => 0, randomBase32: length => encodeBase32(randomBytes(length)),
  removeStoredUploads: names => { for (const name of names) if (existsSync(join(directory, name))) unlinkSync(join(directory, name)); },
  publicAccount: user => ({ id: user.id, mainThemes: normalizeMainThemes(user.main_theme_json) }),
});
const server = createServer(async (request, response) => {
  try { if (!await handle(request, response, new URL(request.url, 'http://localhost').pathname, request.method)) sendJson(response, 404, { error: 'Not found.' }); }
  catch (error) { sendJson(response, 500, { error: error.message }); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (input, user = 1, expected = 200) => {
  const response = await fetch(base + '/api/account/theme', { method: 'POST', headers: { 'x-test-user': String(user), ...(input instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: input instanceof FormData ? input : JSON.stringify(input) });
  const payload = await response.json(); assert.equal(response.status, expected, JSON.stringify(payload)); return payload.account?.mainThemes;
};
const photo = await sharp({ create: { width: 1800, height: 1000, channels: 3, background: '#689aca' } }).png().toBuffer();
const upload = (theme = { name: 'Photo', blur: 100, saturation: 175, contrast: 120 }, bytes = photo) => { const form = new FormData(); form.append('background', new Blob([bytes], { type: 'image/png' }), 'test.png'); form.append('adjustments', JSON.stringify(theme)); return form; };
try {
  await post({ action: 'select', id: MAIN_THEME_PRESETS[0].id }, 0, 401);
  let prefs = await post({ action: 'select', id: MAIN_THEME_PRESETS[0].id }); assert.equal(prefs.active, MAIN_THEME_PRESETS[0].id);
  await post({ action: 'select', id: 'missing' }, 1, 400);
  prefs = await post({ action: 'save', theme: gradient }); const customId = prefs.active;
  prefs = await post({ action: 'select', id: MAIN_THEME_PRESETS[1].id }); assert.equal(prefs.custom[0].id, customId);
  prefs = await post({ action: 'save', theme: { ...gradient, id: customId, name: 'Edited', angle: 360 } }); assert.equal(prefs.custom.length, 1);
  assert.equal(prefs.custom[0].angle, 360);
  await post({ action: 'save', theme: { ...gradient, kind: 'solid' } }, 1, 400);
  prefs = await post(upload()); const imageTheme = prefs.custom.find(theme => theme.id === prefs.active); const imageId = imageTheme.id;
  const imagePath = imageTheme.imageUrl.replace('/api/v1', '/api');
  const imageResponse = await fetch(base + imagePath, { headers: { 'x-test-user': '1' } }); assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get('cache-control'), /^private/);
  assert.equal(imageResponse.headers.get('vary'), 'Cookie');
  const metadata = await sharp(Buffer.from(await imageResponse.arrayBuffer())).metadata(); assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 1600);
  const etag = imageResponse.headers.get('etag'); assert.equal((await fetch(base + imagePath, { headers: { 'x-test-user': '1', 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(base + imagePath, { headers: { 'x-test-user': '2' } })).status, 404);
  assert.equal((await fetch(base + imagePath)).status, 401);
  await post({ action: 'save', theme: imageTheme }, 2, 400);
  await post({ action: 'save', theme: { ...imageTheme, id: undefined } }, 2, 400);
  await post({ action: 'save', theme: { ...imageTheme, blur: 101 } }, 1, 400);
  await post(upload({ name: 'Bad', blur: 101 }), 1, 400);
  await post(upload({ name: 'Bad' }, Buffer.from('not a photo')), 1, 400);
  prefs = await post({ action: 'save', theme: { ...imageTheme, blur: 0, contrast: 0, saturation: 200 } }); assert.equal(prefs.custom.find(theme => theme.id === imageId).blur, 0);
  await post({ action: 'select', id: null }); assert.equal((await fetch(base + imagePath, { headers: { 'x-test-user': '1' } })).status, 200, 'reset preserves saved photos');
  prefs = await post(upload({ name: 'Replacement', id: imageId, blur: 5 }));
  assert.equal((await fetch(base + imagePath, { headers: { 'x-test-user': '1' } })).status, 404, 'replaced photos are removed');
  const replacementPath = prefs.custom.find(theme => theme.id === imageId).imageUrl.replace('/api/v1', '/api');
  prefs = await post({ action: 'delete', id: imageId }); assert.equal(prefs.active, null);
  assert.equal((await fetch(base + replacementPath, { headers: { 'x-test-user': '1' } })).status, 404);
  await Promise.all([post({ action: 'save', theme: { ...gradient, name: 'Concurrent one' } }), post({ action: 'save', theme: { ...gradient, name: 'Concurrent two' } })]);
  prefs = normalizeMainThemes(db.prepare('SELECT main_theme_json FROM users WHERE id=1').get().main_theme_json);
  assert.ok(prefs.custom.some(theme => theme.name === 'Concurrent one') && prefs.custom.some(theme => theme.name === 'Concurrent two'));
  while (prefs.custom.length < MAX_CUSTOM_THEMES) prefs = await post({ action: 'save', theme: { ...gradient, name: `Theme ${prefs.custom.length}` } });
  await post({ action: 'save', theme: gradient }, 1, 400);
  prefs = await post({ action: 'save', theme: { ...prefs.custom[0], name: 'At limit edit' } }); assert.equal(prefs.custom.length, MAX_CUSTOM_THEMES);
  await post(null, 1, 400);
  console.log('Main themes: presets, persistence, custom library, concurrent saves, photo sanitization, adjustment bounds, private media, ETag caching, replacement/deletion cleanup, and library limits passed.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); }
