import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { acceptFriendRequest, blockUser, cancelFriendRequest, declineFriendRequest, getUserProfile, openDirectConversation, sendFriendRequest, unblockUser, unfriendUser } from '../../app/dmApi';
import { presenceLabel, usePresence, usePresenceHidden } from '../../app/presence';
import { profileThemeStyle, useContactBannerStyle } from './banner';
import { formatJoinedDate } from './formatters';
import { CopyIcon, DiscordIcon, InstagramIcon, TikTokIcon, UserIcon } from './icons';
import DisplayName from './DisplayName';
import { schoolBadgeStyle } from '../../app/laredoSchools';
import CustomBadges from './CustomBadges';

const UserPopoutContext = createContext({ open() {}, close() {}, setDirectory() {} });

function mergeUser(user, directory, account) {
  if (!user) return null;
  const id = Number(user.id);
  const name = String(user.username || '').toLowerCase();
  const listed = (directory || []).find((item) => (id && Number(item.id) === id) || (name && String(item.username || '').toLowerCase() === name)) || {};
  const self = account && ((id && Number(account.id) === id) || (name && String(account.username || '').toLowerCase() === name))
    ? {
      id: account.id,
      username: account.username,
      avatarUrl: account.avatarUrl,
      banner: account.banner,
      profileBackground: account.profileBackground,
      bio: account.bio,
      nameStyle: account.nameStyle,
      createdAt: account.createdAt,
      platformAdmin: account.platformAdmin,
      grade: account.grade,
      gradeLabel: account.gradeLabel,
      school: account.school,
      schoolLabel: account.schoolLabel,
      schoolHex: account.schoolHex,
      programs: account.programs,
      discordUsername: account.discordUsername,
      socialLinks: account.socialLinks,
      badges: account.badges,
      customBadges: account.customBadges,
      relation: 'self',
    }
    : {};
  return { ...self, ...listed, ...user };
}

function placeCard(anchor, card) {
  const rect = anchor.getBoundingClientRect();
  const width = card?.offsetWidth || 340;
  const height = card?.offsetHeight || 420;
  const gap = 10;
  let left = rect.right + gap;
  if (left + width > window.innerWidth - 12) left = rect.left - width - gap;
  if (left < 12) left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
  let top = rect.bottom - height;
  if (top < 12) top = rect.top;
  if (top + height > window.innerHeight - 12) top = Math.max(12, window.innerHeight - height - 12);
  return { top, left };
}

function relationLabel(relation) {
  if (relation === 'self') return 'You';
  if (relation === 'friend') return 'Friends';
  if (relation === 'outgoing') return 'Request sent';
  if (relation === 'incoming') return 'Incoming';
  if (relation === 'blocked') return 'Blocked';
  return '';
}

export function useUserPopout() {
  return useContext(UserPopoutContext);
}

export function UserPopoutProvider({ account, children, inlineUser = null, onMessage, profileFooter }) {
  const [popout, setPopout] = useState(null);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const directoryRef = useRef([]);
  const cardRef = useRef(null);
  const popoutRef = useRef(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  popoutRef.current = popout;

  useEffect(() => {
    if (inlineUser) setPopout({ user: mergeUser(inlineUser, [], account), anchor: null });
  }, [inlineUser, account]);

  const close = useCallback(() => {
    setPopout(null);
    setCopied('');
    setBusy('');
    setNotice('');
  }, []);
  const setDirectory = useCallback((users) => {
    directoryRef.current = users || [];
  }, []);
  const patchUser = useCallback((username, next) => {
    setPopout((current) => {
      if (!current || String(current.user.username || '').toLowerCase() !== String(username || '').toLowerCase()) return current;
      return { ...current, user: { ...current.user, ...next } };
    });
  }, []);
  const open = useCallback((user, anchor) => {
    if (!user || !anchor) return;
    const merged = mergeUser(user, directoryRef.current, account);
    const username = merged?.username;
    if (popoutRef.current && String(popoutRef.current.user?.username || '').toLowerCase() === String(username || '').toLowerCase()) {
      close();
      return;
    }
    setCopied('');
    setBusy('');
    setNotice('');
    setCoords(placeCard(anchor, cardRef.current));
    setPopout({ user: merged, anchor });
    if (!username) return;
    getUserProfile(username)
      .then(({ user: profile }) => patchUser(username, profile))
      .catch(() => {});
  }, [account, close, patchUser]);

  const api = useMemo(() => ({ open, close, setDirectory }), [open, close, setDirectory]);

  useLayoutEffect(() => {
    if (!popout?.anchor) return;
    setCoords(placeCard(popout.anchor, cardRef.current));
  }, [popout]);

  useEffect(() => {
    if (!popout?.anchor) return undefined;
    const onPointer = (event) => {
      if (event.target.closest?.('.dm-banner-backdrop')) return;
      if (cardRef.current?.contains(event.target) || popout.anchor?.contains?.(event.target)) return;
      close();
    };
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    const onScroll = (event) => {
      if (cardRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    const onResize = () => close();
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [popout, close]);

  const user = popout?.user;
  const banner = useContactBannerStyle(user);
  const profileBackgroundStyle = user?.profileBackground ? profileThemeStyle(user.profileBackground) : null;
  const relation = user?.relation || (user && account && Number(user.id) === Number(account.id) ? 'self' : '');
  const joined = formatJoinedDate(user?.createdAt);
  const handle = user?.username ? `@${user.username}` : '';
  const inLaredoCollege = (user?.programs || []).some((item) => item.id === 'laredo-college');
  const inMagnet = (user?.programs || []).some((item) => item.id === 'magnet');
  const visiblePrograms = (user?.programs || []).filter((program) => program.id === 'magnet' || program.id === 'laredo-college');
  const instagramUrl = user?.socialLinks?.instagram || (user?.socialLinks?.instagramUsername ? `https://instagram.com/${encodeURIComponent(user.socialLinks.instagramUsername)}` : '');
  const tiktokUrl = user?.socialLinks?.tiktok || (user?.socialLinks?.tiktokUsername ? `https://www.tiktok.com/@${encodeURIComponent(user.socialLinks.tiktokUsername)}` : '');
  const livePresence = usePresence(user?.id, user?.presence || 'offline');
  const selfHidden = usePresenceHidden(account?.id, Boolean(account?.presenceHidden));
  const hidden = relation === 'self' && selfHidden;
  const statusText = presenceLabel(livePresence, hidden);

  const copyUsername = async () => {
    if (!user?.username) return;
    try {
      await navigator.clipboard.writeText(user.username);
      setCopied('glean');
      window.setTimeout(() => setCopied((current) => (current === 'glean' ? '' : current)), 1400);
    } catch {
      setNotice('Could not copy username.');
    }
  };

  const copyDiscord = async () => {
    if (!user?.discordUsername) return;
    try {
      await navigator.clipboard.writeText(user.discordUsername);
      setCopied('discord');
      window.setTimeout(() => setCopied((current) => (current === 'discord' ? '' : current)), 1400);
    } catch {
      setNotice('Could not copy Discord username.');
    }
  };

  const messageUser = async () => {
    if (!user?.username || busy) return;
    setBusy('message');
    setNotice('');
    try {
      if (onMessage) {
        await onMessage(user.id);
        setBusy('');
        return;
      }
      const { conversation } = await openDirectConversation(user.username);
      try { sessionStorage.setItem('glean.openConversationId', String(conversation.id)); } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent('glean-open-dm', { detail: { username: user.username, conversationId: conversation.id } }));
      close();
    } catch (error) {
      setNotice(error.message);
      setBusy('');
    }
  };

  const addUser = async () => {
    if (!user?.username || busy) return;
    setBusy('add');
    setNotice('');
    try {
      await sendFriendRequest(user.username);
      const { user: profile } = await getUserProfile(user.username);
      patchUser(user.username, profile);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };

  const acceptUser = async () => {
    if (!user?.requestId || busy) return;
    setBusy('accept');
    setNotice('');
    try {
      await acceptFriendRequest(user.requestId);
      const { user: profile } = await getUserProfile(user.username);
      patchUser(user.username, profile);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };

  const cancelUser = async () => {
    if (!user?.requestId || busy) return;
    setBusy('cancel');
    setNotice('');
    try {
      await cancelFriendRequest(user.requestId);
      const { user: profile } = await getUserProfile(user.username);
      patchUser(user.username, profile);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };

  const declineUser = async () => {
    if (!user?.requestId || busy) return;
    setBusy('decline');
    setNotice('');
    try {
      await declineFriendRequest(user.requestId);
      const { user: profile } = await getUserProfile(user.username);
      patchUser(user.username, profile);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };

  const refreshProfile = async (username) => {
    const { user: profile } = await getUserProfile(username);
    patchUser(username, profile);
  };

  const unfriend = async () => {
    if (!user?.username || busy) return;
    if (!window.confirm(`Remove ${user.username} as a friend?`)) return;
    setBusy('unfriend');
    setNotice('');
    try {
      await unfriendUser(user.username);
      await refreshProfile(user.username);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };

  const block = async () => {
    if (!user?.username || busy) return;
    if (!window.confirm(`Block ${user.username}? They won't be told.`)) return;
    setBusy('block');
    setNotice('');
    try {
      await blockUser(user.username);
      await refreshProfile(user.username);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };

  const unblock = async () => {
    if (!user?.username || busy) return;
    setBusy('unblock');
    setNotice('');
    try {
      await unblockUser(user.username);
      await refreshProfile(user.username);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy('');
    }
  };


  return (
    <UserPopoutContext.Provider value={api}>
      {children}
      {user ? (
        <section
          className={`dm-contact-profile ${inlineUser ? 'loop-glean-profile' : 'is-floating'}${profileBackgroundStyle ? ' has-profile-background' : ''}${inLaredoCollege ? ' has-lc-ribbon' : ''}${inMagnet ? ' has-magnet-ribbon' : ''}`}
          ref={cardRef}
          style={{ ...(inlineUser ? {} : { top: coords.top, left: coords.left }), ...(profileBackgroundStyle || {}) }}
          aria-label={`${user.username || 'User'}'s profile`}
        >
          {inMagnet ? (
            <div className="dm-profile-ribbon is-magnet" aria-hidden="true">
              <span>MAGNET</span>
            </div>
          ) : null}
          {inLaredoCollege ? (
            <div className="dm-profile-ribbon is-lc" aria-hidden="true">
              <span>LC</span>
            </div>
          ) : null}
          <div className="dm-contact-banner" style={banner} />
          <div className={`dm-contact-avatar-wrap${livePresence === 'offline' ? ' is-offline' : ''}`}>
            <span className={`dm-avatar dm-avatar-large is-${livePresence || 'offline'}`} aria-hidden="true">
              {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <UserIcon size={46} />}
            </span>
          </div>
          <div className="dm-contact-identity">
            <h2><DisplayName user={user} className="dm-profile-display-name" /></h2>
            <p className={`dm-contact-status is-${hidden ? 'offline' : livePresence}`}>{statusText}</p>
            {handle || user.discordUsername ? (
              <div className="dm-contact-handles">
                {handle ? (
                  <button className="dm-contact-handle" type="button" onClick={copyUsername} title="Copy username">
                    {copied === 'glean' ? 'Copied' : handle}
                    <CopyIcon />
                  </button>
                ) : null}
                {user.discordUsername ? (
                  <button className="dm-contact-handle is-discord" type="button" onClick={copyDiscord} title="Copy Discord username">
                    <DiscordIcon />
                    {copied === 'discord' ? 'Copied' : user.discordUsername}
                    <CopyIcon />
                  </button>
                ) : null}
                {instagramUrl ? <a className="dm-contact-handle is-instagram" href={instagramUrl} target="_blank" rel="noreferrer"><InstagramIcon />{user.socialLinks?.instagramUsername ? `@${user.socialLinks.instagramUsername}` : 'Instagram'}</a> : null}
                {tiktokUrl ? <a className="dm-contact-handle is-tiktok" href={tiktokUrl} target="_blank" rel="noreferrer"><TikTokIcon />{user.socialLinks?.tiktokUsername ? `@${user.socialLinks.tiktokUsername}` : 'TikTok'}</a> : null}
              </div>
            ) : null}
            <div className="dm-contact-chips">
              {(user.badges || []).map((badge) => (
                <span className={`dm-profile-badge is-${badge.id}`} key={badge.id}>{badge.label}</span>
              ))}
              <CustomBadges badges={user.customBadges} />
              {user.schoolLabel ? (
                <span className="dm-contact-chip is-school" key="school" style={schoolBadgeStyle(user.schoolHex) || undefined}>{user.schoolLabel}</span>
              ) : null}
              {visiblePrograms.map((program) => (
                <span className="dm-contact-chip is-program" key={program.id} style={schoolBadgeStyle(program.hex) || undefined}>{program.id === 'laredo-college' ? 'Early College' : program.label}</span>
              ))}
            </div>
          </div>
          <div className="dm-contact-body">
            {profileFooter}
            <div className="dm-contact-section">
              <h3>About me</h3>
              <p className="dm-contact-bio">{user.bio || 'No bio yet.'}</p>
            </div>
            {joined ? (
              <div className="dm-contact-section">
                <h3>Member since</h3>
                <p>{joined}</p>
              </div>
            ) : null}
            {notice ? <p className="dm-contact-error">{notice}</p> : null}
            {relation === 'self' ? null : (
              <div className="dm-contact-actions">
                {relation === 'blocked' ? (
                  <button className="dm-small-action" type="button" disabled={Boolean(busy)} onClick={unblock}>{busy === 'unblock' ? 'Unblocking…' : 'Unblock'}</button>
                ) : relation === 'friend' ? (
                  <>
                    <button className="dm-small-action" type="button" disabled={Boolean(busy)} onClick={messageUser}>{busy === 'message' ? 'Opening…' : 'Message'}</button>
                    <button className="dm-small-action is-quiet" type="button" disabled={Boolean(busy)} onClick={unfriend}>{busy === 'unfriend' ? 'Removing…' : 'Unfriend'}</button>
                    <button className="dm-small-action is-danger" type="button" disabled={Boolean(busy)} onClick={block}>{busy === 'block' ? 'Blocking…' : 'Block'}</button>
                  </>
                ) : relation === 'incoming' ? (
                  <>
                    <button className="dm-small-action" type="button" disabled={Boolean(busy)} onClick={acceptUser}>{busy === 'accept' ? 'Accepting…' : 'Accept'}</button>
                    <button className="dm-small-action is-quiet" type="button" disabled={Boolean(busy)} onClick={declineUser}>{busy === 'decline' ? 'Declining…' : 'Decline'}</button>
                    <button className="dm-small-action is-danger" type="button" disabled={Boolean(busy)} onClick={block}>{busy === 'block' ? 'Blocking…' : 'Block'}</button>
                  </>
                ) : relation === 'outgoing' ? (
                  <>
                    <button className="dm-small-action is-quiet" type="button" disabled={Boolean(busy)} onClick={cancelUser}>{busy === 'cancel' ? 'Canceling…' : 'Cancel request'}</button>
                    <button className="dm-small-action is-danger" type="button" disabled={Boolean(busy)} onClick={block}>{busy === 'block' ? 'Blocking…' : 'Block'}</button>
                  </>
                ) : (
                  <>
                    <button className="dm-small-action" type="button" disabled={Boolean(busy)} onClick={addUser}>{busy === 'add' ? 'Sending…' : 'Add friend'}</button>
                    <button className="dm-small-action is-danger" type="button" disabled={Boolean(busy)} onClick={block}>{busy === 'block' ? 'Blocking…' : 'Block'}</button>
                  </>
                )}
              </div>
            )}
          </div>
        </section>
      ) : null}
    </UserPopoutContext.Provider>
  );
}
