// Visual work is capped while the page is hidden or the user has been idle.
const IDLE_AFTER_MS = 30_000;
const IDLE_FRAME_INTERVAL = 1000 / 30;
const listeners = new Set();
let lastInteractionAt = typeof performance === 'undefined' ? 0 : performance.now();
let idleTimer = null;
let activityEventsAttached = false;

const changed = () => {
  const activity = pageActivity();
  for (const listener of [...listeners]) listener(activity);
};

const scheduleIdleCheck = () => {
  clearTimeout(idleTimer);
  if (!listeners.size || document.visibilityState === 'hidden' || !document.hasFocus()) return;
  const remaining = IDLE_AFTER_MS - (performance.now() - lastInteractionAt);
  if (remaining <= 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
      scheduleIdleCheck();
    changed();
  }, remaining);
};

const noteInteraction = () => {
  const wasActive = pageActivity() === 'active';
  lastInteractionAt = performance.now();
  if (!wasActive || idleTimer === null) scheduleIdleCheck();
  if (!wasActive && pageActivity() === 'active') changed();
};

const onFocusChange = () => {
  scheduleIdleCheck();
  changed();
};

const interactionEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll', 'click'];

function attachActivityEvents() {
  if (activityEventsAttached || typeof window === 'undefined') return;
  activityEventsAttached = true;
  for (const event of interactionEvents) window.addEventListener(event, noteInteraction, { passive: true, capture: event === 'scroll' });
  document.addEventListener('visibilitychange', onFocusChange);
  window.addEventListener('focus', onFocusChange);
  window.addEventListener('blur', onFocusChange);
  scheduleIdleCheck();
}

function detachActivityEvents() {
  if (!activityEventsAttached) return;
  activityEventsAttached = false;
  clearTimeout(idleTimer);
  idleTimer = null;
  for (const event of interactionEvents) window.removeEventListener(event, noteInteraction, { capture: event === 'scroll' });
  document.removeEventListener('visibilitychange', onFocusChange);
  window.removeEventListener('focus', onFocusChange);
  window.removeEventListener('blur', onFocusChange);
}

export function pageActivity() {
  if (typeof document === 'undefined') return 'active';
  if (document.visibilityState === 'hidden') return 'hidden';
  return document.hasFocus() && performance.now() - lastInteractionAt < IDLE_AFTER_MS ? 'active' : 'idle';
}

export function subscribePageActivity(listener) {
  if (typeof window === 'undefined') return () => {};
  if (!listeners.size) {
    attachActivityEvents();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) detachActivityEvents();
  };
}

// Gate JavaScript animation callbacks as a group so the app never schedules
// more than 30 visual frames per second while the page is idle or unfocused.
// Network, audio, timers, and media playback continue on their own clocks.
export function limitAnimationFramesWhileIdle() {
  if (typeof window === 'undefined' || window.__gleanIdleFrameLimiter) return () => {};
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  let nextId = 1;
  let lastFrameAt = -Infinity;
  let nativeFrame = null;
  let gateTimer = null;
  let callbacks = new Map();
  let stopped = false;

  const cancelScheduled = () => {
    if (nativeFrame !== null) nativeCancel(nativeFrame);
    if (gateTimer !== null) clearTimeout(gateTimer);
    nativeFrame = gateTimer = null;
  };

  const schedule = () => {
    if (stopped || nativeFrame !== null || gateTimer !== null || !callbacks.size) return;
    if (pageActivity() === 'hidden') return;
    if (pageActivity() === 'idle') {
      const remaining = IDLE_FRAME_INTERVAL - (performance.now() - lastFrameAt);
      if (remaining > 0) {
        gateTimer = setTimeout(() => {
          gateTimer = null;
          schedule();
        }, remaining);
        return;
      }
    }
    nativeFrame = nativeRequest(flush);
  };

  const flush = (timestamp) => {
    nativeFrame = null;
    const activity = pageActivity();
    if (activity === 'hidden') return;
    if (activity === 'idle' && timestamp - lastFrameAt < IDLE_FRAME_INTERVAL) {
      schedule();
      return;
    }
    lastFrameAt = timestamp;
    const batch = callbacks;
    callbacks = new Map();
    for (const callback of batch.values()) {
      try { callback(timestamp); }
      catch (error) { setTimeout(() => { throw error; }, 0); }
    }
    schedule();
  };

  const request = (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Animation frame callback must be a function.');
    const id = nextId++;
    callbacks.set(id, callback);
    schedule();
    return id;
  };

  const cancel = (id) => {
    callbacks.delete(id);
    if (!callbacks.size) cancelScheduled();
  };

  const unsubscribe = subscribePageActivity(() => {
    cancelScheduled();
    schedule();
  });
  window.requestAnimationFrame = request;
  window.cancelAnimationFrame = cancel;
  window.__gleanIdleFrameLimiter = true;
  schedule();

  return () => {
    stopped = true;
    cancelScheduled();
    callbacks.clear();
    unsubscribe();
    if (window.requestAnimationFrame === request) window.requestAnimationFrame = nativeRequest;
    if (window.cancelAnimationFrame === cancel) window.cancelAnimationFrame = nativeCancel;
    delete window.__gleanIdleFrameLimiter;
  };
}

export function startVisualLoop(draw) {
  let frame = null;
  let timer = null;
  let stopped = false;
  let last = -Infinity;
  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = timer = null;
  };
  const schedule = () => {
    if (stopped || pageActivity() === 'hidden') return;
    const wait = pageActivity() === 'idle' ? Math.max(0, 1000 / 30 - (performance.now() - last)) : 0;
    if (wait > 0) timer = setTimeout(() => { timer = null; schedule(); }, wait);
    else frame = requestAnimationFrame(tick);
  };
  const tick = (now) => {
    frame = null;
    if (stopped || pageActivity() === 'hidden') return;
    // Recheck focus here too: it may change after a frame has been requested.
    if (pageActivity() === 'idle' && now - last < 1000 / 30) { schedule(); return; }
    last = now;
    if (draw(now) === false) { stop(); return; }
    schedule();
  };
  const unsubscribe = subscribePageActivity(() => { cancel(); schedule(); });
  const stop = () => { stopped = true; cancel(); unsubscribe(); };
  schedule();
  return stop;
}
