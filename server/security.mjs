import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const buckets = new Map();
let nextPruneAt = 0;

export function requestId() {
  return randomUUID();
}

export function clientIp(request, { trustCloudFront = process.env.GLEAN_TRUST_PROXY === 'cloudfront' } = {}) {
  if (trustCloudFront) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim() || '';
    if (isIP(forwarded)) return forwarded;
  }
  const direct = String(request.socket?.remoteAddress || '').trim();
  return isIP(direct) ? direct : 'unknown';
}

export function takeRateLimit(request, bucket, limit, windowMs) {
  const now = Date.now();
  const key = `${bucket}:${clientIp(request)}`;
  let entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
  entry.count += 1;
  buckets.set(key, entry);
  if (entry.count <= limit) return null;
  return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
}

export function pruneRateLimits() {
  const now = Date.now();
  if (now < nextPruneAt) return;
  nextPruneAt = now + 5_000;
  for (const [key, entry] of buckets) if (entry.resetAt <= now) buckets.delete(key);
}

export function isSameOriginRequest(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method || 'GET')) return true;
  const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;
  if (!request.headers.origin) return hasBearerAuthorization(request);
  return isSameOriginOrigin(request);
}

export function hasBearerAuthorization(request) {
  return /^Bearer\s+[A-Za-z0-9_-]{32,128}$/i.test(String(request.headers.authorization || '').trim());
}

export function isSameOriginOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  if (String(request.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  try {
    const url = new URL(origin);
    const host = String(request.headers.host || '');
    const expectedProtocol = process.env.GLEAN_TRUST_PROXY === 'cloudfront'
      ? 'https:'
      : request.socket?.encrypted ? 'https:' : 'http:';
    return url.host === host && url.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

export function applySecurityHeaders(response, { production = false } = {}) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' blob: data: https://*.giphy.com; media-src 'self' blob: https://*.giphy.com; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (production) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
