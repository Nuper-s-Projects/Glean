const CACHE = 'glean-shell-__GLEAN_PWA_VERSION__';
const BUILD_VERSION = CACHE.slice('glean-shell-'.length);
const SHELL = [
  '/index.html',
  '/',
  '/glean-mark.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/badge-72.png',
  '/manifest.webmanifest',
  '/pwa-assets.json',
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isRealtime(url) {
  return url.pathname === '/api/realtime' || url.pathname.endsWith('/realtime');
}

function isAsset(url) {
  return url.pathname.startsWith('/assets/');
}

function isPrivateMedia(url) {
  return url.pathname.startsWith('/uploads/')
    || url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/attachments/');
}

async function precache() {
  const manifestResponse = await fetch('/pwa-assets.json', { cache: 'reload' });
  if (!manifestResponse.ok) throw new Error('Could not load the offline asset list.');
  const manifest = await manifestResponse.json();
  if (manifest.version !== BUILD_VERSION || !Array.isArray(manifest.assets) || !manifest.assets.every((path) => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//'))) {
    throw new Error('The offline asset list is invalid.');
  }
  const cache = await caches.open(CACHE);
  const paths = [...new Set([...SHELL, ...manifest.assets])];
  const responses = await Promise.all(paths.map(async (path) => {
    const response = await fetch(path, { cache: 'reload' });
    if (!response.ok) throw new Error(`Could not cache offline app file: ${path}`);
    if ((path === '/' || path === '/index.html') && !(await response.clone().text()).includes('id="root"')) {
      throw new Error('The server did not return the Glean app shell.');
    }
    return [path, response];
  }));
  await Promise.all(responses.map(([path, response]) => cache.put(path, response)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await precache();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'glean-skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  const url = new URL(request.url);
  if (!sameOrigin(url) || isPrivateMedia(url) || isRealtime(url)) return;
  if (url.pathname === '/sw.js') return;

  // Build output has content-addressed JS/CSS names; cached copies are immutable
  // and can be served immediately without delaying app startup on the network.
  if (isAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        if (fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(request);
      if (fresh.ok && request.mode === 'navigate' && (await fresh.clone().text()).includes('id="root"')) {
        cache.put(request, fresh.clone()).catch(() => {});
        cache.put('/', fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        return (await cache.match('/')) || (await cache.match('/index.html')) || Response.error();
      }
      return Response.error();
    }
  })());
});

function askClient(client, payload) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 250);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(Boolean(event.data?.skip));
    };
    try {
      client.postMessage({ type: 'glean-should-notify', payload }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

async function shouldNotify(payload) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!windows.length) return true;
  for (const client of windows) {
    if (!client.focused) continue;
    if (await askClient(client, payload)) return false;
  }
  return true;
}

self.addEventListener('push', (event) => {
  const payload = (() => {
    try { return event.data?.json() || {}; } catch { return {}; }
  })();
  event.waitUntil((async () => {
    if (!(await shouldNotify(payload))) return;
    const title = String(payload.title || 'Glean');
    await self.registration.showNotification(title, {
      body: String(payload.body || 'New activity'),
      icon: String(payload.icon || '/icon-192.png'),
      badge: '/badge-72.png',
      tag: String(payload.tag || 'glean'),
      renotify: true,
      data: payload,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const payload = event.notification.data || {};
  const url = String(payload.url || '/dms');
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      client.postMessage({ type: 'glean-open', ...payload, url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
