import { useEffect, useState } from 'react';
import { CloseIcon } from '../dm/icons';

export default function AddServerDialog({
  serverName,
  inviteCode,
  onServerNameChange,
  onInviteCodeChange,
  onCreate,
  onJoin,
  onClose,
  error,
}) {
  const [tab, setTab] = useState(inviteCode ? 'join' : 'create');

  useEffect(() => {
    if (inviteCode) setTab('join');
  }, [inviteCode]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="community-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="community-dialog" role="dialog" aria-modal="true" aria-labelledby="add-server-title">
        <header>
          <h2 id="add-server-title">Add a server</h2>
          <button type="button" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </header>
        <div className="community-dialog-tabs">
          <button type="button" className={tab === 'create' ? 'is-active' : ''} onClick={() => setTab('create')}>Create</button>
          <button type="button" className={tab === 'join' ? 'is-active' : ''} onClick={() => setTab('join')}>Join</button>
        </div>
        {tab === 'create' ? (
          <form onSubmit={onCreate}>
            <label htmlFor="new-server-name">Server name</label>
            <input id="new-server-name" value={serverName} onChange={(event) => onServerNameChange(event.target.value)} placeholder="My community" maxLength="60" autoFocus />
            {error ? <p className="community-dialog-error" role="alert">{error}</p> : null}
            <div className="community-dialog-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="submit" className="community-dialog-primary" disabled={!serverName.trim()}>Create server</button>
            </div>
          </form>
        ) : (
          <form onSubmit={onJoin}>
            <label htmlFor="join-invite-code">Invite code or link</label>
            <input id="join-invite-code" value={inviteCode} onChange={(event) => onInviteCodeChange(event.target.value)} placeholder="Paste an invite code or /invite/ link" maxLength="256" autoFocus />
            {error ? <p className="community-dialog-error" role="alert">{error}</p> : null}
            <div className="community-dialog-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="submit" className="community-dialog-primary" disabled={!inviteCode.trim()}>Join server</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
