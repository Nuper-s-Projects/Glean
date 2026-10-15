export const HARDWARE_ACCELERATION_KEY = 'glean.hardware-acceleration.v1';

export function hardwareAccelerationPreference() {
  try { return window.localStorage.getItem(HARDWARE_ACCELERATION_KEY) !== 'false'; }
  catch { return true; }
}

// Snapshot once per page load. Saving a preference must not change the live renderer.
const enabledAtStartup = hardwareAccelerationPreference();
export function isHardwareAccelerationEnabled() { return enabledAtStartup; }

export function saveHardwareAccelerationPreference(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Expected an enabled or disabled preference.');
  try { window.localStorage.setItem(HARDWARE_ACCELERATION_KEY, String(enabled)); }
  catch { throw new Error('Could not save this setting. Allow browser storage and try again.'); }
}

export function applyHardwareAcceleration() {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.gleanGpuEffects = enabledAtStartup ? 'on' : 'off';
}
