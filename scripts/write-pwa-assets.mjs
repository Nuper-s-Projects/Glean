import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const dist = resolve('dist');
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && !['sw.js', 'pwa-assets.json'].includes(entry.name)) files.push(path);
  }
}

await walk(dist);
files.sort();
const hash = createHash('sha256');
const assets = [];
for (const path of files) {
  const bytes = await readFile(path);
  const url = `/${relative(dist, path).split('\\').join('/')}`;
  hash.update(url).update('\0').update(bytes);
  if (url !== '/index.html') assets.push(url);
}

// Worker-only changes must also advance the cache version and activate the update.
hash.update(await readFile(join(dist, 'sw.js'), 'utf8'));
const version = hash.digest('hex').slice(0, 16);
await writeFile(join(dist, 'pwa-assets.json'), JSON.stringify({ version, assets }));
const workerPath = join(dist, 'sw.js');
const worker = await readFile(workerPath, 'utf8');
if (!worker.includes('__GLEAN_PWA_VERSION__')) throw new Error('Service worker version placeholder is missing.');
await writeFile(workerPath, worker.replace('__GLEAN_PWA_VERSION__', version));
