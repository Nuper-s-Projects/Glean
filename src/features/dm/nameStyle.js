import { BANNER_HEX, normalizeHex } from './banner';
import { NAME_FONT_OPTIONS } from './nameFonts';

export { NAME_FONT_OPTIONS, NAME_FONT_IDS } from './nameFonts';

const FONT_BY_ID = new Map(NAME_FONT_OPTIONS.map((item) => [item.id, item]));
const loadedHrefs = new Set();

export function nameFontOf(id) {
  return FONT_BY_ID.get(id) || FONT_BY_ID.get('lexend');
}

export function ensureNameFonts(fontId) {
  const font = FONT_BY_ID.get(fontId);
  if (!font?.href || typeof document === 'undefined' || loadedHrefs.has(font.href)) return;
  loadedHrefs.add(font.href);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${font.href}&display=swap`;
  document.head.appendChild(link);
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function nameGlowAmount(value) {
  if (value === true) return 50;
  if (value === false || value == null || value === '') return 0;
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount)) return 0;
  return Math.min(100, Math.max(0, amount));
}

function hexOrNull(value) {
  const clean = normalizeHex(value, '');
  return BANNER_HEX.test(clean) ? clean : null;
}

function glowFilter(color, amount) {
  const t = amount / 100;
  const inner = (0.06 + t * 0.34).toFixed(3);
  const outer = (0.18 + t * 1.15).toFixed(3);
  const mix = Math.round(40 + t * 60);
  const ink = String(color).startsWith('#') ? `color-mix(in srgb, ${color} ${mix}%, transparent)` : color;
  return `drop-shadow(0 0 ${inner}em ${ink}) drop-shadow(0 0 ${outer}em ${ink})`;
}

export function nameStyleProps(style) {
  const next = { className: 'glean-name', style: {} };
  if (!style || typeof style !== 'object') return next;
  const font = FONT_BY_ID.get(style.font);
  if (font && style.font !== 'lexend') {
    next.style.fontFamily = font.family;
    ensureNameFonts(style.font);
  }
  const glow = prefersReducedMotion() ? 0 : nameGlowAmount(style.glow);
  const color = hexOrNull(style.color);
  const from = hexOrNull(style.from);
  const to = hexOrNull(style.to);
  if (style.kind === 'solid' && color) {
    next.style.color = color;
    next.className += ' is-solid';
    if (glow) {
      next.style.filter = glowFilter(color, glow);
      next.className += ' is-glow';
    }
  } else if (style.kind === 'gradient' && from && to) {
    const angle = Math.min(360, Math.max(0, Math.round(Number(style.angle) || 135)));
    next.style.backgroundImage = `linear-gradient(${angle}deg, ${from}, ${to})`;
    next.style.WebkitBackgroundClip = 'text';
    next.style.backgroundClip = 'text';
    next.style.WebkitTextFillColor = 'transparent';
    next.style.color = 'transparent';
    next.className += ' is-gradient';
    if (glow) {
      next.style.filter = glowFilter(from, glow);
      next.className += ' is-glow';
    }
  } else if (glow) {
    next.style.filter = glowFilter('color-mix(in srgb, var(--accent) 80%, transparent)', glow);
    next.className += ' is-glow';
  }
  return next;
}

export function nameStyleAttr(style) {
  const { className, style: css } = nameStyleProps(style);
  const parts = [];
  if (css.fontFamily) parts.push(`font-family:${css.fontFamily.replace(/"/g, "'")}`);
  if (css.color) parts.push(`color:${css.color}`);
  if (css.backgroundImage) parts.push(`background-image:${css.backgroundImage}`);
  if (css.backgroundClip || css.WebkitBackgroundClip) {
    parts.push('-webkit-background-clip:text');
    parts.push('background-clip:text');
    parts.push('-webkit-text-fill-color:transparent');
  }
  if (css.filter) parts.push(`filter:${css.filter}`);
  return { className, attr: parts.join(';') };
}
