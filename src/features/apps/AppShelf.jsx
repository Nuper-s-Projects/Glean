import { useEffect, useRef } from 'react';
import { APP_CATALOG } from './catalog';
import { CloseIcon } from '../dm/icons';

export default function AppShelf({ session, onLaunch, onJoin, onClose, error }) {
  const panelRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    const onPointerDown = (event) => {
      if (!panelRef.current || panelRef.current.contains(event.target)) return;
      if (event.target.closest?.('.community-apps-button')) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  return (
    <div className="glean-app-shelf" role="dialog" aria-label="Apps" ref={panelRef}>
      <header>
        <strong>Apps</strong>
        <button type="button" onClick={onClose} aria-label="Close apps"><CloseIcon /></button>
      </header>
      {error ? <p className="glean-app-error" role="alert">{error}</p> : null}
      <ul>
        {APP_CATALOG.map((app) => {
          const live = session?.appId === app.id;
          return (
            <li key={app.id}>
              <span className="glean-app-mark" style={{ background: `color-mix(in srgb, ${app.accent} 26%, transparent)`, borderColor: app.accent }} aria-hidden="true">
                {app.name.slice(0, 1)}
              </span>
              <span className="glean-app-copy">
                <strong>{app.name}</strong>
                <small>{live ? `Live · ${session.participantCount} in app` : app.tagline}</small>
              </span>
              <button type="button" onClick={() => (live ? onJoin() : onLaunch(app.id))}>
                {live ? 'Join' : 'Start'}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="glean-app-note">Everyone in this call can join. Leaving an app keeps you in voice.</p>
    </div>
  );
}
