import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProfileBackgroundImage } from './profileBackground.mjs';
import { MAIN_THEME_ID, MAIN_THEME_IMAGE_URL, MAIN_THEME_PRESETS, MAX_CUSTOM_THEMES, normalizeMainTheme, normalizeMainThemes } from '../src/app/mainTheme.js';

export function createMainThemeService({ database, uploadDirectory, requireSignedInUser, sendJson, readJson, sendLocalFile, takeRateLimit, randomBase32, removeStoredUploads, publicAccount }) {
  const findUser = database.prepare('SELECT * FROM users WHERE id = ?');
  const savePreferences = database.prepare('UPDATE users SET main_theme_json = ? WHERE id = ?');
  const fileName = theme => theme?.imageUrl?.match(MAIN_THEME_IMAGE_URL)?.[1];

  return async function handleMainThemes(request, response, path, method) {
    const imageMatch = path.match(/^\/api\/theme-images\/(theme-[a-z2-7]+\.jpg)$/);
    if (imageMatch && ['GET', 'HEAD'].includes(method)) {
      const user = requireSignedInUser(request, response);
      if (!user) return true;
      const owned = normalizeMainThemes(findUser.get(user.id)?.main_theme_json).custom.some(theme => fileName(theme) === imageMatch[1]);
      const imagePath = join(uploadDirectory, imageMatch[1]);
      if (!owned || !existsSync(imagePath)) sendJson(response, 404, { error: 'Theme photo not found.' });
      else sendLocalFile(request, response, imagePath, { type: 'image/jpeg', extra: { 'Cache-Control': 'private, max-age=3600', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
      return true;
    }
    if (path !== '/api/account/theme' || method !== 'POST') return false;
    const user = requireSignedInUser(request, response);
    if (!user) return true;
    let input, upload;
    try {
      if (String(request.headers['content-type'] || '').startsWith('multipart/form-data')) {
        const retryAfter = takeRateLimit(request, `main-theme-photo:${user.id}`, 10, 60_000);
        if (retryAfter) { sendJson(response, 429, { error: 'Too many photos. Try again shortly.' }, { 'Retry-After': String(retryAfter) }); return true; }
        upload = await readProfileBackgroundImage(request, { includeMetadata: true });
        input = { action: 'save', theme: { ...upload.metadata, ...upload.adjustments, kind: 'image' } };
      } else input = await readJson(request, 4096);
    } catch (error) { sendJson(response, 400, { error: error.message }); return true; }
    // Reread after asynchronous image decoding so concurrent saves cannot lose themes.
    const latestUser = findUser.get(user.id);
    if (!latestUser) { sendJson(response, 401, { error: 'Not signed in.' }); return true; }
    const preferences = normalizeMainThemes(latestUser.main_theme_json);
    let oldName, newName;
    const reject = error => { sendJson(response, 400, { error }); return true; };
    if (input?.action === 'select') {
      if (input.id !== null && ![...MAIN_THEME_PRESETS, ...preferences.custom].some(theme => theme.id === input.id)) return reject('Choose an existing theme.');
      preferences.active = input.id;
    } else if (input?.action === 'delete') {
      const previous = preferences.custom.find(theme => theme.id === input.id);
      if (!previous) return reject('Theme not found.');
      oldName = fileName(previous);
      preferences.custom = preferences.custom.filter(theme => theme.id !== input.id);
      if (preferences.active === input.id) preferences.active = null;
    } else if (input?.action === 'save') {
      const candidate = input.theme;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return reject('Choose a gradient or photo.');
      const previous = candidate.id ? preferences.custom.find(theme => theme.id === candidate.id) : null;
      if (candidate.id && (!MAIN_THEME_ID.test(candidate.id) || !previous)) return reject('Theme not found.');
      if (!previous && preferences.custom.length >= MAX_CUSTOM_THEMES) return reject(`Save up to ${MAX_CUSTOM_THEMES} custom themes. Delete one to add another.`);
      newName = upload ? `theme-${randomBase32(18)}.jpg` : null;
      const theme = normalizeMainTheme({ ...candidate, ...(upload ? { imageUrl: `/api/v1/theme-images/${newName}` } : {}) });
      if (!theme) return reject('Name your theme (up to 40 characters). Use two different colors and a 0–360° direction, or a photo with contrast/saturation 0–200% and blur 0–100px.');
      if (theme.kind === 'image' && !upload && theme.imageUrl !== previous?.imageUrl) return reject('Upload your own theme photo.');
      oldName = fileName(previous);
      const saved = { id: previous?.id || `custom-${randomBase32(18)}`, ...theme };
      preferences.custom = previous ? preferences.custom.map(item => item.id === saved.id ? saved : item) : [...preferences.custom, saved];
      preferences.active = saved.id;
      if (upload) writeFileSync(join(uploadDirectory, newName), upload.bytes, { mode: 0o600 });
    } else return reject('Choose a theme action.');
    try { savePreferences.run(JSON.stringify(preferences), user.id); } catch (error) {
      if (newName) removeStoredUploads([newName]);
      throw error;
    }
    const currentNames = new Set(preferences.custom.map(fileName).filter(Boolean));
    if (oldName && !currentNames.has(oldName)) removeStoredUploads([oldName]);
    sendJson(response, 200, { account: publicAccount({ ...latestUser, main_theme_json: JSON.stringify(preferences) }) });
    return true;
  };
}
