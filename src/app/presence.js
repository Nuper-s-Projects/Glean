import { useEffect, useState } from 'react';

const listeners = new Set();
const listenersByUser = new Map();
const byUser = new Map();
let activitySend = null;
let activityBound = false;
let lastInput = 0;
let lastPulse = 0;

function emit(changedUsers) {
  for (const id of changedUsers) {
    listenersByUser.get(id)?.forEach((listener) => listener());
  }
  listeners.forEach((listener) => listener());
}

function normalizeStatus(value) {
  return ['online', 'idle', 'dnd'].includes(value) ? value : 'offline';
}

function applyPresence(item) {
  if (item?.userId == null) return false;
  const id = Number(item.userId);
  const prev = byUser.get(id) || { status: 'offline', hidden: false };
  const next = {
    status: normalizeStatus(item.status),
    hidden: item.hidden == null ? prev.hidden : Boolean(item.hidden),
  };
  if (byUser.has(id) && prev.status === next.status && prev.hidden === next.hidden) return false;
  byUser.set(id, next);
  return true;
}

export function ingestPresence(payload) {
  if (!payload) return;
  const items = Array.isArray(payload.users) ? payload.users : [payload];
  const changedUsers = new Set();
  for (const item of items) {
    if (applyPresence(item)) changedUsers.add(Number(item.userId));
  }
  if (changedUsers.size) emit(changedUsers);
}

export function presenceOf(userId, fallback = 'offline') {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return fallback;
  return byUser.has(id) ? byUser.get(id).status : fallback;
}

export function presenceHiddenOf(userId, fallback = false) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return fallback;
  return byUser.has(id) ? byUser.get(id).hidden : fallback;
}

export function subscribePresence(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function subscribeUserPresence(userId, listener) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return () => {};
  let userListeners = listenersByUser.get(id);
  if (!userListeners) {
    userListeners = new Set();
    listenersByUser.set(id, userListeners);
  }
  userListeners.add(listener);
  return () => {
    userListeners.delete(listener);
    if (!userListeners.size) listenersByUser.delete(id);
  };
}

export function usePresence(userId, fallback = 'offline') {
  const [, bump] = useState(0);
  useEffect(() => {
    if (fallback === '' || !Number.isInteger(Number(userId)) || Number(userId) <= 0) return undefined;
    return subscribeUserPresence(userId, () => bump((value) => value + 1));
  }, [fallback, userId]);
  return presenceOf(userId, fallback);
}

export function usePresenceHidden(userId, fallback = false) {
  const [, bump] = useState(0);
  useEffect(() => subscribePresence(() => bump((value) => value + 1)), []);
  return presenceHiddenOf(userId, fallback);
}

export function presenceLabel(status, hidden = false) {
  if (hidden) return 'Invisible';
  if (status === 'online') return 'Online';
  if (status === 'idle') return 'Idle';
  if (status === 'dnd') return 'Do Not Disturb';
  return 'Offline';
}

function pulse() {
  const now = Date.now();
  if (now - lastInput > 20_000) return;
  if (now - lastPulse < 8_000) return;
  lastPulse = now;
  activitySend?.();
}

export function bindPresenceActivity(send) {
  activitySend = send;
  lastInput = Date.now();
  lastPulse = 0;
  pulse();
  if (activityBound) return;
  activityBound = true;
  const onInput = () => {
    lastInput = Date.now();
    pulse();
  };
  window.addEventListener('pointerdown', onInput);
  window.addEventListener('keydown', onInput);
  window.addEventListener('mousemove', onInput, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onInput();
  });
  window.setInterval(pulse, 15_000);
}

export function clearPresenceActivity() {
  activitySend = null;
}
