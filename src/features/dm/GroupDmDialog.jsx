import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from './DmPrimitives';
import DisplayName from './DisplayName';
import { CloseIcon } from './icons';
import './GroupDmDialog.css';

export function GroupAvatar({ large = false }) {
  return <span className={`dm-avatar dm-group-avatar${large ? ' dm-avatar-large' : ''}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="9" cy="8" r="3" /><path d="M2 21v-3a7 7 0 0 1 14 0v3M16 5a3 3 0 0 1 0 6M22 21v-3a7 7 0 0 0-4-6" /></svg></span>;
}

export default function GroupDmDialog({ conversation = null, account, friends, onCreate, onChange, onClose, onProfile }) {
  const dialogRef = useRef(null);
  const [name, setName] = useState(conversation?.name || '');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const owner = !conversation || Number(conversation.ownerId) === Number(account.id);
  const members = conversation?.members || [];
  const memberIds = useMemo(() => new Set(members.map(m => Number(m.id))), [members]);
  const available = useMemo(() => friends.filter(friend => !friend.isBot && !memberIds.has(Number(friend.id)) && friend.username.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [friends, memberIds, query]);
  useEffect(() => { if (conversation) setName(conversation.name); }, [conversation?.name]);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.querySelector('input,button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const act = async (action, value) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (!conversation) { await onCreate(name.trim(), [...selected]); onClose(); }
      else { await onChange(conversation.id, action, value); if (action === 'leave') onClose(); }
    } catch (failure) { setError(failure.message || 'Could not update this group. Please retry.'); }
    finally { setBusy(false); }
  };
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); }
    if (event.key !== 'Tab') return;
    const elements = [...dialogRef.current.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(node => node.getClientRects().length);
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return createPortal(<div className="dm-group-overlay" onPointerDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }} onKeyDown={onKeyDown}>
    <section ref={dialogRef} className="dm-group-dialog" role="dialog" aria-modal="true" aria-labelledby="dm-group-title" aria-busy={busy}>
      <header><GroupAvatar /><div><h2 id="dm-group-title">{conversation ? 'Group details' : 'Create a group DM'}</h2><p>{conversation ? `${members.length} members · End-to-end encrypted` : 'Bring your friends into one private conversation.'}</p></div><button type="button" disabled={busy} onClick={onClose} aria-label="Close group dialog"><CloseIcon /></button></header>
      <div className="dm-group-body">
        {owner ? <form className="dm-group-name" onSubmit={event => { event.preventDefault(); if (conversation) act('rename', name.trim()); }}><label htmlFor="dm-group-name">Group name</label><div><input id="dm-group-name" value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} placeholder="Weekend plans" autoComplete="off" />{conversation ? <button type="submit" disabled={busy || !name.trim() || name.trim() === conversation.name}>Save name</button> : null}</div></form> : <h3>{conversation.name}</h3>}
        {conversation ? <section aria-label="Group members"><h3>Members <span>{members.length}/20</span></h3>{members.map(member => <div className="dm-group-person" key={member.id}><Avatar user={member} interactive={false} /><button className="dm-group-person-name" type="button" onClick={event => { onProfile(member, event.currentTarget); onClose(); }}><DisplayName user={member} /><small>{Number(member.id) === Number(conversation.ownerId) ? 'Owner' : Number(member.id) === Number(account.id) ? 'You' : 'Member'}</small></button>{owner && Number(member.id) !== Number(account.id) ? <button className="dm-group-remove" type="button" disabled={busy} onClick={() => { if (window.confirm(`Remove ${member.username} from this group?`)) act('remove', Number(member.id)); }}>Remove</button> : null}</div>)}</section> : null}
        {owner && (!conversation || members.length < 20) ? <section aria-label="Choose friends"><h3>{conversation ? 'Add a friend' : 'Choose friends'}<span>{conversation ? '' : `${selected.size}/19 selected`}</span></h3><input type="search" aria-label="Search friends for group" placeholder="Search your friends" value={query} onChange={event => setQuery(event.target.value)} />
          <div className="dm-group-friends">{available.length ? available.map(friend => <div className="dm-group-person" key={friend.id}><Avatar user={friend} interactive={false} /><span className="dm-group-person-name"><DisplayName user={friend} /></span>{conversation ? <button type="button" disabled={busy} onClick={() => act('add', Number(friend.id))}>Add</button> : <input type="checkbox" aria-label={`Include ${friend.username}`} checked={selected.has(Number(friend.id))} disabled={busy || (!selected.has(Number(friend.id)) && selected.size >= 19)} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(Number(friend.id))) next.delete(Number(friend.id)); else next.add(Number(friend.id)); return next; })} />}</div>) : <p className="dm-group-help">{query ? 'No friends match your search.' : 'Add friends in Requests to invite them here.'}</p>}</div>
        </section> : null}
        <p className="dm-group-help">Up to 20 people. New members only see messages sent after joining. The owner can rename the group, add friends, and remove members.</p>
        {error ? <p className="dm-group-error" role="alert">{error}</p> : null}
      </div>
      <footer>{conversation ? <><button type="button" disabled={busy} onClick={() => act('mute', !conversation.muted)}>{conversation.muted ? 'Unmute notifications' : 'Mute notifications'}</button><button type="button" className="dm-group-remove" disabled={busy} onClick={() => { if (window.confirm('Leave this group DM? You will lose access to its messages.')) act('leave'); }}>Leave group</button></> : <><span>{selected.size < 2 ? 'Choose at least 2 friends' : `${selected.size + 1} people, including you`}</span><button className="glean-btn" type="button" disabled={busy || !name.trim() || selected.size < 2} onClick={() => act('create')}>{busy ? 'Creating…' : 'Create group'}</button></>}</footer>
    </section>
  </div>, document.body);
}
