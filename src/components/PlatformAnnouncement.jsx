import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../app/apiClient';
import { subscribeToDmEvents } from '../app/dmApi';
import { useUserPopout } from '../features/dm/userPopout';

export default function PlatformAnnouncement({ account }) {
  const [announcement, setAnnouncement] = useState(null);
  const profileButtonRef = useRef(null);
  const { open } = useUserPopout();

  useEffect(() => {
    if (!account?.id) return undefined;
    let active = true;
    const refresh = () => apiRequest('/announcement')
      .then((next) => { if (active) setAnnouncement(next); })
      .catch(() => {});
    refresh();
    const subscription = subscribeToDmEvents((event, payload) => {
      if (event === 'platform-announcement-updated') setAnnouncement(payload);
      else if (event === 'connected') refresh();
    }, () => {}, account.id);
    return () => {
      active = false;
      subscription.close();
    };
  }, [account?.id]);

  if (!announcement?.enabled || !announcement.message) return null;
  const profile = announcement.profile || { username: 'Nuper', avatarUrl: null };

  return (
    <aside className="platform-announcement" aria-label="Glean announcement" role="region">
      <p className="platform-announcement-message">{announcement.message}</p>
      <button
        ref={profileButtonRef}
        type="button"
        className="platform-announcement-profile"
        aria-label={`Open ${profile.username || 'Nuper'}’s profile`}
        onClick={() => open(profile, profileButtonRef.current)}
      >
        <span className="platform-announcement-avatar" aria-hidden="true">
          {profile.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : (profile.username || 'N').slice(0, 1).toUpperCase()}
        </span>
        <span>{profile.username || 'Nuper'}</span>
      </button>
    </aside>
  );
}
