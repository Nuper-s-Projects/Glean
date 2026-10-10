import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { subscribeToDmEvents } from '../../app/dmApi';

function LoopOnlinePeople({ accountId, onOpenProfile }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [cursors, setCursors] = useState([0]);
  const [revision, setRevision] = useState(0);
  const refreshTimer = useRef(null);
  const cursor = cursors.at(-1);
  const refresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      setRevision(value => value + 1);
    }, 300);
  }, []);

  useEffect(() => {
    let alive = true;
    let subscription;
    // Rejoin on every socket connection, including network recovery.
    const publish = () => subscription?.send('loop-presence', { active: document.visibilityState === 'visible' });
    subscription = subscribeToDmEvents(event => {
      if (event === 'connected') { publish(); refresh(); }
      if (event === 'loop-online-changed') refresh();
    }, status => {
      if (alive && status === 'reconnecting') { setData(null); setError('Reconnecting to Loop…'); }
    });
    publish();
    document.addEventListener('visibilitychange', publish);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', publish);
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      subscription.send('loop-presence', { active: false });
      subscription.close();
    };
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    apiRequest(`/loop/online?limit=30&after=${cursor}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (!result.users.length && cursor) { setCursors([0]); return; }
      setData(result);
      setError('');
    }).catch(failure => {
      if (!controller.signal.aborted) { setData(null); setError(failure.message || 'Online people could not be loaded.'); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cursor, revision]);

  return <section className="loop-online-panel" aria-labelledby="loop-online-title" aria-busy={loading}>
    <header><h2 id="loop-online-title"><span className="loop-online-dot"/>Online in Loop</h2><span className="loop-online-count">{data ? data.total : '—'}</span></header>
    <p>People here right now.</p>
    {error ? <div className="loop-online-empty" role="status"><p>{error}</p><button type="button" onClick={refresh}>Try again</button></div>
      : !data ? <div className="loop-online-skeleton" role="status" aria-label="Loading online people">{[0,1,2].map(id => <div key={id}><span/><span/></div>)}</div>
      : data.users.length ? <ul className="loop-online-list">{data.users.map(user => <li key={user.id}><button type="button" onClick={() => onOpenProfile(user.id)} aria-label={`View ${user.username}'s profile`}>
        <span className="loop-online-avatar">{user.avatarUrl ? <img src={user.avatarUrl} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.hidden = true; }}/> : null}<span aria-hidden="true">{user.username?.slice(0,1).toUpperCase()}</span><i className={`is-${user.presence}`}/></span>
        <span className="loop-online-name"><strong>{user.username}{Number(user.id) === Number(accountId) ? ' (you)' : ''}</strong><small>{user.presence === 'idle' ? 'Away' : user.presence === 'dnd' ? 'Do not disturb' : 'Online'}</small></span><span aria-hidden="true">›</span>
      </button></li>)}</ul> : <div className="loop-online-empty">No one is visible online right now.</div>}
    {(cursors.length > 1 || data?.page?.hasMore) ? <footer><button type="button" disabled={loading || cursors.length === 1} onClick={() => setCursors(value => value.slice(0,-1))}>Previous</button><span>Page {cursors.length}</span><button type="button" disabled={loading || !data?.page?.hasMore} onClick={() => setCursors(value => [...value,data.page.nextAfter])}>Next</button></footer> : null}
    <small className="loop-online-note">Invisible users are not shown.</small>
  </section>;
}

export default memo(LoopOnlinePeople);
