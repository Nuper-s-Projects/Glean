import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const OVERLAY_ID = 'glean-reorder-overlay';

function lockReorderCursor(pointerId) {
  document.documentElement.classList.add('glean-reordering');
  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(overlay);
  }
  try { overlay.setPointerCapture(pointerId); } catch { /* ignore */ }
}

function unlockReorderCursor() {
  document.documentElement.classList.remove('glean-reordering');
  document.getElementById(OVERLAY_ID)?.remove();
}

export default function useHoldReorder({
  items = [],
  enabled = true,
  onReorder,
  allowTouch = true,
  holdMs = 180,
  slop = 8,
} = {}) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const allowTouchRef = useRef(allowTouch);
  allowTouchRef.current = allowTouch;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const sessionRef = useRef(null);
  const [draggingId, setDraggingId] = useState(null);
  const [orderedIds, setOrderedIds] = useState(null);

  const displayed = useMemo(() => {
    if (!orderedIds) return items;
    const map = new Map(items.map((item) => [String(item.id), item]));
    return orderedIds.map((id) => map.get(String(id))).filter(Boolean);
  }, [items, orderedIds]);

  const stopSession = useCallback((commit) => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    window.removeEventListener('pointermove', session.onMove);
    window.removeEventListener('pointerup', session.onUp);
    window.removeEventListener('pointercancel', session.onCancel);
    unlockReorderCursor();
    if (session.pointerId != null && session.target?.hasPointerCapture?.(session.pointerId)) {
      try { session.target.releasePointerCapture(session.pointerId); } catch { /* ignore */ }
    }
    if (session.armed && session.moved) {
      const blockClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      session.target?.addEventListener('click', blockClick, true);
      window.setTimeout(() => session.target?.removeEventListener('click', blockClick, true), 80);
    }
    const nextIds = session.ids;
    const startIds = session.startIds;
    setDraggingId(null);
    setOrderedIds(null);
    if (!commit || !session.armed || !nextIds || !startIds || nextIds.join() === startIds.join()) return;
    const map = new Map(itemsRef.current.map((item) => [String(item.id), item]));
    const nextItems = nextIds.map((id) => map.get(String(id))).filter(Boolean);
    if (nextItems.length === itemsRef.current.length) onReorderRef.current?.(nextItems);
  }, []);

  useEffect(() => () => stopSession(false), [stopSession]);

  const bind = useCallback((id) => {
    const key = String(id);
    return {
      'data-reorder-id': key,
      onPointerDown(event) {
        if (!enabledRef.current || itemsRef.current.length < 2) return;
        if (event.isPrimary === false) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (!allowTouchRef.current && event.pointerType !== 'mouse') return;
        if (event.target.closest?.('[data-no-reorder]')) return;
        stopSession(false);
        const startIds = itemsRef.current.map((item) => String(item.id));
        const session = {
          id: key,
          startX: event.clientX,
          startY: event.clientY,
          startIds,
          ids: startIds.slice(),
          armed: false,
          ready: false,
          moved: false,
          pointerId: event.pointerId,
          target: event.currentTarget,
          list: event.currentTarget.closest('[data-reorder-list]'),
        };
        const armSession = () => {
          if (sessionRef.current !== session || session.armed) return;
          if (session.timer) clearTimeout(session.timer);
          session.timer = null;
          session.armed = true;
          try { session.target?.setPointerCapture(session.pointerId); } catch { /* ignore */ }
          lockReorderCursor(session.pointerId);
          setDraggingId(session.id);
          setOrderedIds(session.ids.slice());
        };
        const onMove = (moveEvent) => {
          if (moveEvent.pointerId !== session.pointerId) return;
          const dx = moveEvent.clientX - session.startX;
          const dy = moveEvent.clientY - session.startY;
          if (!session.armed) {
            const distance = Math.hypot(dx, dy);
            if (distance === 0 || (!session.ready && distance <= slop)) return;
            armSession();
          }
          moveEvent.preventDefault();
          session.moved = true;
          const list = session.list;
          if (!list) return;
          const nodes = [...list.querySelectorAll('[data-reorder-id]')];
          const others = nodes.filter((node) => node.getAttribute('data-reorder-id') !== session.id);
          const without = session.ids.filter((itemId) => itemId !== session.id);
          let insertAt = without.length;
          if (others.length) {
            const first = others[0].getBoundingClientRect();
            const last = others[others.length - 1].getBoundingClientRect();
            const dragged = nodes.find((node) => node.getAttribute('data-reorder-id') === session.id)?.getBoundingClientRect();
            const horizontal = others.length > 1
              ? Math.abs(last.left - first.left) >= Math.abs(last.top - first.top)
              : Boolean(dragged && Math.abs(dragged.left - first.left) >= Math.abs(dragged.top - first.top));
            for (let index = 0; index < others.length; index += 1) {
              const rect = others[index].getBoundingClientRect();
              const before = horizontal
                ? moveEvent.clientX < rect.left + rect.width / 2
                : moveEvent.clientY < rect.top + rect.height / 2;
              if (before) {
                insertAt = index;
                break;
              }
            }
          }
          const next = without.slice();
          next.splice(insertAt, 0, session.id);
          if (next.join() === session.ids.join()) return;
          session.ids = next;
          setOrderedIds(next);
        };
        const onUp = (upEvent) => {
          if (upEvent.pointerId !== session.pointerId) return;
          stopSession(true);
        };
        const onCancel = (cancelEvent) => {
          if (cancelEvent.pointerId !== session.pointerId) return;
          stopSession(false);
        };
        session.onMove = onMove;
        session.onUp = onUp;
        session.onCancel = onCancel;
        session.timer = window.setTimeout(() => {
          if (sessionRef.current !== session) return;
          session.timer = null;
          session.ready = true;
        }, holdMs);
        sessionRef.current = session;
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
      },
    };
  }, [holdMs, slop, stopSession]);

  return {
    items: displayed,
    draggingId,
    isDragging: draggingId != null,
    bind,
  };
}
