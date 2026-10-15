import { lazy, Suspense, useEffect, useState } from 'react';
import HardwareAccelerationSetting from './HardwareAccelerationSetting';
import NotificationControls from './NotificationControls';
import GradeQuestion from '../../components/GradeQuestion';
import SchoolQuestion from '../../components/SchoolQuestion';
import ProgramQuestion from '../../components/ProgramQuestion';
import { schoolRecord } from '../../app/laredoSchools';
import { publicPrograms } from '../../app/programs';
import { USERNAME_INPUT_MAX_LENGTH, USERNAME_RULES_MESSAGE } from '../../app/username';
import { MAX_CUSTOM_BADGES, MAX_CUSTOM_BADGE_LABEL, customBadgeTextColor } from '../../app/customBadges';
import { Avatar } from './DmPrimitives';
import DisplayName from './DisplayName';
import { ProfileLivePreview } from './BannerEditor';
import GleanButton from './GleanButton';
import { SettingsSection, SettingsField, SettingsSwitch, SettingsPassword, SettingsNotice, SettingIcon } from './AccountSettingsPrimitives';
import { getVerifiedUsers, setUserVerified } from '../../app/dmApi';
const MainThemeSettings = lazy(() => import('./MainThemeSettings'));

export function AppsSettings({ onEnterLoop }) {
  return <div className="settings-page-sections">
    <section className="settings-app-card" aria-labelledby="settings-loop-name">
      <div className="settings-app-mark" aria-hidden="true"><img src="/glean-mark.svg" alt="" /><span>LOOP</span></div>
      <div className="settings-app-copy"><h2 id="settings-loop-name">Glean Loop</h2><p>Share posts, photos, videos, and polls. Discover people and explore Flow with your Glean account.</p></div>
      <GleanButton onClick={onEnterLoop}>Enter Glean Loop</GleanButton>
    </section>
  </div>;
}

function ProfilePreview({ account, draft }) {
  const school = schoolRecord(draft.school);
  const programs = publicPrograms(draft.programs);
  const user = {
    ...account,
    username: draft.username || account.username,
    bio: draft.bio,
    discordUsername: draft.discord,
    customBadges: draft.badges.filter(badge => badge.label.trim()),
    school: draft.school,
    schoolLabel: school?.badge || '',
    schoolHex: school?.hex,
    programs,
  };
  return <div className="settings-profile-preview">
    <h2>Live preview</h2><p>Your name, bio, and badges update as you edit.</p>
    <ProfileLivePreview account={user} banner={account.banner} profileBackground={account.profileBackground} showLabel={false} />
    <small>Profile fields save with Save profile. Appearance and badges have their own save controls.</small>
  </div>;
}

function VerifiedAccountsSettings() {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = async (search = query) => {
    setBusy(true); setError('');
    try { const data = await getVerifiedUsers(search); setUsers(data.users || []); }
    catch (failure) { setError(failure.message || 'Could not load accounts.'); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(''); }, []);
  const toggle = async person => {
    setBusy(true); setError(''); setNote('');
    try {
      const data = await setUserVerified(person.id, !person.verified);
      setUsers(current => current.map(item => item.id === person.id ? { ...item, ...data.user } : item));
      setNote(`${person.username} is ${data.user.verified ? 'now verified' : 'no longer verified'}.`);
    } catch (failure) { setError(failure.message || 'Could not update verification.'); }
    finally { setBusy(false); }
  };
  return <SettingsSection id="settings-verified-title" title="Verified accounts" description="Give or remove the blue verified checkmark. Only Nuper can manage it.">
    <div className="settings-verified-search" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); load(); } }}>
      <label className="settings-field"><span>Find a Glean account</span><input className="settings-input" value={query} maxLength={80} onChange={event => setQuery(event.target.value)} placeholder="Search by username" /></label>
      <GleanButton disabled={busy} onClick={() => load()}>{busy ? 'Loading…' : 'Search'}</GleanButton>
    </div>
    <SettingsNotice>{note}</SettingsNotice><SettingsNotice error>{error}</SettingsNotice>
    <div className="settings-verified-list" aria-live="polite">{users.map(person => <div className="settings-verified-row" key={person.id}>
      {person.avatarUrl ? <img src={person.avatarUrl} alt="" /> : <span aria-hidden="true">{person.username.slice(0,1).toUpperCase()}</span>}
      <strong>{person.username}</strong>{person.verified ? <span className="settings-verified-state">Verified</span> : null}
      <GleanButton variant={person.verified ? 'quiet' : 'primary'} disabled={busy} onClick={() => toggle(person)}>{person.verified ? 'Remove badge' : 'Give badge'}</GleanButton>
    </div>)}{!users.length && !busy && !error ? <p className="settings-help">No accounts found.</p> : null}</div>
  </SettingsSection>;
}

export function ProfileSettings({ account, draft, onChange, banner, background, onSubmit, onChooseAvatar, avatarBusy, avatarDisabled, onBanner, onBackground, onNameStyle, badges }) {
  return <div className="settings-profile-layout">
    <form id="account-profile-form" className="settings-profile-form" onSubmit={onSubmit}>
      <SettingsSection id="settings-appearance-title" title="Appearance" description="Make your profile feel like you.">
        <div className="settings-media-row">
          <span>Profile picture</span><Avatar username={account.username} avatarUrl={account.avatarUrl} interactive={false} />
          <label className="settings-photo-button"><span>{avatarBusy ? 'Uploading…' : 'Choose photo'}</span><input type="file" aria-label="Choose profile photo" accept="image/jpeg,image/png,image/webp,image/gif" onChange={onChooseAvatar} disabled={avatarDisabled} /></label>
        </div>
        <small className="settings-help">JPG, PNG, WebP, or animated GIF. Up to 200 MB.</small>
        <div className="settings-media-row"><span>Profile banner</span><div className="settings-color-preview is-banner" style={banner} /><GleanButton variant="quiet" onClick={onBanner} aria-label="Customize profile banner">Customize</GleanButton></div>
        <div className="settings-media-row"><span>Profile background</span><div className="settings-color-preview" style={background} /><GleanButton variant="quiet" onClick={onBackground} aria-label="Customize profile background">Customize</GleanButton></div>
      </SettingsSection>
      <SettingsSection id="settings-identity-title" title="Identity" description="Your name and how you introduce yourself.">
        <SettingsField label="Username" id="account-username" hint={`${USERNAME_RULES_MESSAGE} Can’t use a name that’s already taken.`}><input id="account-username" className="settings-input" value={draft.username} onChange={event => onChange('username', event.target.value)} maxLength={USERNAME_INPUT_MAX_LENGTH} autoComplete="username" spellCheck="false" /></SettingsField>
        <div className="settings-media-row"><span>Name style</span><div className="settings-name-preview"><DisplayName user={{ ...account, username: draft.username || account.username }} /></div><GleanButton variant="quiet" onClick={onNameStyle} aria-label="Customize name style">Customize</GleanButton></div>
        <SettingsField label="Bio" id="account-bio"><textarea id="account-bio" className="settings-input" value={draft.bio} onChange={event => onChange('bio', event.target.value)} maxLength={500} placeholder="Tell people a little about yourself." rows={4} /></SettingsField>
      </SettingsSection>
      <SettingsSection id="settings-socials-title" title="Social accounts" description="Optional ways for friends to find you elsewhere.">
        <SettingsField label="Discord" id="account-discord" hint="Username or name#0000. Leave blank to hide it."><input id="account-discord" className="settings-input" value={draft.discord} onChange={event => onChange('discord', event.target.value)} maxLength={37} autoComplete="off" spellCheck="false" placeholder="username" /></SettingsField>
        {['instagram', 'tiktok'].map(network => <SettingsField key={network} label={network === 'instagram' ? 'Instagram' : 'TikTok'} id={`account-${network}`}>
          <div className="settings-social-fields"><input className="settings-input" aria-label={`${network === 'instagram' ? 'Instagram' : 'TikTok'} username`} value={draft[`${network}Username`]} onChange={event => onChange(`${network}Username`, event.target.value)} placeholder="Username (optional)" autoComplete="off" /><input id={`account-${network}`} className="settings-input" value={draft[network]} onChange={event => onChange(network, event.target.value)} placeholder="Profile link (optional)" autoComplete="url" /></div>
        </SettingsField>)}
      </SettingsSection>
      {account.platformAdmin && account.username?.trim().toLowerCase() === 'nuper' ? <VerifiedAccountsSettings /> : null}
      <SettingsSection id="settings-school-title" title="School & programs" description="Choose the school and program badges on your profile.">
        <GradeQuestion value={draft.grade} onChange={value => onChange('grade', value)} name="settings-grade" />
        <SchoolQuestion value={draft.school} grade={draft.grade} onChange={value => onChange('school', value)} name="settings-school" />
        <ProgramQuestion value={draft.programs} onChange={value => onChange('programs', value)} name="settings-program" />
      </SettingsSection>
      <SettingsSection id="custom-badges-title" title="Custom badges" description="Short text badges with your choice of color.">
        <div className="settings-actions"><GleanButton variant="quiet" onClick={badges.add} disabled={draft.badges.length >= MAX_CUSTOM_BADGES}>Add badge</GleanButton><small>{draft.badges.length}/{MAX_CUSTOM_BADGES} badges</small></div>
        {draft.badges.length ? <div className="settings-badge-list">{draft.badges.map((badge, index) => <div className="settings-badge-row" key={index}>
          <SettingsField label="Badge text" id={`settings-badge-${index}`}><input id={`settings-badge-${index}`} className="settings-input" value={badge.label} maxLength={MAX_CUSTOM_BADGE_LABEL} onChange={event => badges.edit(index, { label: event.target.value })} placeholder="Badge name" /></SettingsField>
          <SettingsField label="Color" id={`settings-badge-color-${index}`}><input id={`settings-badge-color-${index}`} className="settings-color-input" type="color" value={badge.color} onChange={event => badges.edit(index, { color: event.target.value.toUpperCase() })} aria-label={`Badge ${index + 1} color`} /></SettingsField>
          <span className="dm-profile-badge is-custom" style={{ '--custom-badge-background': badge.color, '--custom-badge-foreground': customBadgeTextColor(badge.color) }}>{badge.label.trim() || 'Preview'}</span>
          <GleanButton variant="quiet" onClick={() => badges.remove(index)} aria-label={`Remove badge ${index + 1}`}>Remove</GleanButton>
        </div>)}</div> : <p className="settings-help">No custom badges yet.</p>}
        <GleanButton onClick={badges.save} disabled={badges.busy}>{badges.busy ? 'Saving…' : 'Save badges'}</GleanButton><SettingsNotice>{badges.note}</SettingsNotice>
      </SettingsSection>
    </form>
    <ProfilePreview account={account} draft={draft} />
  </div>;
}

export function PrivacySettings({ account, hidden, presence, busy, blockedUsers, loading, actions }) {
  return <div className="settings-page-sections">
    <SettingsSection id="settings-secret-title" title="Keep My Information Secret" description="Share less activity across your signed-in devices.">
      <SettingsSwitch label="Keep My Information Secret" hint="Hide online presence, stop typing indicators, and make push alerts generic." checked={Boolean(account.keepInformationSecret)} busy={busy.secret} onChange={actions.secret} />
      <div className="settings-callout">DMs are end-to-end encrypted. Calls use encrypted WebRTC media. Server messages and call signaling still pass through Glean. People can see what you post and when you join a call. This does not make you anonymous.</div>
    </SettingsSection>
    <SettingsSection id="settings-presence-title" title="Presence" description="Choose how you appear to other people.">
      <SettingsField label="Status" id="settings-presence"><select id="settings-presence" className="settings-input" aria-label="Online status" value={account.presenceStatus || 'auto'} disabled={busy.presence} onChange={event => actions.presence(event.target.value)}>{[['auto','Automatic'], ['online','Online'], ['idle','Idle'], ['dnd','Do Not Disturb'], ['offline','Offline']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></SettingsField>
      <div className="settings-actions">{account.keepInformationSecret ? <small>Secret mode is keeping your presence hidden.</small> : <GleanButton variant="quiet" onClick={actions.hidden} disabled={busy.hidden}>{busy.hidden ? 'Saving…' : hidden ? 'Stop appearing offline' : 'Appear offline'}</GleanButton>}<small>Right now: {presence}</small></div>
    </SettingsSection>
    <SettingsSection id="settings-notes-title" title="Private notes" description="Keep personal notes in other people’s profiles."><SettingsSwitch label="Show private notes" hint="Only you can read them. Hiding the area keeps your existing notes." checked={account.privateNotesEnabled !== false} busy={busy.notes} onChange={actions.notes} /></SettingsSection>
    <SettingsSection id="settings-blocked-title" title="Blocked users" description="People you block can’t contact you through Glean.">
      {loading ? <p className="settings-loading" role="status">Loading blocked users…</p> : blockedUsers.length ? <div className="settings-device-list">{blockedUsers.map(person => <div className="settings-device-row" key={person.id}><Avatar username={person.username} avatarUrl={person.avatarUrl} interactive={false} /><span><strong>{person.username}</strong></span><GleanButton variant="quiet" onClick={() => actions.unblock(person.username)} disabled={Boolean(busy.blocked)}>{busy.blocked === person.username ? 'Unblocking…' : 'Unblock'}</GleanButton></div>)}</div> : <p className="settings-empty">Nobody is blocked.</p>}
    </SettingsSection>
    {account.platformAdmin ? <SettingsSection id="settings-hidden-title" title="Hidden servers" description="Show servers you can inspect but have not joined."><SettingsSwitch label="Show hidden servers" hint="Controls whether these servers appear in your rail." checked={account.showInspectServers !== false} busy={busy.inspect} onChange={actions.inspect} /></SettingsSection> : null}
  </div>;
}

export function SecuritySettings({ account, passwords, onPasswordChange, passwordBusy, passwordNote, onSavePassword, sessions, sessionsLoading, sessionsBusy, onRevoke, onRevokeOthers, encryption, onDelete, dmRecoveryDisclosureRef }) {
  const resetsAllDms = String(account.username || '').toLowerCase() === 'nuper';
  return <div className="settings-page-sections">
    <SettingsSection id="settings-password-title" title="Password" description="Keep access to your account secure.">
      <form className="settings-security-form" onSubmit={onSavePassword}>
        <SettingsPassword id="current-password" label="Current password" value={passwords.current} onChange={value => onPasswordChange('current', value)} />
        <SettingsPassword id="new-password" label="New password" value={passwords.next} onChange={value => onPasswordChange('next', value)} autoComplete="new-password" minLength={10} />
        <SettingsPassword id="confirm-password" label="Confirm new password" value={passwords.confirm} onChange={value => onPasswordChange('confirm', value)} autoComplete="new-password" minLength={10} />
        <p className="settings-help">Changing your password signs out every other device.</p>
        <GleanButton type="submit" disabled={passwordBusy}>{passwordBusy ? 'Saving…' : 'Update password'}</GleanButton><SettingsNotice>{passwordNote}</SettingsNotice>
      </form>
    </SettingsSection>
    <SettingsSection id="settings-devices-title" title="Devices" description="Revoke a session to sign that device out immediately.">
      {sessionsLoading ? <p className="settings-loading" role="status">Loading signed-in devices…</p> : <div className="settings-device-list">{sessions.map(session => <div className="settings-device-row" key={session.id}><SettingIcon name="device" /><span><strong>{session.device}</strong><small>{session.current ? 'Current session' : 'Other signed-in session'}</small></span><GleanButton variant="quiet" onClick={() => onRevoke(session)} disabled={Boolean(sessionsBusy)}>{sessionsBusy === session.id ? 'Revoking…' : session.current ? 'Sign out' : 'Revoke'}</GleanButton></div>)}</div>}
      {sessions.some(session => !session.current) ? <GleanButton variant="quiet" onClick={onRevokeOthers} disabled={Boolean(sessionsBusy)}>{sessionsBusy === 'others' ? 'Revoking…' : 'Revoke other devices'}</GleanButton> : null}
    </SettingsSection>
    <SettingsSection id="dm-encryption-title" title="DM encryption" description="Your direct messages use end-to-end encryption.">
      <div className={`settings-key-status${encryption.status === 'ready' ? ' is-ready' : ''}`}><SettingIcon name="key" /><span><strong>{String(account.username || '').toLowerCase() === 'nuper' ? (encryption.status === 'checking' ? 'Checking your account DM key…' : encryption.status === 'ready' ? 'Account DM key is available' : encryption.status === 'mismatch' ? 'This device needs your account DM key' : 'Could not verify your account DM key') : (encryption.status === 'checking' ? 'Checking this browser’s key…' : encryption.status === 'ready' ? 'Active key in this browser' : encryption.status === 'mismatch' ? 'This browser’s key needs attention' : 'Could not verify this browser’s key')}</strong><small>{String(account.username || '').toLowerCase() === 'nuper' ? (encryption.status === 'ready' ? 'Your key is backed up encrypted to your Glean profile and can be restored on another device after sign-in.' : 'Sign in again with your Glean password to restore your account key. This device will not replace it with a new key.') : (encryption.status === 'ready' ? 'This browser can send encrypted DMs. Older messages still need their original keys.' : 'A fresh key enables future messages, not recovery of older messages.')}</small></span></div>
      <details className="settings-disclosure" ref={dmRecoveryDisclosureRef}><summary><SettingIcon name="chevron" />Advanced recovery</summary><div>
        <div className="settings-callout is-warning">{resetsAllDms ? 'This starts your DMs over: all direct-message conversations and their attachments will be permanently deleted, then a new encryption key will be created and backed up with your Glean password for your devices. Servers, server messages, friends, and the rest of your account are not changed.' : 'Resetting creates a key for future messages. Existing DM history remains, but this device can only read older messages with their original key.'}</div>
        <form onSubmit={encryption.reset}>
          <SettingsPassword id="dm-key-reset-password" label="Current password" value={encryption.password} onChange={encryption.setPassword} />
          <label className="settings-acknowledge"><input type="checkbox" checked={encryption.acknowledged} onChange={event => encryption.setAcknowledged(event.target.checked)} /><span>{resetsAllDms ? 'I understand this permanently deletes all my DM history and attachments.' : 'I understand that older messages need their original key.'}</span></label>
          <GleanButton type="submit" disabled={encryption.busy || !encryption.password || !encryption.acknowledged}>{encryption.busy ? (resetsAllDms ? 'Deleting DMs and resetting…' : 'Resetting key…') : (resetsAllDms ? 'Delete all DMs and create a new key' : 'Reset DM key and enable chat')}</GleanButton>
        </form>
      </div></details><SettingsNotice>{encryption.note}</SettingsNotice><SettingsNotice error>{encryption.error}</SettingsNotice>
    </SettingsSection>
    <SettingsSection id="delete-account-title" className="settings-danger" title="Delete account" description="Permanently remove your Glean account."><div className="settings-callout is-danger">This cannot be undone. Your messages, direct-message history, and every server you own will be deleted.</div><GleanButton variant="danger" onClick={onDelete}>Delete my account</GleanButton></SettingsSection>
  </div>;
}

export function NotificationSettings({ account, permission, busy, onEnable, pwa, onInstall }) {
  const state = { default: ['Not enabled', 'Allow notifications in this browser to receive alerts.'], granted: ['Browser permission allowed', 'Reconnect if alerts are not arriving on this device.'], denied: ['Blocked in this browser', 'Allow notifications in your browser’s site settings, then reopen Settings.'], unsupported: ['Not supported here', 'This browser does not support desktop notifications.'] }[permission] || ['Not enabled', 'Allow notifications in this browser to receive alerts.'];
  return <div className="settings-page-sections">
    <NotificationControls accountId={account.id} />
    <SettingsSection id="settings-notifications-title" title="Desktop notifications" description="Alerts for DMs, servers, and friend requests, even in the background.">
      <div className="settings-permission-status"><SettingIcon name="notifications" /><span><strong>{state[0]}</strong><small>{state[1]}</small></span></div>
      <div className="settings-actions"><GleanButton onClick={onEnable} disabled={busy || permission === 'unsupported' || permission === 'denied'}>{busy ? 'Enabling…' : permission === 'granted' ? 'Reconnect notifications' : permission === 'denied' ? 'Blocked in browser' : 'Enable notifications'}</GleanButton></div>
    </SettingsSection>
    <SettingsSection id="settings-greetings-title" title="Daily greetings" description="Scheduled greetings for users with notifications enabled.">
      <dl className="settings-schedule"><div><dt>Monday–Friday</dt><dd>8:15 AM & 4:00 PM</dd></div><div><dt>Time zone</dt><dd>Central</dd></div></dl><p className="settings-help">Friday afternoon has a weekend message. No scheduled greetings on Saturday or Sunday.</p>
    </SettingsSection>
    <SettingsSection id="settings-install-title" title="Install Glean" description="A dedicated app window and easier access."><div className="settings-permission-status"><SettingIcon name="device" /><span><strong>{pwa.standalone ? 'Installed on this device' : 'Glean in your browser'}</strong><small>{pwa.standalone ? 'You’re already using the installed app.' : pwa.canInstall ? 'Your browser supports installing Glean.' : 'Use your browser’s install or Add to Home Screen option.'}</small></span></div>{!pwa.standalone && pwa.canInstall ? <GleanButton variant="quiet" onClick={onInstall}>Install Glean</GleanButton> : null}</SettingsSection>
  </div>;
}

const THEMES = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
function SettingsRange({ id, label, value, min = 0, max = 100, onChange, hint }) {
  return <div className="settings-range"><div><label htmlFor={id}>{label}</label><output htmlFor={id}>{value}%</output></div><input id={id} type="range" min={min} max={max} step={1} value={value} aria-valuetext={`${value} percent ${label.toLowerCase()}`} style={{ '--range-position': `${(value-min)/(max-min)*100}%` }} onChange={event => onChange(event.target.value)} />{hint ? <small>{hint}</small> : null}</div>;
}

export function AccessibilitySettings({ value, onChange, mainThemes, onThemeSaved }) {
  return <div className="settings-page-sections">
    <HardwareAccelerationSetting />
    <SettingsSection id="accessibility-heading" title="Theme" description="Choose the appearance of Glean.">
      <div className="settings-theme-options" role="radiogroup" aria-label="Color theme" onKeyDown={event => {
        if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = THEMES.findIndex(theme => theme.value === value.theme);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? 2 : 1)) % 3;
        onChange('theme', THEMES[next].value); event.currentTarget.querySelectorAll('button')[next].focus();
      }}>{THEMES.map(theme => <button key={theme.value} className={`settings-theme-tile is-${theme.value}`} type="button" role="radio" aria-checked={value.theme === theme.value} tabIndex={value.theme === theme.value ? 0 : -1} onClick={() => onChange('theme', theme.value)}><span className="settings-theme-mini" aria-hidden="true"><i /><span><b /><b /><b /></span></span><span><i className="settings-radio-dot" />{theme.label}</span></button>)}</div>
      <p className="settings-help">System follows your device. Light and Dark set Glean’s appearance directly.</p>
    </SettingsSection>
    <Suspense fallback={<p className="settings-loading" role="status">Loading Glean themes…</p>}><MainThemeSettings preferences={mainThemes} onSaved={onThemeSaved} /></Suspense>
    <SettingsSection id="settings-color-title" title="Color adjustments" description="Fine-tune visual intensity for your comfort."><SettingsRange id="accessibility-contrast" label="Contrast" value={value.contrast} min={50} max={150} hint="Lower to higher contrast." onChange={next => onChange('contrast', next)} /><SettingsRange id="accessibility-saturation" label="Saturation" value={value.saturation} max={200} hint="Grayscale to vivid color." onChange={next => onChange('saturation', next)} /></SettingsSection>
    <SettingsSection id="settings-loop-reminder-title" title="Glean Loop reminders" description="Choose whether Loop opens your daily Aura streak reminder."><SettingsSwitch label="Show daily streak reminder" hint="Turn this back on any time to see the reminder again when you visit Loop." checked={value.showLoopStreakReminder} onChange={enabled => onChange('showLoopStreakReminder', enabled)} /></SettingsSection>
    <SettingsSection id="settings-motion-title" title="Motion" description="Movement that respects your device preferences."><p className="settings-help">Animations are always enabled in Glean. Your device’s Reduce Motion preference is still respected.</p></SettingsSection>
  </div>;
}
