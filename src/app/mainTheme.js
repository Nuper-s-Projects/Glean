import { profileImageAdjustments } from './profileBackground.js';

export const MAIN_THEME_IMAGE_URL = /^\/api\/v1\/theme-images\/(theme-[a-z2-7]+\.jpg)$/;
export const MAIN_THEME_ID = /^custom-[a-z2-7]{20,64}$/;
export const MAX_CUSTOM_THEMES = 12;
export const MAIN_THEME_PRESETS = Object.freeze([
  { id: 'preset-ocean', name: 'Ocean', kind: 'gradient', from: '#06385F', to: '#087D8B', angle: 135 },
  { id: 'preset-dusk', name: 'Dusk', kind: 'gradient', from: '#3C245C', to: '#B05C70', angle: 150 },
  { id: 'preset-aurora', name: 'Aurora', kind: 'gradient', from: '#183B45', to: '#624690', angle: 120 },
  { id: 'preset-ember', name: 'Ember', kind: 'gradient', from: '#4A2438', to: '#AF6B35', angle: 145 },
  { id: 'preset-forest', name: 'Forest', kind: 'gradient', from: '#12352F', to: '#54774A', angle: 125 },
  { id: 'preset-midnight', name: 'Midnight', kind: 'gradient', from: '#101D40', to: '#49396F', angle: 140 },
]);

export function normalizeMainTheme(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 40) return null;
  if (input.kind === 'gradient') {
    if (![input.from, input.to].every(color => typeof color === 'string' && color.length === 7 && /^#[\da-f]{6}$/i.test(color))) return null;
    if (input.from.toUpperCase() === input.to.toUpperCase()) return null;
    if (typeof input.angle !== 'number' || !Number.isFinite(input.angle) || input.angle < 0 || input.angle > 360) return null;
    return { name, kind: 'gradient', from: input.from.toUpperCase(), to: input.to.toUpperCase(), angle: Math.round(input.angle) };
  }
  if (input.kind === 'image' && typeof input.imageUrl === 'string' && MAIN_THEME_IMAGE_URL.test(input.imageUrl)) {
    const adjustments = profileImageAdjustments(input, true);
    return adjustments ? { name, kind: 'image', imageUrl: input.imageUrl, ...adjustments } : null;
  }
  return null;
}

export function normalizeMainThemes(raw) {
  let input = raw;
  if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { input = null; } }
  const custom = [];
  for (const candidate of Array.isArray(input?.custom) ? input.custom.slice(0, MAX_CUSTOM_THEMES) : []) {
    const theme = normalizeMainTheme(candidate);
    if (theme && MAIN_THEME_ID.test(candidate.id) && !custom.some(item => item.id === candidate.id)) custom.push({ id: candidate.id, ...theme });
  }
  const active = [...MAIN_THEME_PRESETS, ...custom].some(theme => theme.id === input?.active) ? input.active : null;
  return { active, custom };
}

export function selectedMainTheme(preferences) {
  const { active, custom } = normalizeMainThemes(preferences);
  return [...MAIN_THEME_PRESETS, ...custom].find(theme => theme.id === active) || null;
}

// Only our authenticated media URLs (or a locally generated editor preview) become CSS.
export function mainThemeBackdropStyle(theme, preview = false) {
  if (theme?.kind === 'gradient' && normalizeMainTheme({ ...theme, name: theme.name || 'Preview' })) {
    return { '--glean-theme-background': `linear-gradient(${theme.angle}deg, ${theme.from}, ${theme.to})`, '--glean-theme-filter': 'none', '--glean-theme-bleed': '0px' };
  }
  if (theme?.kind === 'image' && typeof theme.imageUrl === 'string' && (MAIN_THEME_IMAGE_URL.test(theme.imageUrl) || (preview && /^blob:[^\s"'\\]+$/.test(theme.imageUrl)))) {
    const { contrast, saturation, blur } = profileImageAdjustments(theme);
    return { '--glean-theme-background': `url("${theme.imageUrl}")`, '--glean-theme-filter': `contrast(${contrast}%) saturate(${saturation}%) blur(${blur}px)`, '--glean-theme-contrast': `${contrast}%`, '--glean-theme-saturation': `${saturation}%`, '--glean-theme-bleed': `${blur * 2}px` };
  }
  return {};
}
