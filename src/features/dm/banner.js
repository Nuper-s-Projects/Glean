import { useEffect, useState } from 'react';

export const BANNER_HEX = /^#[0-9a-f]{6}$/i;
const AVATAR_URL = /^\/api\/v1\/avatars\/[a-z0-9._-]+$/i;
const BANNER_IMAGE_URL = /^\/api\/v1\/(?:banners\/banner-[a-z2-7]+\.jpg|server-banners\/server-banner-[a-z2-7]+\.jpg|invites\/[a-z0-9_-]{6,32}\/banner)$/i;
const paletteCache = new Map();
const palettePending = new Map();

export function normalizeHex(value, fallback = '#249cff') {
  const clean = String(value || '').trim();
  if (BANNER_HEX.test(clean)) return `#${clean.slice(1).toLowerCase()}`;
  if (/^[0-9a-f]{6}$/i.test(clean)) return `#${clean.toLowerCase()}`;
  return fallback;
}

function byte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHex(r, g, b) {
  return `#${[r, g, b].map((value) => byte(value).toString(16).padStart(2, '0')).join('')}`;
}

function luma(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function sat(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  if (!delta) return 0;
  return delta / (1 - Math.abs(max + min - 1));
}

function hue(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  if (!delta) return 0;
  let next = 0;
  if (max === red) next = ((green - blue) / delta) % 6;
  else if (max === green) next = (blue - red) / delta + 2;
  else next = (red - green) / delta + 4;
  next *= 60;
  return next < 0 ? next + 360 : next;
}

function hslToRgb(h, s, l) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - chroma / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = chroma; g = x; }
  else if (h < 120) { r = x; g = chroma; }
  else if (h < 180) { g = chroma; b = x; }
  else if (h < 240) { g = x; b = chroma; }
  else if (h < 300) { r = x; b = chroma; }
  else { r = chroma; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function tone(color, satMul, lumTarget) {
  const nextSat = Math.min(0.84, sat(color.r, color.g, color.b) * satMul);
  const current = luma(color.r, color.g, color.b);
  const nextLum = lumTarget == null ? Math.min(0.56, Math.max(0.22, current * 0.9)) : lumTarget;
  return hslToRgb(hue(color.r, color.g, color.b), Math.max(0.08, nextSat), nextLum);
}

function collectBuckets(data, skipEnds) {
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 96) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = luma(r, g, b);
    if (skipEnds && (y < 0.08 || y > 0.93)) continue;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const prev = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    prev.n += 1;
    prev.r += r;
    prev.g += g;
    prev.b += b;
    buckets.set(key, prev);
  }
  return buckets;
}

export function paletteFromPixels(data) {
  const buckets = collectBuckets(data, true);
  const used = buckets.size ? buckets : collectBuckets(data, false);
  if (!used.size) return { from: '#2a3a4a', to: '#101a23' };
  const colors = [...used.values()].map((item) => {
    const r = item.r / item.n;
    const g = item.g / item.n;
    const b = item.b / item.n;
    const s = sat(r, g, b);
    const y = luma(r, g, b);
    return {
      r, g, b, s, y, h: hue(r, g, b),
      score: item.n * (0.28 + s) * (1 - Math.abs(y - 0.42)),
    };
  }).sort((left, right) => right.score - left.score);
  const primary = colors[0];
  const secondary = colors.find((item) => {
    const gap = Math.abs(item.h - primary.h);
    const hueGap = gap > 180 ? 360 - gap : gap;
    const dr = item.r - primary.r;
    const dg = item.g - primary.g;
    const db = item.b - primary.b;
    return hueGap > 22 || Math.sqrt(dr * dr + dg * dg + db * db) > 72;
  });
  const from = tone(primary, 1.2);
  const to = secondary
    ? tone(secondary, 1.06, Math.min(0.26, luma(secondary.r, secondary.g, secondary.b) * 0.52 + 0.08))
    : tone(primary, 1.05, 0.16);
  return { from: toHex(from.r, from.g, from.b), to: toHex(to.r, to.g, to.b) };
}

function gradientStyle(from, to) {
  return { background: `linear-gradient(135deg, ${from}, ${to})` };
}

function profileBackgroundStyle(style) {
  return style?.background ? { ...style, '--dm-profile-background': style.background } : style;
}

function roleBannerStyle(color) {
  const hex = normalizeHex(color, '');
  if (!BANNER_HEX.test(hex)) return undefined;
  return { background: `linear-gradient(135deg, ${hex}, color-mix(in srgb, ${hex} 40%, #101a23))` };
}

function sampleAvatar(url) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('no image'));
      return;
    }
    const image = new Image();
    image.onload = () => {
      try {
        const size = 48;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          reject(new Error('no canvas'));
          return;
        }
        ctx.drawImage(image, 0, 0, size, size);
        resolve(paletteFromPixels(ctx.getImageData(0, 0, size, size).data));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error('avatar'));
    image.src = url;
  });
}

export function loadAvatarPalette(url) {
  if (!AVATAR_URL.test(String(url || ''))) return Promise.resolve(null);
  if (paletteCache.has(url)) return Promise.resolve(paletteCache.get(url));
  const pending = palettePending.get(url);
  if (pending) return pending;
  const job = sampleAvatar(url).then((palette) => {
    paletteCache.set(url, palette);
    palettePending.delete(url);
    return palette;
  }).catch(() => {
    paletteCache.set(url, null);
    palettePending.delete(url);
    return null;
  });
  palettePending.set(url, job);
  return job;
}

export function bannerStyle(banner) {
  if (!banner) return undefined;
  if (banner.kind === 'solid' && BANNER_HEX.test(banner.color || '')) return { background: banner.color };
  if (banner.kind === 'gradient' && BANNER_HEX.test(banner.from || '') && BANNER_HEX.test(banner.to || '')) {
    const angle = Math.min(360, Math.max(0, Math.round(Number(banner.angle) || 135)));
    return { background: `linear-gradient(${angle}deg, ${banner.from}, ${banner.to})` };
  }
  if (banner.kind === 'image' && typeof banner.imageUrl === 'string' && (BANNER_IMAGE_URL.test(banner.imageUrl) || banner.imageUrl.startsWith('blob:'))) {
    return {
      backgroundColor: '#101a23',
      backgroundImage: `url("${banner.imageUrl}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    };
  }
  return undefined;
}

function hexLuma(hex) {
  if (!BANNER_HEX.test(String(hex || ''))) return null;
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (part) => {
    const normalized = part / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((value >> 16) & 255)
    + 0.7152 * channel((value >> 8) & 255)
    + 0.0722 * channel(value & 255);
}

export function profileThemeStyle(banner) {
  const style = bannerStyle(banner);
  if (!style) return undefined;
  const values = banner?.kind === 'solid'
    ? [hexLuma(banner.color)]
    : banner?.kind === 'gradient'
      ? [hexLuma(banner.from), hexLuma(banner.to)]
      : [];
  if (values.length && values.every((value) => value != null)) {
    const light = values.reduce((sum, value) => sum + value, 0) / values.length > 0.18;
    return profileBackgroundStyle({
      ...style,
      '--dm-profile-text': light ? '#101a23' : '#f7fbff',
      '--dm-profile-muted': light ? 'rgba(16, 26, 35, .72)' : 'rgba(247, 251, 255, .78)',
      '--dm-profile-line': light ? 'rgba(16, 26, 35, .22)' : 'rgba(247, 251, 255, .24)',
    });
  }
  return profileBackgroundStyle(style);
}

export function contactBannerStyle(user) {
  const custom = bannerStyle(user?.banner);
  if (custom) return custom;
  const cached = AVATAR_URL.test(String(user?.avatarUrl || '')) ? paletteCache.get(user.avatarUrl) : null;
  if (cached) return gradientStyle(cached.from, cached.to);
  return roleBannerStyle(user?.roleColor);
}

export function useContactBannerStyle(user) {
  const custom = bannerStyle(user?.banner);
  const url = !custom && AVATAR_URL.test(String(user?.avatarUrl || '')) ? user.avatarUrl : '';
  const [, bump] = useState(0);

  useEffect(() => {
    if (!url || paletteCache.has(url)) return undefined;
    let alive = true;
    loadAvatarPalette(url).then(() => {
      if (alive) bump((value) => value + 1);
    });
    return () => { alive = false; };
  }, [url]);

  if (custom) return custom;
  const sampled = url ? paletteCache.get(url) : null;
  if (sampled) return gradientStyle(sampled.from, sampled.to);
  if (url && !paletteCache.has(url)) return gradientStyle('#1a2733', '#101a23');
  return roleBannerStyle(user?.roleColor);
}
