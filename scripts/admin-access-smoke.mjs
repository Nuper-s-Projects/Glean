import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AGREEMENT_WAIT_SECONDS, CONDUCT_VERSION, TERMS_VERSION } from '../src/app/agreements.js';

const port = 6500 + Math.floor(Math.random() * 400);
const dataDir = mkdtempSync(join(tmpdir(), 'glean-admin-access-test-'));
const origin = `http://127.0.0.1:${port}`;
const base = `${origin}/api/v1`;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), GLEAN_DATA_DIR: dataDir, GLEAN_ENABLE_LOOP_ROUTES: 'false', GLEAN_ADMIN_USERNAMES: 'Nuper', NODE_ENV: 'production' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function request(path, { cookie = '', method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
}

async function createAcceptedUser(username) {
  const signup = await request('/auth/signup', { method: 'POST', body: { username, password: 'temporary-admin-test-password-74' } });
  assert.equal(signup.response.status, 201);
  const challenge = await request('/account/agreements', { cookie: signup.cookie });
  assert.equal(challenge.response.status, 200);
  await delay((challenge.body.waitSeconds || AGREEMENT_WAIT_SECONDS) * 1000 + 100);
  const acceptance = await request('/account/agreements', {
    cookie: signup.cookie,
    method: 'POST',
    body: { termsVersion: TERMS_VERSION, conductVersion: CONDUCT_VERSION, termsAccepted: true, conductAccepted: true },
  });
  assert.equal(acceptance.response.status, 200);
  return signup.cookie;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Test server exited early (${server.exitCode}).`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* wait for startup */ }
    await delay(125);
  }
  assert.ok(ready, 'test server should start');

  const publicAdmin = await fetch(`${origin}/admin`);
  assert.equal(publicAdmin.status, 200);
  assert.match(await publicAdmin.text(), /admin-login/);
  assert.match(publicAdmin.headers.get('x-robots-tag') || '', /noindex/);
  const unsigned = await request('/admin/access');
  assert.equal(unsigned.response.status, 401);

  const nonAdminCookie = await createAcceptedUser('ordinary_test');
  const forbidden = await request('/admin/access', { cookie: nonAdminCookie });
  assert.equal(forbidden.response.status, 403, 'non-Nuper accounts cannot control platform access');
  const forbiddenAnnouncement = await request('/admin/announcement', { cookie: nonAdminCookie });
  assert.equal(forbiddenAnnouncement.response.status, 403, 'non-Nuper accounts cannot manage announcements');

  const nuperCookie = await createAcceptedUser('Nuper');
  const initial = await request('/admin/access', { cookie: nuperCookie });
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body, { schoolHoursAllowed: false, offlineScreenEnabled: false });
  const initialAnnouncement = await request('/admin/announcement', { cookie: nuperCookie });
  assert.equal(initialAnnouncement.response.status, 200);
  assert.equal(initialAnnouncement.body.enabled, false);
  assert.equal(initialAnnouncement.body.profile.username, 'Nuper');
  const publicAnnouncement = await request('/announcement');
  assert.equal(publicAnnouncement.response.status, 200, 'everyone can read the active announcement');
  assert.equal(publicAnnouncement.body.enabled, false);
  const shownAnnouncement = await request('/admin/announcement', {
    cookie: nuperCookie,
    method: 'PATCH',
    body: { message: '<b>Site notice</b>\nSecond line', enabled: true },
  });
  assert.equal(shownAnnouncement.response.status, 200);
  assert.equal(shownAnnouncement.body.message, '<b>Site notice</b>\nSecond line');
  assert.equal(shownAnnouncement.body.enabled, true);
  const publicShownAnnouncement = await request('/announcement');
  assert.equal(publicShownAnnouncement.body.message, '<b>Site notice</b>\nSecond line', 'message is available as plain text for safe client rendering');
  assert.equal(publicShownAnnouncement.body.profile.username, 'Nuper');
  const hiddenAnnouncement = await request('/admin/announcement', { cookie: nuperCookie, method: 'PATCH', body: { enabled: false } });
  assert.equal(hiddenAnnouncement.body.enabled, false);
  assert.equal((await request('/announcement')).body.message, '');

  const invalid = await request('/admin/access', { cookie: nuperCookie, method: 'PATCH', body: { offlineScreenEnabled: 'yes' } });
  assert.equal(invalid.response.status, 400);
  const scheduleOn = await request('/admin/access', { cookie: nuperCookie, method: 'PATCH', body: { schoolHoursAllowed: true } });
  assert.equal(scheduleOn.body.schoolHoursAllowed, true);

  const offlineOn = await request('/admin/access', { cookie: nuperCookie, method: 'PATCH', body: { offlineScreenEnabled: true } });
  assert.equal(offlineOn.body.offlineScreenEnabled, true);
  const offlinePage = await fetch(`${origin}/signin`);
  assert.equal(offlinePage.status, 503);
  const offlineHtml = await offlinePage.text();
  assert.match(offlineHtml, /Glean is unavailable right now/);
  assert.match(offlineHtml, /blocked\.css/);
  assert.doesNotMatch(offlineHtml, /countdown|blocked-countdown/);
  const stillAdmin = await fetch(`${origin}/admin`, { headers: { Cookie: nuperCookie } });
  assert.equal(stillAdmin.status, 200, 'Nuper can still reopen Glean while offline mode is active');

  const restored = await request('/admin/access', { cookie: nuperCookie, method: 'PATCH', body: { offlineScreenEnabled: false, schoolHoursAllowed: false } });
  assert.deepEqual(restored.body, { schoolHoursAllowed: false, offlineScreenEnabled: false });
  const onlinePage = await fetch(`${origin}/signin`);
  assert.equal(onlinePage.status, 200);
  console.log('Admin access control smoke test passed.');
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(1500)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
}
