import { BookIcon, ChevronLeftIcon, HashIcon, LockIcon, MegaphoneIcon, SettingsIcon, UserIcon } from '../dm/icons';

export function ChannelGlyph({ kind }) {
  if (kind === 'announcement') return <MegaphoneIcon />;
  if (kind === 'rules') return <BookIcon />;
  return <HashIcon />;
}

export function formatSlowmode(seconds) {
  const value = Number(seconds || 0);
  return value >= 60 ? `${Math.round(value / 60)}m` : `${value}s`;
}

export default function ServerChannelHeader({ server, channel, inspecting, membersVisible, onBack, onToggleMembers, onSettings }) {
  return (
    <header className="community-chat-header">
      <button className="community-mobile-back" type="button" onClick={onBack} aria-label="Back to channels" title="Back to channels"><ChevronLeftIcon /></button>
      <div className="community-channel-title">
        <small title={channel?.topic || undefined}>{server?.name || 'Servers'}{inspecting ? ' · inspecting' : ''}{channel?.topic ? ` · ${channel.topic}` : ''}{channel?.slowmode ? ` · ${formatSlowmode(channel.slowmode)}` : ''}</small>
        <strong><ChannelGlyph kind={channel?.kind} /><span>{channel?.name || (server ? 'general' : 'Welcome')}</span>{channel?.locked ? <LockIcon /> : null}</strong>
      </div>
      {server ? (
        <div className="community-chat-header-actions">
          <button id="server-members-toggle" type="button" onClick={onToggleMembers} aria-label="Toggle members" title="Members" aria-expanded={membersVisible} aria-controls="server-members-panel"><UserIcon /></button>
          <button type="button" onClick={onSettings} aria-label="Server settings" title="Server settings"><SettingsIcon /></button>
        </div>
      ) : null}
    </header>
  );
}
