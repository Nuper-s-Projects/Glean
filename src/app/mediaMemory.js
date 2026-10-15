// Only attachment players opt in. Live calls and their MediaStreams are untouched.
export function manageMediaMemory(element, source, { observe = element, onNear = () => {} } = {}) {
  if (element.hasAttribute('data-memory-suspended') && !element.hasAttribute('src')) {
    element.setAttribute('src', source);
    element.load();
  }
  element.removeAttribute('data-memory-suspended');
  let enabled = false, near = true, detached = false, time = 0;
  const restore = () => {
    if (!detached) return;
    detached = false;
    element.removeAttribute('data-memory-suspended');
    element.setAttribute('src', source);
    element.load();
  };
  const update = () => {
    if (!enabled || near || !element.paused || element.srcObject
      || document.fullscreenElement?.contains(element) || element.webkitDisplayingFullscreen) {
      restore(); return;
    }
    if (detached) return;
    time = element.currentTime || 0;
    detached = true;
    element.setAttribute('data-memory-suspended', 'true');
    element.removeAttribute('src');
    // Removing src alone does not release buffered/decoded media.
    element.load();
  };
  const metadata = () => {
    if (time > 0 && Number.isFinite(element.duration)) element.currentTime = Math.min(time, Math.max(0, element.duration - .05));
    time = 0;
  };
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    near = entries[0].isIntersecting;
    onNear(near);
    update();
  }, { rootMargin: '100px' });
  observer?.observe(observe);
  element.addEventListener('pause', update);
  element.addEventListener('ended', update);
  element.addEventListener('loadedmetadata', metadata);
  document.addEventListener('fullscreenchange', update);
  return {
    setEnabled(value) { enabled = value; update(); },
    dispose() {
      observer?.disconnect();
      element.removeEventListener('pause', update);
      element.removeEventListener('ended', update);
      element.removeEventListener('loadedmetadata', metadata);
      document.removeEventListener('fullscreenchange', update);
    },
  };
}
