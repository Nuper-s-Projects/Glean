import { useUserPopout } from '../dm/userPopout';
import { usePresence } from '../../app/presence';

export function displayInitial(value) {
  return String(value || '?').slice(0, 1).toUpperCase();
}

export function ServerIcon({ server, large = false }) {
  return (
    <span className={`community-server-icon${large ? ' is-large' : ''}`} aria-hidden="true">
      {server?.iconUrl ? <img src={server.iconUrl} alt="" loading="lazy" decoding="async" /> : displayInitial(server?.name)}
    </span>
  );
}

export function CommunityAvatar({ user, small = false, interactive = true, presence: showPresence = false, onContextMenu }) {
  const { open } = useUserPopout();
  const status = usePresence(user?.id, showPresence ? (user?.presence || 'offline') : '');
  const pip = showPresence ? status : '';
  const node = (
    <div className={`community-avatar${small ? ' is-small' : ''}${pip ? ` is-${pip}` : ''}`} aria-hidden="true" onContextMenu={interactive ? undefined : onContextMenu}>
      {user?.avatarUrl ? <img src={user.avatarUrl} alt="" loading="lazy" decoding="async" /> : displayInitial(user?.username)}
    </div>
  );
  if (!interactive || !user) return node;
  return (
    <button
      type="button"
      className="dm-user-avatar"
      onClick={(event) => { event.stopPropagation(); open(user, event.currentTarget); }}
      onContextMenu={onContextMenu}
      aria-label={`View ${user.username || 'user'}'s profile`}
    >
      {node}
    </button>
  );
}
