const listeners = new Set();
let registerPromise = null;
let deferredPrompt = null;
let waitingWorker = null;
let started = false;
let offline = typeof navigator !== 'undefined' ? navigator.onLine === false : false;
let connectivityProbe = null;

function readFlag(key) {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeFlag(key, on) {
  try {
    if (on) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch { /* ignore */ }
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: window-controls-overlay)').matches
    || window.navigator.standalone === true;
}

export function isIosDevice() {
  const ua = String(navigator.userAgent || '');
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isIosSafari() {
  const ua = String(navigator.userAgent || '');
  return isIosDevice() && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|Chrome|Android/.test(ua);
}

function emit() {
  if (typeof window === 'undefined') return;
  const state = getPwaState();
  listeners.forEach((listener) => listener(state));
}

export function getPwaState() {
  const standalone = isStandalone();
  return {
    standalone,
    ios: isIosSafari(),
    canInstall: Boolean(deferredPrompt) && !standalone,
    updateReady: Boolean(waitingWorker),
    offline,
    showIosInstall: isIosSafari() && !standalone && !readFlag('glean.dismissIosInstall'),
    showChromeInstall: Boolean(deferredPrompt) && !standalone && !readFlag('glean.dismissInstall'),
  };
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return Promise.resolve(null);
  registerPromise ||= navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return registerPromise;
}

export function dismissInstallHint() {
  writeFlag('glean.dismissInstall', true);
  emit();
}

export function dismissIosInstallHint() {
  writeFlag('glean.dismissIosInstall', true);
  emit();
}

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  writeFlag('glean.dismissInstall', true);
  emit();
  return outcome === 'accepted';
}

export function applyUpdate() {
  waitingWorker?.postMessage({ type: 'glean-skip-waiting' });
}

export function subscribePwa(listener) {
  listeners.add(listener);
  listener(getPwaState());
  return () => listeners.delete(listener);
}

export function reportNetworkActivity(connected) {
  const nextOffline = !connected;
  if (offline === nextOffline) return;
  offline = nextOffline;
  emit();
}

async function verifyConnectivity() {
  if (typeof navigator === 'undefined' || navigator.onLine === false) {
    reportNetworkActivity(false);
    return;
  }
  if (connectivityProbe) return connectivityProbe;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5000);
  connectivityProbe = fetch('/api/health', {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  }).then(() => {
    reportNetworkActivity(true);
  }).catch(() => {
    reportNetworkActivity(false);
  }).finally(() => {
    window.clearTimeout(timer);
    connectivityProbe = null;
  });
  return connectivityProbe;
}

export function startPwa() {
  if (started) return;
  started = true;
  if (isStandalone()) document.documentElement.classList.add('is-standalone');
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    writeFlag('glean.dismissInstall', true);
    emit();
  });
  window.addEventListener('online', () => { verifyConnectivity(); });
  window.addEventListener('offline', () => { reportNetworkActivity(false); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') verifyConnectivity();
  });
  verifyConnectivity();
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) window.location.reload();
  });
  registerServiceWorker().then((registration) => {
    if (!registration) return;
    const track = (worker) => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = worker;
          emit();
        }
      });
    };
    track(registration.installing);
    if (registration.waiting && navigator.serviceWorker.controller) {
      waitingWorker = registration.waiting;
      emit();
    }
    registration.addEventListener('updatefound', () => track(registration.installing));
    registration.update().catch(() => {});
  }).catch(() => {});
}

export function formatUnreadCount(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  if (!count) return '';
  return count > 99 ? '99+' : String(count);
}

export function setAppBadge(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  if (typeof navigator === 'undefined') return;
  const next = count ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();
  Promise.resolve(next).catch(() => {});
}
