import { useEffect, useId, useRef } from 'react';

export function LoopPanelIcon({ name, size = 20 }) {
  const paths = {
    close: <path d="m6 6 12 12M6 18 18 6" />,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 10h18c0-3-3-3-3-10" /><path d="M10 21h4" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    like: <path d="M20.8 8.8c0 5.2-8.8 10.2-8.8 10.2S3.2 14 3.2 8.8A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 8.8 2.8Z" />,
    comment: <path d="M21 11a8 8 0 0 1-8 8H8l-5 3 1.5-5A8 8 0 1 1 21 11Z" />,
    reply: <><path d="m10 5-7 6 7 6" /><path d="M3 11h10c5 0 8 3 8 8" /></>,
    mention: <><circle cx="11" cy="12" r="4" /><path d="M15 8v7c0 3 6 2 6-3a9 9 0 1 0-5 8" /></>,
    follow: <><circle cx="9" cy="7" r="4" /><path d="M2 21v-2a7 7 0 0 1 14 0v2m4-14v6m-3-3h6" /></>,
    repost: <><path d="m17 2 4 4-4 4M3 6h18M7 22l-4-4 4-4M21 18H3" /><path d="M3 6v5m18 7v-5" /></>,
    play: <path d="m8 4 12 8-12 8Z" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.bell}</svg>;
}

export default function LoopPanelDialog({ title, description, icon, actions, children, onClose }) {
  const ref = useRef(null), heading = useId(), copy = useId();
  useEffect(() => {
    const previous = document.activeElement, dialog = ref.current;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className="loop-panel-dialog" aria-labelledby={heading} aria-describedby={copy}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}>
    <div className="loop-panel-shell">
      <header className="loop-panel-header"><span className="loop-panel-symbol"><LoopPanelIcon name={icon} size={22} /></span>
        <div><h2 id={heading}>{title}</h2><p id={copy}>{description}</p></div>
        <button className="loop-panel-icon-button" type="button" aria-label={`Close ${title.toLowerCase()}`} autoFocus onClick={onClose}><LoopPanelIcon name="close" /></button>
      </header>{actions}<div className="loop-panel-body">{children}</div>
    </div>
  </dialog>;
}
