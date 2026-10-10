import assert from 'node:assert/strict';
import { applyAccessibilitySettings, normalizeAccessibility } from '../src/app/accessibility.js';

function element() {
  const classes = new Set();
  const properties = new Map();
  const attributes = new Map();
  return {
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    style: { setProperty(name, value) { properties.set(name, value); }, removeProperty(name) { properties.delete(name); } },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    properties,
    attributes,
  };
}

const root = element();
let screen = element();
let deviceReducedMotion = false;
globalThis.document = { documentElement: root, querySelector: () => screen };
globalThis.window = { matchMedia: () => ({ matches: deviceReducedMotion }) };
try {
  // Existing profiles retain their API shape, but neither legacy field disables motion.
  for (const settings of [{ reduceMotion: true }, { accessibilityReduceMotion: true }, { reduceMotion: false }]) {
    root.classList.toggle('glean-reduce-motion', true);
    screen.classList.toggle('is-reduced-motion', true);
    applyAccessibilitySettings(settings);
    assert.equal(root.classList.contains('glean-reduce-motion'), false);
    assert.equal(screen.classList.contains('is-reduced-motion'), false);
  }
  assert.equal(normalizeAccessibility({ reduceMotion: true }).reduceMotion, true);
  applyAccessibilitySettings({ theme: 'dark', contrast: 120, saturation: 80, glassFrost: 65, glassDepth: 30, glassRefraction: 75, reduceMotion: true });
  assert.equal(root.attributes.get('data-theme'), 'dark');
  assert.equal(screen.properties.get('--glean-accessibility-contrast'), '120%');
  assert.equal(screen.properties.get('--glean-accessibility-saturation'), '80%');
  assert.equal(root.properties.get('--glean-liquid-glass-depth'), '0.3');
  assert.equal(root.properties.get('--glean-liquid-glass-refraction'), '0.75');
  assert.equal(screen.classList.contains('has-accessibility-adjustments'), true);
  deviceReducedMotion = true;
  applyAccessibilitySettings({ reduceMotion: false });
  assert.equal(root.classList.contains('glean-reduce-motion'), true);
  assert.equal(screen.classList.contains('is-reduced-motion'), true);
  deviceReducedMotion = false;
  screen = null;
  applyAccessibilitySettings({ reduceMotion: true });
  assert.equal(root.classList.contains('glean-reduce-motion'), false, 'clear stale motion class even before a screen mounts');
  delete globalThis.document;
  applyAccessibilitySettings({ reduceMotion: true });
  console.log('PASS: account motion preference ignored; device accessibility respected; stale classes cleared; other settings preserved.');
} finally {
  delete globalThis.document;
  delete globalThis.window;
}
