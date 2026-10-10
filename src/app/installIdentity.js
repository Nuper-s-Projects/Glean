const INSTALL_ID_KEY = 'glean.installation-id.v1';
let cachedInstallId = null;

function createInstallId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// A random installation token, not a hardware or browser fingerprint.
export function getInstallId() {
  if (cachedInstallId !== null) return cachedInstallId;
  try {
    const existing = window.localStorage.getItem(INSTALL_ID_KEY);
    if (/^[A-Za-z0-9_-]{43}$/.test(existing || '')) {
      cachedInstallId = existing;
      return cachedInstallId;
    }
    cachedInstallId = createInstallId();
    window.localStorage.setItem(INSTALL_ID_KEY, cachedInstallId);
    return cachedInstallId;
  } catch {
    cachedInstallId = '';
    return cachedInstallId;
  }
}
