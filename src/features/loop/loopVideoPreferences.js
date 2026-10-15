const captionPreferenceKey = 'glean-loop-video-cc-v1';
export function readCaptionPreference() {
  try { return localStorage.getItem(captionPreferenceKey) === 'on'; } catch { return false; }
}
export function setCaptionPreference(enabled) {
  try { localStorage.setItem(captionPreferenceKey, enabled ? 'on' : 'off'); } catch { /* Storage may be disabled in private browsing. */ }
  window.dispatchEvent(new Event('glean-loop-cc'));
}
