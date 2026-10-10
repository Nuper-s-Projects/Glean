import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { UserPopoutProvider } from '../dm/userPopout';
import ProfilePosts from './ProfilePosts';
import { loopRequest } from './loopRequest';

export function LoopProfile({ id, username, account, onBack, onMessage, renderPost }) {
  const [profile, setProfile] = useState(null);
  const [user, setUser] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [following, setFollowing] = useState(false);
  const followLock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    setProfile(null);
    setUser(null);
    setError('');
    const load = async () => {
      const profileRequest = loopRequest(`/loop/profiles/${id}`, { signal: controller.signal });
      const userRequest = username ? loopRequest(`/users/${encodeURIComponent(username)}`, { signal: controller.signal }).catch(failure => ({ failure }))
        : profileRequest.then(({ profile: loaded }) => loopRequest(`/users/${encodeURIComponent(loaded.username)}`, { signal: controller.signal }));
      const [{ profile: loaded }, details] = await Promise.all([profileRequest, userRequest]);
      // An avatar's older label may predate a username change. Resolve the
      // authoritative profile ID, never accidentally show a recycled username.
      let gleanUser = details.user;
      if (loaded.username !== username && username) {
        ({ user: gleanUser } = await loopRequest(`/users/${encodeURIComponent(loaded.username)}`, { signal: controller.signal }));
      } else if (details.failure) throw details.failure;
      if (Number(gleanUser?.id) !== Number(loaded.id)) throw new Error('That profile changed. Please try again.');
      if (controller.signal.aborted) return;
      setProfile(loaded);
      setUser(gleanUser);
    };
    load().catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => { controller.abort(); generation.current += 1; };
  }, [id, username, retry]);
  const toggleFollow = async () => {
    if (followLock.current) return;
    const requestedGeneration = generation.current;
    followLock.current = true;
    setFollowing(true);
    setError('');
    try {
      const data = await apiRequest(`/loop/users/${id}/follow`, { method: 'POST', body: '{}' });
      if (requestedGeneration !== generation.current) return;
      setProfile((current) => ({ ...current, followed: data.followed, followers: Math.max(0, current.followers + (data.followed === current.followed ? 0 : data.followed ? 1 : -1)) }));
    } catch (failure) { if (requestedGeneration === generation.current) setError(failure.message); }
    finally { followLock.current = false; setFollowing(false); }
  };
  return <section className="loop-profile-page">
    <button className="loop-back-inline" type="button" onClick={onBack}>← Back</button>
    {profile && user ? <UserPopoutProvider key={id} account={account} inlineUser={user} onMessage={onMessage} profileFooter={
      <div className="loop-profile-shared-footer">
        <div className="loop-profile-stats"><span><strong>{profile.followers.toLocaleString()}</strong> followers</span><span><strong>{profile.following.toLocaleString()}</strong> following</span></div>
        {!profile.own ? <div className="loop-profile-actions">
          {user.relation !== 'friend' && user.relation !== 'blocked' ? <button className="dm-small-action" type="button" onClick={() => onMessage(profile.id)}>Message</button> : null}
          <button className="dm-small-action" type="button" onClick={toggleFollow} disabled={following} aria-pressed={profile.followed}>{following ? 'Updating…' : profile.followed ? 'Following' : 'Follow'}</button>
        </div> : null}
        {error ? <p className="loop-profile-error" role="alert">{error}</p> : null}
      </div>
    } /> : error ? <div className="loop-workspace-status" role="alert"><p>{error}</p><button className="loop-secondary-button" type="button" onClick={() => setRetry((value) => value + 1)}>Try again</button></div>
      : <div className="loop-profile-skeleton" role="status" aria-label="Loading profile"><div /><span /><span /></div>}
    {profile && user ? <ProfilePosts key={`posts-${id}`} id={id} username={profile.username} renderPost={renderPost} /> : null}
  </section>;
}
