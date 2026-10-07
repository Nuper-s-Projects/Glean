import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AGREEMENT_WAIT_SECONDS, CONDUCT_VERSION, TERMS_VERSION } from '../src/app/agreements.js';

const port = 6100 + Math.floor(Math.random() * 500);
const dataDir = mkdtempSync(join(tmpdir(), 'glean-agreements-test-'));
const base = `http://127.0.0.1:${port}/api/v1`;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), GLEAN_DATA_DIR: dataDir, GLEAN_ENABLE_LOOP_ROUTES: 'false', NODE_ENV: 'production' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let cookie = '';

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(method !== 'GET' ? { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { response, body: await response.json().catch(() => ({})) };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Test server exited early (${server.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* wait for startup */ }
    await delay(125);
  }
  assert.ok(ready, 'test server should start');

  const pdf = await fetch(`http://127.0.0.1:${port}/documents/uisd-student-code-of-conduct-2026-27.pdf`, { method: 'HEAD' });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type') || '', /application\/pdf/);
  assert.equal(pdf.headers.get('x-frame-options'), 'DENY');
  assert.match(pdf.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

  const codeText = await fetch(`http://127.0.0.1:${port}/documents/uisd-student-code-of-conduct-2026-27.txt`);
  const readableCode = await codeText.text();
  assert.equal(codeText.status, 200);
  assert.match(readableCode, /United Independent School District/);
  assert.match(readableCode, /PDF page 53/);

  const account = await request('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ username: 'terms_review_test', password: 'temporary-test-password-42' }),
  });
  assert.equal(account.response.status, 201);
  assert.equal(account.body.account.agreementsAccepted, false);

  const blocked = await request('/servers');
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.agreementRequired, true);

  const challenge = await request('/account/agreements');
  assert.equal(challenge.response.status, 200);
  assert.equal(challenge.body.termsVersion, TERMS_VERSION);
  assert.equal(challenge.body.conductVersion, CONDUCT_VERSION);
  assert.equal(challenge.body.waitSeconds, AGREEMENT_WAIT_SECONDS);

  const input = JSON.stringify({ termsVersion: TERMS_VERSION, conductVersion: CONDUCT_VERSION, termsAccepted: true, conductAccepted: true });
  const tooSoon = await request('/account/agreements', { method: 'POST', body: input });
  assert.equal(tooSoon.response.status, 425, 'acceptance before the five-second wait must be rejected server-side');
  await delay(AGREEMENT_WAIT_SECONDS * 1000 + 100);

  const accepted = await request('/account/agreements', { method: 'POST', body: input });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.account.agreementsAccepted, true);
  assert.equal(accepted.body.account.termsVersion, TERMS_VERSION);
  assert.equal(accepted.body.account.conductVersion, CONDUCT_VERSION);

  const allowed = await request('/servers');
  assert.equal(allowed.response.status, 200);

  console.log('Agreement acceptance smoke test passed.');
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(1500)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
}
