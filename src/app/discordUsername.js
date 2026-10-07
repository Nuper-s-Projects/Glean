export function normalizeDiscordUsername(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  raw = raw.replace(/^https?:\/\/(?:www\.)?discord(?:app)?\.com\/users\//i, '');
  raw = raw.replace(/^@/, '').replace(/\s+/g, '');
  const legacy = raw.match(/^(.{2,32})#(\d{4})$/);
  if (legacy) return `${legacy[1]}#${legacy[2]}`;
  const next = raw.toLowerCase();
  if (next.length < 2 || next.length > 32) return null;
  if (!/^[a-z0-9._]+$/.test(next) || next.includes('..') || /^\d+$/.test(next) || next.startsWith('.') || next.endsWith('.')) return null;
  return next;
}

export function publicDiscordUsername(value) {
  const next = normalizeDiscordUsername(value);
  return next || null;
}
