export const MAX_CUSTOM_BADGES = 8;
export const MAX_CUSTOM_BADGE_LABEL = 20;

export function normalizeCustomBadges(value) {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_BADGES) return null;
  const result = [];
  const labels = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const label = String(item.label || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    const color = String(item.color || '').trim().toUpperCase();
    if (!label || label.length > MAX_CUSTOM_BADGE_LABEL || !/^#[0-9A-F]{6}$/.test(color)) return null;
    const key = label.toLocaleLowerCase();
    if (labels.has(key)) return null;
    labels.add(key);
    result.push({ label, color });
  }
  return result;
}

export function customBadgeTextColor(color) {
  const value = String(color || '').replace('#', '');
  if (!/^[0-9A-Fa-f]{6}$/.test(value)) return '#FFFFFF';
  const channels = [0, 2, 4].map((start) => Number.parseInt(value.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return luminance > 0.42 ? '#17202B' : '#FFFFFF';
}
