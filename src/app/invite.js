const INVITE_CODE = /^[A-Za-z0-9_-]{6,32}$/;
const INVITE_IN_TEXT = /(?:https?:\/\/[^\s<>]+\/invite\/|\/invite\/|glean-invite:)([A-Za-z0-9_-]{6,32})/gi;

export function inviteUrl(code) {
  const clean = String(code || '').trim();
  if (!clean) return '';
  if (typeof window === 'undefined') return `/invite/${clean}`;
  return `${window.location.origin}/invite/${clean}`;
}

export function parseInviteInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, typeof window === 'undefined' ? 'https://glean.local' : window.location.origin);
    const fromPath = url.pathname.match(/\/(?:invite|join)\/([A-Za-z0-9_-]{6,32})$/i);
    if (fromPath) return fromPath[1];
  } catch { /* not a URL */ }
  const embedded = raw.match(/\/(?:invite|join)\/([A-Za-z0-9_-]{6,32})(?:[/?#]|$)/i);
  if (embedded) return embedded[1];
  const tagged = raw.match(/^glean-invite:([A-Za-z0-9_-]{6,32})$/i);
  if (tagged) return tagged[1];
  if (INVITE_CODE.test(raw)) return raw;
  return '';
}

const PENDING_KEY = 'glean.pendingInvite';
const INVITE_PATH = /^\/invite\/([A-Za-z0-9_-]{6,32})\/?$/i;

export function stashInviteFromLocation() {
  if (typeof window === 'undefined') return '';
  const match = String(window.location.pathname || '').match(INVITE_PATH);
  if (!match) return peekPendingInvite();
  try { sessionStorage.setItem(PENDING_KEY, match[1]); } catch { /* ignore */ }
  return match[1];
}

export function peekPendingInvite() {
  try { return sessionStorage.getItem(PENDING_KEY) || ''; } catch { return ''; }
}

export function takePendingInvite() {
  const code = peekPendingInvite();
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  return code;
}

export function extractInviteCodes(value) {
  const codes = [];
  const seen = new Set();
  const add = (code) => {
    const clean = String(code || '').trim();
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    codes.push(clean);
  };
  const text = String(value || '');
  INVITE_IN_TEXT.lastIndex = 0;
  let match = INVITE_IN_TEXT.exec(text);
  while (match) {
    add(match[1]);
    match = INVITE_IN_TEXT.exec(text);
  }
  return codes;
}

export function stripInviteTokens(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s<>]*\/invite\/[A-Za-z0-9_-]{6,32}/gi, '')
    .replace(/\/invite\/[A-Za-z0-9_-]{6,32}/gi, '')
    .replace(/glean-invite:[A-Za-z0-9_-]{6,32}/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isInviteBody(value) {
  return extractInviteCodes(value).length > 0;
}
