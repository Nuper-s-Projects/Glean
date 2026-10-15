import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = dirname(require.resolve('emojibase-data/package.json'));
const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
// Versioned local data avoids a third-party CDN request when opening the picker.
const target = resolve('public/emoji-data', version);
await mkdir(join(target, 'en'), { recursive: true });
await Promise.all([
  copyFile(join(source, 'en/data.json'), join(target, 'en/data.json')),
  copyFile(join(source, 'en/messages.json'), join(target, 'en/messages.json')),
  copyFile(join(source, 'LICENSE'), join(target, 'LICENSE')),
]);
