import { useCallback, useEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD = 96;

function isNearBottom(node) {
  return !node || node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD;
}

function stickBottom(node, behavior = 'auto') {
  if (!node) return;
  node.scrollTo({ top: node.scrollHeight, behavior });
}

export function useChatAutoscroll(scrollRef, roomId, tailId) {
  const lastRoom = useRef(null);
  const lastTail = useRef(null);
  const pin = useRef(false);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  const setBottomState = useCallback((value) => {
    atBottomRef.current = value;
    setAtBottom(value);
    if (value) setHasNewMessages(false);
  }, []);

  const jumpToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    pin.current = true;
    setHasNewMessages(false);
    setBottomState(true);
    stickBottom(node, 'smooth');
    window.setTimeout(() => {
      pin.current = false;
      setBottomState(isNearBottom(node));
    }, 360);
  }, [scrollRef, setBottomState]);

  useEffect(() => {
    if (roomId == null) {
      lastRoom.current = null;
      lastTail.current = null;
      pin.current = false;
      setBottomState(true);
      setHasNewMessages(false);
      return undefined;
    }
    const node = scrollRef.current;
    if (!node) return undefined;

    const changedRoom = lastRoom.current !== roomId;
    const changedTail = !changedRoom && lastTail.current != null && lastTail.current !== tailId;
    const shouldStick = changedRoom || pin.current || atBottomRef.current;
    lastRoom.current = roomId;
    lastTail.current = tailId;

    if (changedRoom) {
      pin.current = true;
      setHasNewMessages(false);
      setBottomState(true);
    } else if (changedTail && !shouldStick) {
      setHasNewMessages(true);
    }

    const snap = () => {
      if (shouldStick) stickBottom(node);
    };
    snap();
    const frames = [];
    frames.push(window.requestAnimationFrame(() => {
      snap();
      frames.push(window.requestAnimationFrame(snap));
    }));
    const timer = window.setTimeout(snap, 80);
    const later = window.setTimeout(() => {
      if (shouldStick) {
        stickBottom(node);
        setBottomState(true);
      }
      pin.current = false;
    }, 240);
    return () => {
      frames.forEach((id) => window.cancelAnimationFrame(id));
      window.clearTimeout(timer);
      window.clearTimeout(later);
    };
  }, [roomId, scrollRef, setBottomState, tailId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || roomId == null) return undefined;

    const onScroll = () => setBottomState(isNearBottom(node));
    const snapForResize = () => {
      if (pin.current || atBottomRef.current) stickBottom(node);
      setBottomState(isNearBottom(node));
    };
    const observer = new ResizeObserver(snapForResize);
    observer.observe(node);
    const end = node.querySelector('[data-chat-end]');
    if (end) observer.observe(end);
    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('load', snapForResize, true);
    onScroll();
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('load', snapForResize, true);
    };
  }, [roomId, scrollRef, setBottomState]);

  return { atBottom, hasNewMessages, jumpToBottom };
}
