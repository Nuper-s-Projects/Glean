import { CommunityAvatar } from './CommunityAvatar';
import { HeadphonesIcon, MicOffIcon, ScreenIcon, VideoIcon } from '../dm/icons';
import { PresenceWrap } from '../dm/DmPrimitives';
import { useUserPopout } from '../dm/userPopout';

export function VoiceBadges({ user }) {
  return (
    <span className="community-voice-badges">
      {user?.muted || user?.deafened ? <span title="Microphone muted" aria-label="Microphone muted"><MicOffIcon /></span> : null}
      {user?.deafened ? <span title="Sound off" aria-label="Sound off"><HeadphonesIcon /></span> : null}
      {user?.camera ? <span title="Camera on" aria-label="Camera on"><VideoIcon /></span> : null}
      {user?.sharing ? <span title="Sharing screen" aria-label="Sharing screen"><ScreenIcon /></span> : null}
    </span>
  );
}

export function VoiceOccupantRow({ user, selfId, onContextMenu }) {
  const { open } = useUserPopout();
  return (
    <PresenceWrap as="button" type="button" className={`community-voice-occupant${user.speaking ? ' is-speaking' : ''}`} user={user} onContextMenu={(event) => onContextMenu?.(event, user)} onClick={(event) => open(user, event.currentTarget)}>
      <CommunityAvatar user={user} small interactive={false} presence />
      <span>{user.username}{Number(user.id) === Number(selfId) ? ' (you)' : ''}</span>
      <VoiceBadges user={user} />
    </PresenceWrap>
  );
}

export function occupantsOf(occupancy, channelId) {
  return occupancy?.[String(channelId)] || occupancy?.[channelId] || [];
}

export function allVoiceOccupants(occupancy) {
  return Object.values(occupancy || {}).flat();
}
