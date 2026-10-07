import { useEffect, useState } from 'react';
import { getInvitePreview, joinServerByInvite } from '../../app/dmApi';
import { bannerStyle } from '../dm/banner';
import { formatEstablished } from '../dm/formatters';
import { ServerIcon } from './CommunityAvatar';

function openServer(server, serverId) {
  const id = Number(server?.id || serverId);
  if (Number.isInteger(id) && id > 0) {
    try { sessionStorage.setItem('glean.activeServerId', String(id)); } catch { /* ignore */ }
  }
  window.dispatchEvent(new CustomEvent('glean-open-server', { detail: { server, serverId: id } }));
}

export function ServerInvitePreview({
  server,
  splashStyle,
  goLabel = 'Go to Server',
  goDisabled = false,
  onGo,
  status = '',
  error = '',
}) {
  const splash = splashStyle || bannerStyle(server?.banner);
  const memberCount = Number(server?.memberCount || 0);
  const onlineCount = Number(server?.onlineCount || 0);

  return (
    <div className={`glean-invite-card${status ? ' is-disabled' : ''}`}>
      <div className="glean-invite-splash">
        <div className="glean-invite-banner" style={splash} />
        <div className="glean-invite-icon">
          {server ? <ServerIcon server={server} /> : <span className="community-server-icon" aria-hidden="true">?</span>}
        </div>
      </div>
      <div className="glean-invite-body">
        {server ? (
          <>
            <strong className="glean-invite-name">{server.name}</strong>
            <p className="glean-invite-counts">
              <span className="glean-invite-online">{onlineCount} Online</span>
              <span className="glean-invite-members">{memberCount} Member{memberCount === 1 ? '' : 's'}</span>
            </p>
            {server.createdAt ? <p className="glean-invite-est">Est. {formatEstablished(server.createdAt)}</p> : null}
            {server.description ? <p className="glean-invite-about">{server.description}</p> : null}
          </>
        ) : (
          <p className="glean-invite-about">{error || 'Loading invite…'}</p>
        )}
        {error && server ? <p className="glean-invite-error" role="alert">{error}</p> : null}
        <button type="button" className="glean-invite-go" onClick={onGo} disabled={goDisabled}>
          {goLabel}
        </button>
      </div>
    </div>
  );
}

export default function ServerInviteCard({ code }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError('');
    getInvitePreview(code)
      .then((payload) => { if (!cancelled) setPreview(payload); })
      .catch((item) => { if (!cancelled) setError(item.message || 'Invite unavailable.'); });
    return () => { cancelled = true; };
  }, [code]);

  const go = async () => {
    if (!preview || preview.expired || preview.banned || busy) return;
    setBusy(true);
    setError('');
    try {
      if (preview.alreadyMember) {
        openServer(preview.server, preview.server.id);
        return;
      }
      const { server } = await joinServerByInvite(preview.code);
      openServer(server, server.id);
    } catch (item) {
      setError(item.message || 'Unable to join that server.');
    } finally {
      setBusy(false);
    }
  };

  const label = preview?.expired ? 'Invite expired' : preview?.banned ? 'You are banned' : preview?.alreadyMember ? 'Go to Server' : busy ? 'Joining…' : 'Go to Server';

  return (
    <ServerInvitePreview
      server={preview?.server}
      status={preview?.expired || preview?.banned ? 'disabled' : ''}
      error={error}
      goLabel={label}
      goDisabled={!preview || preview.expired || preview.banned || busy}
      onGo={go}
    />
  );
}
