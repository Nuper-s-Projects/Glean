import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { LoopPanelIcon } from './LoopPanelDialog';
import { readCaptionPreference, setCaptionPreference } from './loopVideoPreferences';
import { enableDesktopPush, notificationPermission } from '../../app/desktopPush';

const groups = [
  { title: 'Conversations', description: 'Keep up with people talking to you.', entries: [
    ['comments', 'Comments', 'Someone comments on your post.', 'comment'],
    ['replies', 'Replies', 'Someone replies to your comment.', 'reply'],
    ['mentions', 'Mentions', 'Someone mentions you in a post or comment.', 'mention'],
  ] },
  { title: 'Your activity', description: 'Updates about your posts and followers.', entries: [
    ['likes', 'Likes', 'Someone likes your post.', 'like'],
    ['reposts', 'Reposts', 'Someone shares your post with Loop.', 'repost'],
    ['follows', 'Followers', 'Someone starts following you.', 'follow'],
  ] },
];
const keys = groups.flatMap(group => group.entries.map(([key]) => key));
function SettingRow({ title, description, icon, checked, disabled, onChange }) {
  return <label className="loop-setting-row"><span className="loop-setting-icon"><LoopPanelIcon name={icon} size={18} /></span>
    <span className="loop-setting-copy"><strong>{title}</strong><small>{description}</small></span>
    <input className="loop-setting-switch" type="checkbox" role="switch" aria-label={title} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
  </label>;
}
export default function LoopSettings() {
  const [preferences, setPreferences] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [captions, setCaptions] = useState(readCaptionPreference);
  const [permission, setPermission] = useState(notificationPermission), [pushBusy, setPushBusy] = useState(false);
  const lock = useRef(false), mounted = useRef(false), restore = useRef(null), failedUpdate = useRef(null);
  const load = useCallback(async signal => {
    setError('');
    try { const data = await apiRequest('/loop/notification-preferences', { signal }); if (mounted.current && !signal?.aborted) setPreferences(data.preferences); }
    catch (failure) { if (mounted.current && failure.name !== 'AbortError') setError(failure.message); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); load(controller.signal);
    const sync = () => { setCaptions(readCaptionPreference()); setPermission(notificationPermission()); };
    window.addEventListener('storage', sync); window.addEventListener('glean-loop-cc', sync);
    window.addEventListener('focus', sync);
    return () => { mounted.current = false; controller.abort(); window.removeEventListener('storage', sync); window.removeEventListener('glean-loop-cc', sync); window.removeEventListener('focus', sync); };
  }, [load]);
  const save = async update => {
    if (lock.current || !preferences) return;
    lock.current = true;
    const previous = preferences; failedUpdate.current = update;
    setPreferences({ ...previous, ...update }); setBusy(true); setError(''); setSaved(false);
    try { const data = await apiRequest('/loop/notification-preferences', { method: 'PATCH', body: JSON.stringify(update) }); if (mounted.current) { setPreferences(data.preferences); setSaved(true); failedUpdate.current = null; } }
    catch (failure) { if (mounted.current) { setPreferences(previous); setError(failure.message); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const paused = preferences && keys.every(key => !preferences[key]);
  return <div className="loop-settings-content"><section className="loop-settings-section">
    <div className="loop-settings-section-title"><h3>Notifications</h3><span className="loop-settings-save-state" role="status">{busy ? 'Saving…' : saved ? 'Saved' : 'Saves automatically'}</span></div>
    <p>Choose which activity appears in your notification inbox.</p>
    {error ? <div className="loop-panel-error" role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => failedUpdate.current ? save(failedUpdate.current) : load()}>Try again</button></div> : null}
    {!preferences ? <div className="loop-panel-skeleton" role="status" aria-label="Loading settings"><span /><span /><span /></div> : <>
      <div className="loop-settings-pause"><SettingRow title="Browser notifications" description={permission === 'denied' ? 'Blocked by your browser. Allow notifications in its site settings.' : permission === 'unsupported' ? 'Push notifications are not supported in this browser.' : 'Get notifications titled Loop, even when this tab is closed.'} icon="bell" checked={Boolean(preferences.browserPush && permission === 'granted')} disabled={busy || pushBusy || permission === 'unsupported'} onChange={async enabled => {
        if (!enabled) { save({ browserPush: false }); return; }
        setPushBusy(true); setError(''); setSaved(false);
        try { await enableDesktopPush(); if (mounted.current) { setPermission(notificationPermission()); await save({ browserPush: true }); } }
        catch (failure) { if (mounted.current) { setPermission(notificationPermission()); setError(failure.message); } }
        finally { if (mounted.current) setPushBusy(false); }
      }} /></div>
      <div className="loop-settings-pause"><SettingRow title="Pause notifications" description="Take a break from new activity notifications." icon="bell" checked={Boolean(paused)} disabled={busy} onChange={enabled => {
        if (enabled) { restore.current = Object.fromEntries(keys.map(key => [key, preferences[key]])); save(Object.fromEntries(keys.map(key => [key, false]))); }
        else save(restore.current || Object.fromEntries(keys.map(key => [key, true])));
      }} /></div>
      {groups.map(group => <section className="loop-settings-group" key={group.title}><h4>{group.title}</h4><p>{group.description}</p><div>
        {group.entries.map(([key, title, description, icon]) => <SettingRow key={key} title={title} description={description} icon={icon} checked={Boolean(preferences[key])} disabled={busy} onChange={enabled => save({ [key]: enabled })} />)}
      </div></section>)}
    </>}
  </section><section className="loop-settings-section"><div className="loop-settings-section-title"><h3>Video playback</h3></div><p>Playback preferences for this browser.</p>
    <div className="loop-settings-group"><SettingRow title="Show captions by default" description="Turn on captions when a video has them, including in Flow." icon="play" checked={captions} onChange={enabled => { setCaptions(enabled); setCaptionPreference(enabled); }} /></div>
  </section></div>;
}
