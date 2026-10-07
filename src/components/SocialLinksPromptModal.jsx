import { useState } from 'react';
import { skipAccountSocialLinks, updateAccountDiscord, updateAccountSocialLinks } from '../app/dmApi';
import { normalizeDiscordUsername } from '../app/discordUsername';
import { normalizeSocialUrl, normalizeSocialUsername } from '../app/socialLinks';

export default function SocialLinksPromptModal({ account, onSaved }) {
  const [discord, setDiscord] = useState(account?.discordUsername || '');
  const [instagramUsername, setInstagramUsername] = useState(account?.socialLinks?.instagramUsername || '');
  const [instagram, setInstagram] = useState(account?.socialLinks?.instagram || '');
  const [tiktokUsername, setTiktokUsername] = useState(account?.socialLinks?.tiktokUsername || '');
  const [tiktok, setTiktok] = useState(account?.socialLinks?.tiktok || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (discord.trim() && normalizeDiscordUsername(discord) == null) { setError('Use a valid Discord username.'); return; }
    const nextInstagramUsername = normalizeSocialUsername(instagramUsername, 'instagram');
    const nextInstagram = normalizeSocialUrl(instagram, 'instagram');
    const nextTiktokUsername = normalizeSocialUsername(tiktokUsername, 'tiktok');
    const nextTiktok = normalizeSocialUrl(tiktok, 'tiktok');
    if (nextInstagramUsername == null || nextInstagram == null || nextTiktokUsername == null || nextTiktok == null) {
      setError('Please check your Instagram and TikTok usernames or links.');
      return;
    }
    setBusy(true);
    try {
      await updateAccountDiscord(discord.trim());
      onSaved(await updateAccountSocialLinks({ instagramUsername: nextInstagramUsername, instagram: nextInstagram, tiktokUsername: nextTiktokUsername, tiktok: nextTiktok }));
    } catch (failure) { setError(failure.message); setBusy(false); }
  };
  const skip = async () => {
    if (busy) return;
    setBusy(true);
    try { onSaved(await skipAccountSocialLinks()); } catch (failure) { setError(failure.message); setBusy(false); }
  };
  return <div className="social-prompt-backdrop" role="dialog" aria-modal="true" aria-labelledby="social-prompt-title">
    <form className="social-prompt-modal" onSubmit={save}>
      <span className="social-prompt-kicker">Make connections</span>
      <h2 id="social-prompt-title">Share your socials</h2>
      <p>Share you social media, to connect, explore, and find new friends! Maybe its for a better future? If you don't want to do this step now, you can easily go back and set it up or change it in settings.</p>
      <label>Discord<input value={discord} onChange={(event) => setDiscord(event.target.value)} placeholder="Username (optional)" /></label>
      <label>Instagram username<input value={instagramUsername} onChange={(event) => setInstagramUsername(event.target.value)} placeholder="Username (optional)" /></label>
      <label>Instagram link<input value={instagram} onChange={(event) => setInstagram(event.target.value)} placeholder="Link (optional)" /></label>
      <label>TikTok username<input value={tiktokUsername} onChange={(event) => setTiktokUsername(event.target.value)} placeholder="Username (optional)" /></label>
      <label>TikTok link<input value={tiktok} onChange={(event) => setTiktok(event.target.value)} placeholder="Link (optional)" /></label>
      {error ? <p className="social-prompt-error" role="alert">{error}</p> : null}
      <div className="social-prompt-actions"><button type="button" className="secondary-button" onClick={skip} disabled={busy}>Skip this step</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save socials'}</button></div>
    </form>
  </div>;
}
