import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { leaveGroupConversation, setConversationMuted, setServerMuted, subscribeToDmEvents } from '../../app/dmApi';
import { SettingsField, SettingsNotice, SettingsSection, SettingsSwitch } from './AccountSettingsPrimitives';
import './NotificationControls.css';

export default function NotificationControls({ accountId }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [leaveTarget, setLeaveTarget] = useState(null);
  const controller = useRef(null);
  const lock = useRef(false);
  const leaveHeading = useRef(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    try {
      const result = await apiRequest('/account/notifications', { signal: request.signal });
      if (!request.signal.aborted) { setData(result); setError(''); }
    } catch (failure) { if (!request.signal.aborted) setError(failure.message); }
  }, []);
  useEffect(() => {
    void load();
    const events = subscribeToDmEvents(event => { if (['notification-settings', 'conversations', 'server-membership'].includes(event) && !lock.current) void load(); }, () => {}, accountId);
    return () => { controller.current?.abort(); events.close(); };
  }, [accountId, load]);
  useEffect(() => { if (leaveTarget) leaveHeading.current?.focus(); }, [leaveTarget]);
  const change = async (action, success) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNote('');
    controller.current?.abort();
    try { await action(); setNote(success); await load(); }
    catch (failure) { setError(failure.message || 'Could not save your notification settings. Try again.'); }
    finally { lock.current = false; setBusy(false); }
  };
  const update = patch => change(() => apiRequest('/account/notifications', { method: 'PATCH', body: JSON.stringify(patch) }), 'Notification preferences saved across your devices.');
  const matching = list => list.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const settings = data?.settings;
  return <div className="notification-controls" aria-busy={busy}>
    <SettingsSection id="notification-delivery-title" title="Choose your alerts" description="These controls apply to Glean, across your devices. Glean Loop has its own notification settings.">
      {settings ? <>
        <SettingsField id="notification-server-mode" label="Server messages" hint="All messages is the default. Choose mentions only for fewer alerts. Muted servers stay silent, including mentions."><select className="settings-input" id="notification-server-mode" value={settings.serverMessages} disabled={busy} onChange={event => update({ serverMessages: event.target.value })}><option value="all">All messages (default)</option><option value="mentions">Mentions only</option><option value="off">No server alerts</option></select></SettingsField>
        <SettingsSwitch label="Direct message alerts" hint="Browser alerts for private messages and calls." checked={settings.directMessages} busy={busy} onChange={directMessages => update({ directMessages })} />
        <SettingsSwitch label="Group message alerts" hint="Receive group DM alerts unless you mute a specific group below." checked={settings.groupMessages} busy={busy} onChange={groupMessages => update({ groupMessages })} />
        <SettingsSwitch label="Friend request alerts" checked={settings.friendRequests} busy={busy} onChange={friendRequests => update({ friendRequests })} />
        <SettingsSwitch label="Daily greeting alerts" checked={settings.dailyGreetings} busy={busy} onChange={dailyGreetings => update({ dailyGreetings })} />
      </> : !error ? <p className="settings-loading" role="status">Loading notification preferences…</p> : null}
      <SettingsNotice error>{error}</SettingsNotice>{error ? <button className="notification-control-button" type="button" disabled={busy} onClick={load}>Retry</button> : null}<SettingsNotice>{note}</SettingsNotice>
    </SettingsSection>
    {data ? <SettingsSection id="notification-mutes-title" title="Servers & groups" description="Mute individual conversations without leaving. Messages remain available, but muted conversations do not send alerts or contribute unread badges.">
      <SettingsField id="notification-mute-search" label="Find a server or group"><input className="settings-input" id="notification-mute-search" type="search" placeholder="Search servers and groups" value={query} onChange={event => setQuery(event.target.value)} /></SettingsField>
      <div className="notification-source-list"><h3>Servers <span>{data.servers.length}</span></h3>{matching(data.servers).length ? matching(data.servers).map(server => <SettingsSwitch key={server.id} label={`Mute ${server.name}`} hint={server.muted ? 'Muted on all devices' : 'Uses your server message preference'} checked={server.muted} busy={busy} onChange={muted => change(() => setServerMuted(server.id, muted), `${server.name} ${muted ? 'muted' : 'unmuted'}.`)} />) : <p className="settings-empty">{query ? 'No matching servers.' : 'Servers you join appear here.'}</p>}</div>
      <div className="notification-source-list"><h3>Group DMs <span>{data.groups.length}</span></h3>{matching(data.groups).length ? matching(data.groups).map(group => <div className="notification-group-row" key={group.id}><SettingsSwitch label={`Mute ${group.name}`} hint={group.muted ? 'Muted on all devices' : settings.groupMessages ? 'Group alerts enabled' : 'Group alerts turned off above'} checked={group.muted} busy={busy} onChange={muted => change(() => setConversationMuted(group.id, muted), `${group.name} ${muted ? 'muted' : 'unmuted'}.`)} /><button type="button" className="notification-control-button is-danger" disabled={busy} onClick={() => setLeaveTarget(group)} aria-label={`Leave ${group.name}`}>Leave</button></div>) : <p className="settings-empty">{query ? 'No matching groups.' : 'Your group chats appear here. You can also create one from Messages.'}</p>}</div>
      {leaveTarget ? <section className="notification-leave-confirm" aria-labelledby="notification-leave-title"><h3 id="notification-leave-title" ref={leaveHeading} tabIndex={-1}>Leave {leaveTarget.name}?</h3><p>You will lose access to this group and its messages. Other members keep their history. If you own the group, ownership passes to another member.</p><div><button type="button" className="notification-control-button" disabled={busy} onClick={() => setLeaveTarget(null)}>Keep group</button><button type="button" className="notification-control-button is-danger" disabled={busy} onClick={() => change(async () => { await leaveGroupConversation(leaveTarget.id); setLeaveTarget(null); }, `You left ${leaveTarget.name}.`)}>{busy ? 'Leaving…' : 'Leave group'}</button></div></section> : null}
    </SettingsSection> : null}
  </div>;
}
