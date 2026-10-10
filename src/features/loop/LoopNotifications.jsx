import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { subscribeToDmEvents } from '../../app/dmApi';

const categories = [['replies','Replies to my comments'],['comments','Comments on my posts'],['mentions','Mentions of me'],['likes','Likes on my posts'],['follows','New followers'],['reposts','Reposts of my posts']];

export default function LoopNotifications({ visible, showSettings, onUnread, onOpen, onToast }) {
  const [items,setItems] = useState([]);
  const [next,setNext] = useState(null);
  const [preferences,setPreferences] = useState(null);
  const [editing,setEditing] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const version = useRef(0);
  const saving = useRef(false);
  const load = useCallback(async (before=null) => {
    const requested=++version.current;
    try {
      const data=await apiRequest(`/loop/notifications${before ? `?before=${before}` : ''}`);
      if(requested!==version.current)return;
      setItems(current=>before ? [...current,...data.notifications.filter(item=>!current.some(old=>old.id===item.id))] : data.notifications);
      setNext(data.page?.nextBefore || null); onUnread(data.unreadCount);setError('');
    } catch(failure){if(requested===version.current)setError(failure.message);}
  },[onUnread]);
  useEffect(()=>{
    load();
    const sub=subscribeToDmEvents(event=>{if(event==='loop-notification'||event==='loop-notifications-read')load();});
    return ()=>{version.current++;sub.close();};
  },[load]);
  useEffect(()=>{setEditing(showSettings);},[showSettings]);
  useEffect(()=>{
    if(!visible)return;
    let cancelled=false;
    apiRequest('/loop/notification-preferences').then(data=>{if(!cancelled)setPreferences(data.preferences);}).catch(failure=>{if(!cancelled)setError(failure.message);});
    load();
    return ()=>{cancelled=true;};
  },[visible,load]);
  const save = async update => {
    if(saving.current)return;
    saving.current=true;
    const previous=preferences;
    setPreferences(current=>({...current,...update}));setBusy(true);setError('');
    try{const data=await apiRequest('/loop/notification-preferences',{method:'PATCH',body:JSON.stringify(update)});setPreferences(data.preferences);onToast('Notification preferences saved.');}
    catch(failure){setPreferences(previous);setError(failure.message);}finally{saving.current=false;setBusy(false);}
  };
  const read = async ids => {try{await apiRequest('/loop/notifications/read',{method:'POST',body:JSON.stringify(ids ? {ids} : {})});await load();}catch(failure){setError(failure.message);}};
  if(!visible)return null;
  return <section className="loop-notification-panel" aria-label="Loop notifications">
    <header className="loop-notification-heading"><h2>Notifications</h2><div><button type="button" onClick={()=>read()}>Mark all read</button><button type="button" aria-expanded={editing} onClick={()=>setEditing(!editing)}>Preferences</button></div></header>
    {editing ? <div className="loop-notification-preferences"><p>Choose what appears here. Turning a category off stops new notifications, not the activity itself.</p>
      {preferences ? <><label><input type="checkbox" disabled={busy} checked={categories.every(([key])=>!preferences[key])} onChange={event=>save(Object.fromEntries(categories.map(([key])=>[key,!event.target.checked])))} />Pause all notifications</label>
      {categories.map(([key,label])=><label key={key}><input type="checkbox" checked={preferences[key]} disabled={busy} onChange={event=>save({[key]:event.target.checked})}/>{label}</label>)}</> : <p role="status">Loading preferences…</p>}
    </div> : null}
    {error ? <p className="loop-inline-error" role="alert">{error} <button type="button" onClick={()=>load()}>Try again</button></p> : null}
    {items.map(item=><button className={`loop-notification-item${item.read ? '' : ' is-unread'}`} type="button" key={item.id} onClick={async()=>{await read([item.id]);onOpen(item);}}>
      {item.actor?.avatarUrl ? <img className="loop-avatar is-small" src={item.actor.avatarUrl} alt="" loading="lazy"/> : <span className="loop-avatar is-small">{(item.actor?.username || '?').slice(0,2)}</span>}
      <span><strong>{item.actor?.username || 'Someone'}</strong> {item.body}{item.preview ? <span className="loop-notification-preview">“{item.preview}”</span> : null}<small>{new Date(item.createdAt).toLocaleString()}{item.read ? '' : ' · Unread'}</small></span>
    </button>)}
    {!items.length && !error ? <p className="loop-muted">You’re all caught up. Replies, mentions, and other activity will appear here.</p> : null}
    {next ? <button className="loop-thread-more" type="button" onClick={()=>load(next)}>Load more notifications</button> : null}
  </section>;
}
