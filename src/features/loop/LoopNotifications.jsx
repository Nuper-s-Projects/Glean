import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { subscribeToDmEvents } from '../../app/dmApi';
import VerifiedMark from '../../components/VerifiedMark';
import LoopPanelDialog, { LoopPanelIcon } from './LoopPanelDialog';
import LoopSettings from './LoopSettings';
import './LoopPanels.css';

function timeLabel(value) {
  const time = Date.parse(value), elapsed = Math.max(0, Date.now() - time);
  if (!Number.isFinite(time)) return '';
  if (elapsed < 60000) return 'Just now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function LoopNotifications({ visible, showSettings, onUnread, onOpen, onClose, onSettings }) {
  const [items, setItems] = useState([]), [next, setNext] = useState(null), [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState('all'), [loading, setLoading] = useState(true), [moreLoading, setMoreLoading] = useState(false);
  const [readBusy, setReadBusy] = useState(false), [error, setError] = useState('');
  const version = useRef(0), request = useRef(null), readLock = useRef(false);
  const load = useCallback(async (before = null) => {
    const requested = ++version.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    if (before) setMoreLoading(true); else setLoading(true);
    try {
      const query = new URLSearchParams({ unread: filter === 'unread' ? '1' : '0' });
      if (before) query.set('before', before);
      const data = await apiRequest(`/loop/notifications?${query}`, { signal: controller.signal });
      if (requested !== version.current) return;
      setItems(current => {
        if (!before) return data.notifications;
        const ids = new Set(current.map(item => item.id));
        return [...current, ...data.notifications.filter(item => !ids.has(item.id))];
      });
      setNext(data.page?.nextBefore || null); setUnread(data.unreadCount); onUnread(data.unreadCount); setError('');
    } catch (failure) { if (requested === version.current && failure.name !== 'AbortError') setError(failure.message); }
    finally { if (requested === version.current) { setLoading(false); setMoreLoading(false); } }
  }, [filter, onUnread]);
  useEffect(() => {
    load();
    let timer;
    const sub = subscribeToDmEvents(event => {
      if (event !== 'loop-notification' && event !== 'loop-notifications-read') return;
      clearTimeout(timer); timer = setTimeout(() => load(), 200);
    });
    return () => { version.current++; request.current?.abort(); clearTimeout(timer); sub.close(); };
  }, [load]);
  useEffect(() => { if (visible && !showSettings) load(); }, [visible, showSettings, load]);
  const read = async item => {
    if (readLock.current) return;
    if (item?.read) { onOpen(item); return; }
    readLock.current = true; setReadBusy(true); setError('');
    try {
      await apiRequest('/loop/notifications/read', { method: 'POST', body: JSON.stringify(item ? { ids: [item.id] } : {}) });
      await load();
    } catch (failure) { setError(failure.message); }
    finally { readLock.current = false; setReadBusy(false); }
    if (item) onOpen(item);
  };
  const groups = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const result = new Map();
    for (const item of items) {
      const time = Date.parse(item.createdAt);
      const title = time >= today.getTime() ? 'Today' : time >= yesterday.getTime() ? 'Yesterday' : 'Earlier';
      if (!result.has(title)) result.set(title, []);
      result.get(title).push(item);
    }
    return ['Today', 'Yesterday', 'Earlier'].filter(title => result.has(title)).map(title => [title, result.get(title)]);
  }, [items]);
  if (!visible) return null;
  return <LoopPanelDialog title={showSettings ? 'Loop settings' : 'Notifications'} icon={showSettings ? 'settings' : 'bell'}
    description={showSettings ? 'Make Loop feel right for you.' : unread ? `${unread.toLocaleString()} unread · Your latest Loop activity` : 'Your latest Loop activity'} onClose={onClose}
    actions={<div className="loop-panel-toolbar">{showSettings ? <button type="button" onClick={() => onSettings(false)}><LoopPanelIcon name="bell" size={16} />Notifications</button> : <>
      <div className="loop-notification-tabs" role="group" aria-label="Notification filter">{['all', 'unread'].map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { if (value !== filter) { setItems([]); setLoading(true); setFilter(value); } }}>{value === 'all' ? 'All activity' : 'Unread'}</button>)}</div>
      <button className="loop-mark-read" type="button" disabled={readBusy || !unread} onClick={() => read()}><LoopPanelIcon name="check" size={16} /><span>{readBusy ? 'Marking…' : 'Mark all read'}</span></button>
      <button className="loop-panel-icon-button" type="button" aria-label="Notification settings" onClick={() => onSettings(true)}><LoopPanelIcon name="settings" size={18} /></button>
    </>}</div>}>
    {showSettings ? <LoopSettings /> : <>
      {error ? <div className="loop-panel-error" role="alert"><p>{error}</p><button type="button" onClick={() => load()}>Try again</button></div> : null}
      {loading && !items.length ? <div className="loop-panel-skeleton" role="status" aria-label="Loading notifications"><span /><span /><span /></div> : groups.map(([title, entries]) => <section className="loop-activity-group" key={title}><h3>{title}</h3><div>{entries.map(item => <button className={`loop-activity-item${item.read ? '' : ' is-unread'}`} type="button" key={item.id} disabled={readBusy} onClick={() => read(item)}>
        <span className="loop-activity-avatar">{item.actor?.avatarUrl ? <img src={item.actor.avatarUrl} alt="" loading="lazy" decoding="async" /> : <span>{(item.actor?.username || '?').slice(0, 2).toUpperCase()}</span>}<span className={`loop-activity-kind is-${item.type}`}><LoopPanelIcon name={item.type} size={12} /></span></span>
        <span className="loop-activity-copy"><span><strong>{item.actor?.username || 'Someone'}{item.actor?.verified ? <VerifiedMark /> : null}</strong> {item.body}</span>{item.preview ? <span className="loop-activity-preview">{item.preview}</span> : null}<time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{timeLabel(item.createdAt)}</time></span>
        {!item.read ? <span className="loop-activity-unread" aria-label="Unread" /> : null}
      </button>)}</div></section>)}
      {!loading && !items.length && !error ? <div className="loop-panel-empty"><span><LoopPanelIcon name={filter === 'unread' ? 'check' : 'bell'} size={28} /></span><h3>{filter === 'unread' ? 'You’re all caught up' : 'Your activity starts here'}</h3><p>{filter === 'unread' ? 'No unread notifications. You can still see everything in All activity.' : 'Replies, mentions, likes, and new followers will show up here.'}</p></div> : null}
      {next ? <button className="loop-panel-load-more" type="button" disabled={moreLoading || loading} onClick={() => load(next)}>{moreLoading ? 'Loading…' : 'Show older notifications'}</button> : null}
    </>}
  </LoopPanelDialog>;
}
