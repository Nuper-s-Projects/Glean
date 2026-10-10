import { memo, useMemo } from 'react';
import { extractInviteCodes, stripInviteTokens } from '../../app/invite';
import { markdownToHtml } from '../community/markdown';
import ServerInviteCard from '../community/ServerInviteCard';
import { isEveryoneMention } from './mentions';
import { nameStyleAttr } from './nameStyle';
import { useImagePreview } from './ImagePreview';
import { useUserPopout } from './userPopout';

const EMPTY_USERS = [];
const mentionDirectories = new WeakMap();

function mentionDirectory(users) {
  const cached = mentionDirectories.get(users);
  if (cached) return cached;
  const mentionUsernames = new Set(['everyone']);
  const mentionStyles = {};
  const byUsername = new Map();
  for (const user of users) {
    const name = String(user?.username || '').toLowerCase();
    if (!name) continue;
    mentionUsernames.add(name);
    if (isEveryoneMention(user)) continue;
    byUsername.set(name, user);
    if (user.nameStyle) mentionStyles[name] = nameStyleAttr(user.nameStyle);
  }
  const directory = { mentionUsernames: [...mentionUsernames], mentionStyles, byUsername };
  mentionDirectories.set(users, directory);
  return directory;
}

export const MessageBody = memo(function MessageBody({ body, className, users = EMPTY_USERS, currentUsername = '' }) {
  const { open } = useUserPopout();
  const { open: openPreview } = useImagePreview();
  const directory = mentionDirectory(users);
  const invites = useMemo(() => extractInviteCodes(body || ''), [body]);
  const html = useMemo(() => {
    const leftover = stripInviteTokens(body || '');
    return leftover ? markdownToHtml(leftover, { ...directory, currentUsername }) : '';
  }, [body, directory, currentUsername]);
  if (!body) return null;
  return (
    <div className={className}>
      {html ? (
        <div
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(event) => {
            const imageLink = event.target.closest?.('.community-link-image');
            if (imageLink) {
              event.preventDefault();
              const img = imageLink.querySelector('img');
              const src = img?.currentSrc || img?.src || imageLink.getAttribute('href');
              if (src) openPreview({ src, alt: img?.getAttribute('alt') || 'Image', name: img?.getAttribute('alt') || 'Image' });
              return;
            }
            const mention = event.target.closest?.('.dm-mention');
            if (!mention) return;
            const username = mention.getAttribute('data-mention');
            if (String(username || '').toLowerCase() === 'everyone') return;
            const user = directory.byUsername.get(String(username || '').toLowerCase());
            if (!user) return;
            open(user, mention);
          }}
        />
      ) : null}
      {invites.map((code) => <ServerInviteCard key={code} code={code} />)}
    </div>
  );
});
