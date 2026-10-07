export const DEFAULT_ACCESSIBILITY = Object.freeze({ theme: 'system', contrast: 100, saturation: 100, glassFrost: 50, glassDepth: 20, glassRefraction: 100 });

export function isIPhoneDevice() {
  return typeof navigator !== 'undefined' && /iPhone/i.test(navigator.userAgent || '');
}

export function normalizeAccessibility(value = {}) {
  const theme = ['system', 'light', 'dark'].includes(value.theme) ? value.theme : DEFAULT_ACCESSIBILITY.theme;
  const contrast = Number(value.contrast ?? value.accessibilityContrast ?? DEFAULT_ACCESSIBILITY.contrast);
  const saturation = Number(value.saturation ?? value.accessibilitySaturation ?? DEFAULT_ACCESSIBILITY.saturation);
  const glassFrost = Number(value.glassFrost ?? value.accessibilityGlassFrost ?? DEFAULT_ACCESSIBILITY.glassFrost);
  const glassDepth = Number(value.glassDepth ?? value.accessibilityGlassDepth ?? DEFAULT_ACCESSIBILITY.glassDepth);
  const glassRefraction = Number(value.glassRefraction ?? value.accessibilityGlassRefraction ?? DEFAULT_ACCESSIBILITY.glassRefraction);
  return {
    theme,
    contrast: Number.isFinite(contrast) ? Math.min(150, Math.max(50, Math.round(contrast))) : DEFAULT_ACCESSIBILITY.contrast,
    saturation: Number.isFinite(saturation) ? Math.min(200, Math.max(0, Math.round(saturation))) : DEFAULT_ACCESSIBILITY.saturation,
    glassFrost: Number.isFinite(glassFrost) ? Math.min(100, Math.max(0, Math.round(glassFrost))) : DEFAULT_ACCESSIBILITY.glassFrost,
    glassDepth: Number.isFinite(glassDepth) ? Math.min(100, Math.max(0, Math.round(glassDepth))) : DEFAULT_ACCESSIBILITY.glassDepth,
    glassRefraction: Number.isFinite(glassRefraction) ? Math.min(100, Math.max(0, Math.round(glassRefraction))) : DEFAULT_ACCESSIBILITY.glassRefraction,
    reduceMotion: value.reduceMotion === true || value.accessibilityReduceMotion === true,
  };
}

export function applyAccessibilitySettings(value) {
  if (typeof document === 'undefined') return;
  const settings = normalizeAccessibility(value);
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
  if (settings.theme === 'system') document.documentElement.style.removeProperty('color-scheme');
  else document.documentElement.style.colorScheme = settings.theme;
  const screen = document.querySelector('.screen-transition');
  if (!screen) return;
  screen.style.setProperty('--glean-accessibility-contrast', `${settings.contrast}%`);
  screen.style.setProperty('--glean-accessibility-saturation', `${settings.saturation}%`);
  document.documentElement.style.setProperty('--glean-liquid-glass-frost', String(settings.glassFrost / 100));
  document.documentElement.style.setProperty('--glean-liquid-glass-depth', String(settings.glassDepth / 100));
  document.documentElement.style.setProperty('--glean-liquid-glass-refraction', String(settings.glassRefraction / 100));
  screen.classList.toggle('has-accessibility-adjustments', settings.contrast !== 100 || settings.saturation !== 100);
  const systemPrefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const reduceMotion = settings.reduceMotion || systemPrefersReducedMotion;
  screen.classList.toggle('is-reduced-motion', reduceMotion);
  document.documentElement.classList.toggle('glean-reduce-motion', reduceMotion);
}
