import { getPushVapidKey, subscribeDesktopPush, unsubscribeDesktopPush } from './dmApi';
import { registerServiceWorker } from './pwa';

let started = false;
let currentEndpoint = '';

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function matchesFocus(payload) {
  if (payload?.serverId) {
    try { if (window.localStorage.getItem(`glean.mutedServer.${Number(payload.serverId)}`) === '1') return true; } catch { /* ignore storage failures */ }
  }
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  const path = window.location.pathname;
  if (payload?.kind === 'dm') return path === '/dms' && Number(window.__gleanPushFocus?.id) === Number(payload.conversationId);
  if (payload?.kind === 'channel') return path === '/servers' && Number(window.__gleanPushFocus?.id) === Number(payload.channelId);
  if (payload?.kind === 'friends') return path === '/dms';
  if (payload?.kind === 'test' || payload?.kind === 'announcement') return false;
  return path === '/dms' || path === '/servers';
}

function openFromPayload(payload) {
  const url = payload?.url || '/dms';
  try {
    if (payload?.serverId) sessionStorage.setItem('glean.activeServerId', String(payload.serverId));
    if (payload?.channelId) sessionStorage.setItem('glean.activeChannelId', String(payload.channelId));
    if (payload?.conversationId) sessionStorage.setItem('glean.openConversationId', String(payload.conversationId));
  } catch { /* ignore */ }
  if (`${window.location.pathname}${window.location.search}` !== url) {
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  window.dispatchEvent(new CustomEvent('glean-open-target', { detail: payload || {} }));
}

async function registration() {
  return registerServiceWorker();
}

async function persistSubscription() {
  if (!('PushManager' in window) || Notification.permission !== 'granted') return false;
  const worker = await registration();
  if (!worker) return false;
  const ready = await navigator.serviceWorker.ready;
  const key = await getPushVapidKey();
  let subscription = await ready.pushManager.getSubscription();
  if (!subscription) {
    subscription = await ready.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key.publicKey),
    });
  }
  const raw = subscription.toJSON();
  currentEndpoint = raw.endpoint || '';
  await subscribeDesktopPush(raw);
  return true;
}

export function setPushFocus(next) {
  window.__gleanPushFocus = next || null;
}

export async function startDesktopPush() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  if (!started) {
    started = true;
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'glean-should-notify') {
        event.ports?.[0]?.postMessage({ skip: matchesFocus(event.data.payload) });
        return;
      }
      if (event.data?.type === 'glean-open') openFromPayload(event.data);
    });
  }
  await registration();
  if (Notification.permission === 'granted') await persistSubscription().catch(() => {});
}

export async function enableDesktopPush() {
  if (!('Notification' in window) || !window.isSecureContext) throw new Error('This browser cannot show desktop notifications.');
  await registration();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for Glean in this browser.' : 'Notifications were not allowed.');
  await persistSubscription();
  return true;
}

export async function disableDesktopPush() {
  try {
    const ready = await navigator.serviceWorker.ready;
    const subscription = await ready.pushManager.getSubscription();
    const endpoint = subscription?.endpoint || currentEndpoint;
    if (endpoint) await unsubscribeDesktopPush(endpoint).catch(() => {});
    await subscription?.unsubscribe();
  } catch { /* ignore */ }
  currentEndpoint = '';
}

export function notificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}
