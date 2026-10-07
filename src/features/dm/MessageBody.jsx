import { memo } from 'react';
import { extractInviteCodes, stripInviteTokens } from '../../app/invite';
import { markdownToHtml } from '../community/markdown';
import ServerInviteCard from '../community/ServerInviteCard';
import { isEveryoneMention } from './mentions';
import { nameStyleAttr } from './nameStyle';
import { useImagePreview } from './ImagePreview';
import { useUserPopout } from './userPopout';

export const MessageBody = memo(function MessageBody({ body, className, users = [], currentUsername = '' }) {
  const { open } = useUserPopout();
  const { open: openPreview } = useImagePreview();
  if (!body) return null;
  const invites = extractInviteCodes(body);
  const leftover = stripInviteTokens(body);
  const mentionUsernames = [...new Set(['everyone', ...users.map((user) => user.username).filter(Boolean)])];
  const mentionStyles = {};
  for (const user of users) {
    const name = String(user?.username || '').toLowerCase();
    if (!name || isEveryoneMention(user) || !user?.nameStyle) continue;
    mentionStyles[name] = nameStyleAttr(user.nameStyle);
  }
  return (
    <div className={className}>
      {leftover ? (
        <div
          dangerouslySetInnerHTML={{ __html: markdownToHtml(leftover, { mentionUsernames, mentionStyles, currentUsername }) }}
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
            const user = users.find((item) => !isEveryoneMention(item) && String(item.username || '').toLowerCase() === String(username || '').toLowerCase());
            if (!user) return;
            open(user, mention);
          }}
        />
      ) : null}
      {invites.map((code) => <ServerInviteCard key={code} code={code} />)}
    </div>
  );
});
