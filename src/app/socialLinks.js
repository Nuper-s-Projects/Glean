const HOSTS = {
  instagram: new Set(['instagram.com', 'www.instagram.com']),
  tiktok: new Set(['tiktok.com', 'www.tiktok.com']),
};

export function normalizeSocialUrl(value, platform) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' || !HOSTS[platform]?.has(url.hostname.toLowerCase())) return null;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function normalizeSocialUsername(value, platform) {
  const raw = String(value || '').trim().replace(/^@/, '');
  if (!raw) return '';
  if (platform === 'instagram' && /^[a-zA-Z0-9._]{1,30}$/.test(raw)) return raw;
  if (platform === 'tiktok' && /^[a-zA-Z0-9._]{1,24}$/.test(raw)) return raw;
  return null;
}
