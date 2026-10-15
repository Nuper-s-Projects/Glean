import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import EmojiPicker from '../dm/EmojiPicker';

const THEME_VARIABLES = ['--card-background', '--page-background', '--text', '--muted-text', '--dm-border', '--input-background', '--input-border', '--accent', '--accent-soft'];

export default function ReactionPicker({ anchorRef, onPick, onClose }) {
  const overlayRef = useRef(null);
  const previousFocus = useRef(document.activeElement);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const anchor = anchorRef.current?.querySelector('.community-message-react') || anchorRef.current;
    if (!overlay || !anchor) return;
    const previous = previousFocus.current;
    const palette = getComputedStyle(anchor);
    for (const variable of THEME_VARIABLES) overlay.style.setProperty(variable, palette.getPropertyValue(variable));

    const position = () => {
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft || 0;
      const y = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const bounds = anchor.getBoundingClientRect();
      const pickerWidth = Math.min(340, Math.max(1, width - 24));
      const pickerHeight = Math.min(380, Math.max(1, height - 24));
      const below = bounds.bottom + 8;
      const above = bounds.top - pickerHeight - 8;
      const preferredTop = below + pickerHeight <= y + height - 12 ? below : above;
      overlay.style.width = `${pickerWidth}px`;
      overlay.style.setProperty('--reaction-picker-height', `${pickerHeight}px`);
      overlay.style.left = `${Math.max(x + 12, Math.min(bounds.right - pickerWidth, x + width - pickerWidth - 12))}px`;
      overlay.style.top = `${Math.max(y + 12, Math.min(preferredTop, y + height - pickerHeight - 12))}px`;
    };
    const scrollContainer = anchor.closest('.community-messages');
    // New messages can auto-scroll the transcript. Keep the picker attached to
    // its message, closing only when that message is no longer visible.
    const onScroll = event => {
      if (overlay.contains(event.target)) return;
      if (scrollContainer) {
        const anchorBounds = anchor.getBoundingClientRect();
        const containerBounds = scrollContainer.getBoundingClientRect();
        if (anchorBounds.bottom <= containerBounds.top || anchorBounds.top >= containerBounds.bottom) {
          closeRef.current();
          return;
        }
      }
      position();
    };
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      if ((overlay.contains(document.activeElement) || document.activeElement === document.body) && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [anchorRef]);

  return createPortal(
    <div ref={overlayRef} className="community-reaction-picker" onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
      <EmojiPicker onPick={onPick} />
    </div>,
    document.body,
  );
}
