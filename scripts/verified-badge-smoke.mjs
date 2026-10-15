import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AGREEMENT_WAIT_SECONDS, CONDUCT_VERSION, TERMS_VERSION } from '../src/app/agreements.js';

const port = 12_000 + Math.floor(Math.random() * 20_000);
const dataDir = mkdtempSync(join(tmpdir(), 'glean-verified-test-'));
const origin = `http://127.0.0.1:${port}`;
const base = `${origin}/api/v1`;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT:String(port), GLEAN_DATA_DIR:dataDir, GLEAN_ENABLE_LOOP_ROUTES:'false', GLEAN_ADMIN_USERNAMES:'Nuper', GROQ_API_KEY:'', NODE_ENV:'production' },
  stdio:['ignore','ignore','inherit'],
});
async function request(path, { cookie='',method='GET',body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers:{ ...(method!=='GET'?{Origin:origin,'Content-Type':'application/json'}:{}), ...(cookie?{Cookie:cookie}:{}) }, body:body === undefined ? undefined : JSON.stringify(body) });
  return { response,body:await response.json().catch(()=>({})),cookie:response.headers.get('set-cookie')?.split(';')[0] || cookie };
}
async function createAcceptedUser(username) {
  const signup = await request('/auth/signup',{method:'POST',body:{username,password:'verified-smoke-test-password-9482'}});
  assert.equal(signup.response.status,201,JSON.stringify(signup.body));
  const challenge=await request('/account/agreements',{cookie:signup.cookie});
  assert.equal(challenge.response.status,200);
  await delay((challenge.body.waitSeconds || AGREEMENT_WAIT_SECONDS)*1000+100);
  const accepted=await request('/account/agreements',{cookie:signup.cookie,method:'POST',body:{termsVersion:TERMS_VERSION,conductVersion:CONDUCT_VERSION,termsAccepted:true,conductAccepted:true}});
  assert.equal(accepted.response.status,200);
  return signup.cookie;
}
try {
  let ready=false;
  for(let attempt=0;attempt<80;attempt++) {
    if(server.exitCode!==null) throw new Error(`Test server exited early (${server.exitCode}).`);
    try { if((await fetch(`${origin}/api/health`)).ok){ready=true;break;} } catch {}
    await delay(125);
  }
  assert.ok(ready,'test server starts');
  const nuper=await createAcceptedUser('Nuper');
  const member=await createAcceptedUser('verified_member');
  assert.equal((await request('/account/verified-users',{cookie:member})).response.status,403,'only Nuper can list accounts for badge management');
  assert.equal((await request('/account/verified-users/2',{cookie:member,method:'PATCH',body:{verified:true}})).response.status,403,'only Nuper can grant the badge');
  const target=(await request('/users/verified_member',{cookie:nuper})).body.user;
  assert.equal(target.verified,false);
  const granted=await request(`/account/verified-users/${target.id}`,{cookie:nuper,method:'PATCH',body:{verified:true}});
  assert.equal(granted.response.status,200,JSON.stringify(granted.body));
  assert.equal((await request('/users/verified_member',{cookie:nuper})).body.user.verified,true,'the public profile carries the verified flag');
  assert.equal((await request('/account/verified-users?q=verified_member',{cookie:nuper})).body.users[0].verified,true,'the Nuper settings list reflects the grant');
  const removed=await request(`/account/verified-users/${target.id}`,{cookie:nuper,method:'PATCH',body:{verified:false}});
  assert.equal(removed.response.status,200);
  assert.equal((await request('/users/verified_member',{cookie:nuper})).body.user.verified,false,'badge removal persists');
  console.log('PASS: Nuper-only badge management, account search, public profile propagation, and revocation.');
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(3000)]);
  rmSync(dataDir,{recursive:true,force:true});
}
