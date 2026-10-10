import { useEffect, useRef } from 'react';

export default function LoopSidebar({ children }) {
  const sidebar = useRef(null);

  useEffect(() => {
    const node = sidebar.current;
    let pointerId = null;
    let key = null;
    let gesture = null;
    let frame = 0;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const release = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      gesture = null;
      pointerId = null;
      key = null;
      node.classList.remove('is-held', 'is-tracking');
    };
    const paint = () => {
      frame = 0;
      if (!gesture) return;
      const { bounds, startX, startY, x, y } = gesture;
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const dx = clamp((x - bounds.left) / width * 2 - 1, -1, 1);
      const dy = clamp((y - bounds.top) / height * 2 - 1, -1, 1);
      const movement = clamp(Math.hypot(x - startX, y - startY) / 160, 0, 1);
      // Use the original bounds, not the animated box, to avoid feedback jitter.
      // Pixel-limited deformation stays inside the existing viewport gutters.
      const scaleX = 1 + (Math.min(12, width * .055) + 2 * movement * Math.abs(dx)) / width;
      const scaleY = 1 + (Math.min(12, height * .07) + 2 * movement * Math.abs(dy)) / height;
      node.style.setProperty('--loop-press-transform', `translate(${dx * 2}px, ${dy * 2}px) scale(${scaleX}, ${scaleY}) skewY(${dx * .35}deg)`);
      node.style.setProperty('--loop-corner-tl', `${2 - (dx + dy) * 3}px`);
      node.style.setProperty('--loop-corner-tr', `${2 + (dx - dy) * 3}px`);
      node.style.setProperty('--loop-corner-br', `${2 + (dx + dy) * 3}px`);
      node.style.setProperty('--loop-corner-bl', `${2 + (dy - dx) * 3}px`);
      node.style.setProperty('--loop-glare-x', `${clamp((x - bounds.left) / width * 100, 0, 100)}%`);
      node.style.setProperty('--loop-glare-y', `${clamp((y - bounds.top) / height * 100, 0, 100)}%`);
      node.style.setProperty('--loop-glare-width', `${Math.min(180, width * .55) * (1 + movement * 1.1)}px`);
      node.style.setProperty('--loop-glare-height', `${Math.min(240, height * .5) * (1 + movement * 1.1)}px`);
      node.style.setProperty('--loop-glare-opacity', String(1 - movement * .6));
    };
    const press = (x, y) => {
      if (frame) cancelAnimationFrame(frame);
      gesture = { bounds: node.getBoundingClientRect(), startX: x, startY: y, x, y };
      node.classList.remove('is-tracking');
      paint();
      node.classList.add('is-held');
    };
    const pointerMove = (event) => {
      if (event.pointerId !== pointerId || !gesture) return;
      if (event.buttons === 0) { release(); return; }
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      node.classList.add('is-tracking');
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const pointerDown = (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      pointerId = event.pointerId;
      press(event.clientX, event.clientY);
    };
    const pointerEnd = (event) => { if (event.pointerId === pointerId) release(); };
    const keyDown = (event) => {
      if (event.repeat || pointerId !== null || ![' ', 'Enter'].includes(event.key) || !event.target.closest('button, a')) return;
      key = event.key;
      const bounds = event.target.getBoundingClientRect();
      press(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    };
    const keyUp = (event) => { if (event.key === key) release(); };
    const focusOut = (event) => { if (key !== null && !node.contains(event.relatedTarget)) release(); };
    const visibilityChange = () => { if (document.hidden) release(); };
    node.addEventListener('pointerdown', pointerDown, { passive: true });
    node.addEventListener('keydown', keyDown);
    node.addEventListener('focusout', focusOut);
    window.addEventListener('pointerup', pointerEnd, { passive: true });
    window.addEventListener('pointercancel', pointerEnd, { passive: true });
    window.addEventListener('pointermove', pointerMove, { passive: true });
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', release);
    window.addEventListener('resize', release);
    document.addEventListener('visibilitychange', visibilityChange);
    return () => {
      release();
      node.removeEventListener('pointerdown', pointerDown);
      node.removeEventListener('keydown', keyDown);
      node.removeEventListener('focusout', focusOut);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', release);
      window.removeEventListener('resize', release);
      document.removeEventListener('visibilitychange', visibilityChange);
    };
  }, []);

  return <aside ref={sidebar} className="loop-sidebar">{children}</aside>;
}
