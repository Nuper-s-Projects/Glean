import assert from 'node:assert/strict';
import { clientIp, isSameOriginOrigin, isSameOriginRequest, takeRateLimit } from '../server/security.mjs';

const request = ({ origin, fetchSite, forwarded, authorization, encrypted = false } = {}) => ({
  method: 'POST',
  headers: {
    host: 'glean.example',
    ...(origin === undefined ? {} : { origin }),
    ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}),
    ...(forwarded ? { 'x-forwarded-for': forwarded } : {}),
    ...(authorization ? { authorization } : {}),
  },
  socket: { remoteAddress: '10.0.0.7', encrypted },
});

const originalProxySetting = process.env.GLEAN_TRUST_PROXY;
delete process.env.GLEAN_TRUST_PROXY;
assert.equal(clientIp(request({ forwarded: '198.51.100.80' })), '10.0.0.7', 'untrusted X-Forwarded-For must be ignored');
assert.equal(isSameOriginRequest(request()), false, 'originless cookie-authenticated writes must be rejected');
assert.equal(isSameOriginRequest(request({ origin: 'http://glean.example' })), true, 'same-origin local writes must remain allowed');
assert.equal(isSameOriginRequest(request({ origin: 'http://attacker.example' })), false, 'cross-origin writes must be rejected');
assert.equal(isSameOriginRequest(request({ origin: 'http://glean.example', fetchSite: 'cross-site' })), false, 'cross-site fetch metadata must be rejected');
assert.equal(isSameOriginRequest(request({ authorization: `Bearer ${'a'.repeat(52)}` })), true, 'originless bearer API clients must remain supported');

const bucket = 'security-smoke-untrusted-xff';
assert.equal(takeRateLimit(request({ forwarded: '198.51.100.1' }), bucket, 1, 60_000), null);
assert.ok(takeRateLimit(request({ forwarded: '198.51.100.2' }), bucket, 1, 60_000), 'spoofed XFF values must not create separate rate-limit identities');

process.env.GLEAN_TRUST_PROXY = 'cloudfront';
assert.equal(clientIp(request({ forwarded: '203.0.113.200, 198.51.100.42' })), '198.51.100.42', 'trusted CloudFront IP must be the rightmost appended address');
assert.equal(clientIp(request({ forwarded: '198.51.100.42, invalid' })), '10.0.0.7', 'malformed trusted forwarding values must fall back to the socket IP');
assert.equal(isSameOriginRequest(request({ origin: 'https://glean.example' })), true, 'HTTPS viewer origins through CloudFront must remain allowed');
assert.equal(isSameOriginRequest(request({ origin: 'http://glean.example' })), false, 'HTTP origins must fail when CloudFront HTTPS is enforced');
const trustedBucket = 'security-smoke-trusted-xff';
assert.equal(takeRateLimit(request({ forwarded: '198.51.100.1, 203.0.113.44' }), trustedBucket, 1, 60_000), null);
assert.ok(takeRateLimit(request({ forwarded: '198.51.100.2, 203.0.113.44' }), trustedBucket, 1, 60_000), 'CloudFront-appended client IP must unify rate limits across spoofed prefixes');

if (originalProxySetting === undefined) delete process.env.GLEAN_TRUST_PROXY;
else process.env.GLEAN_TRUST_PROXY = originalProxySetting;
console.log('Request security smoke test passed.');
