export const PROFILE_BACKGROUND_URL = /^\/api\/v1\/profile-backgrounds\/(profile-background-[a-z2-7]+\.jpg)$/;
export const PROFILE_BACKGROUND_MAX_BYTES = 8 * 1024 * 1024;
export const PROFILE_IMAGE_DEFAULTS = Object.freeze({ contrast: 100, saturation: 100, blur: 25 });

export function profileImageAdjustments(input = {}, strict = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const result = {};
  for (const [key, fallback] of Object.entries(PROFILE_IMAGE_DEFAULTS)) {
    const max = key === 'blur' ? 100 : 200;
    const value = input[key] === undefined ? fallback : input[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (strict) return null;
      result[key] = fallback;
    } else {
      if (strict && (value < 0 || value > max)) return null;
      result[key] = Math.round(Math.max(0, Math.min(max, value)));
    }
  }
  return result;
}
