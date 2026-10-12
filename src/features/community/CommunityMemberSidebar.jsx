import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommunityAvatar } from './CommunityAvatar';
import { VoiceOccupantRow } from './VoiceBits';
import { PresenceWrap } from '../dm/DmPrimitives';
import DisplayName from '../dm/DisplayName';
import { CloseIcon } from '../dm/icons';
import { buildMemberListRows, firstMemberRowAtOrAfter, MEMBER_OVERSCAN } from './memberListLayout';

const CommunityMemberRow = memo(function CommunityMemberRow({ member, accountId, onOpen, onContextMenu }) {
  return (
    <PresenceWrap as="button" type="button" className="community-member-chip" user={member} onContextMenu={event => onContextMenu(event, member)} onClick={event => onOpen(member, event.currentTarget)}>
      <CommunityAvatar user={member} small interactive={false} presence onContextMenu={event => onContextMenu(event, member)} />
      <span>
        <strong><DisplayName user={member} suffix={Number(member.id) === Number(accountId) ? ' (you)' : ''} /></strong>
        <small style={{ color: member.roleColor }}>{member.roleName || ''}{member.permissions === 'moderator' ? <b className="community-mod-badge" title="Server moderator">MOD</b> : null}{member.timeoutUntil && Date.parse(member.timeoutUntil) > Date.now() ? ' · Timed out' : ''}</small>
      </span>
    </PresenceWrap>
  );
});

function CommunityMemberSidebar({ serverId, groups, voicePeople, accountId, loading, hasMore, scrollRef, sentinelRef, onOpen, onMemberContextMenu, onVoiceContextMenu, onClose }) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const frameRef = useRef(0);
  const rows = useMemo(() => buildMemberListRows(groups, voicePeople), [groups, voicePeople]);
  const totalHeight = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;
  const visibleStart = firstMemberRowAtOrAfter(rows, Math.max(0, scrollTop - MEMBER_OVERSCAN));
  const visibleEnd = firstMemberRowAtOrAfter(rows, scrollTop + viewportHeight + MEMBER_OVERSCAN);
  const visibleRows = rows.slice(visibleStart, Math.min(rows.length, Math.max(visibleStart + 1, visibleEnd + 1)));

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return undefined;
    const updateHeight = () => setViewportHeight(current => current === root.clientHeight ? current : root.clientHeight);
    updateHeight();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(root);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [scrollRef]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [serverId, scrollRef]);
  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); }, []);

  const handleScroll = useCallback(event => {
    const root = event.currentTarget;
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setScrollTop(root.scrollTop);
    });
  }, []);

  return (
    <section className="community-members-panel" id="server-members-panel">
      <header className="community-members-toolbar"><h2>Members</h2><button id="server-members-close" type="button" onClick={onClose} aria-label="Hide members"><CloseIcon /></button></header>
      <aside ref={scrollRef} onScroll={handleScroll} className="community-members" aria-label="Members">
        {serverId ? (
          <div className="community-member-virtual-canvas" style={{ height: totalHeight }}>
            {visibleRows.map(row => (
              <div key={row.key} className="community-member-virtual-row" style={{ top: row.top, height: row.height }}>
                {row.type === 'heading' ? <p className="community-label community-member-virtual-heading">{row.color ? <i style={{ backgroundColor: row.color }} aria-hidden="true" /> : null}{row.label}</p> : null}
                {row.type === 'voice' ? <VoiceOccupantRow user={row.user} selfId={accountId} onContextMenu={onVoiceContextMenu} /> : null}
                {row.type === 'member' ? <CommunityMemberRow member={row.member} accountId={accountId} onOpen={onOpen} onContextMenu={onMemberContextMenu} /> : null}
              </div>
            ))}
          </div>
        ) : <p className="community-empty">Members appear here.</p>}
        {serverId && hasMore ? <div ref={sentinelRef} className="community-members-load-sentinel" aria-live="polite">{loading ? 'Loading more members…' : 'Scroll for more members'}</div> : null}
        {serverId && !hasMore && !rows.length ? <p className="community-empty">No members yet.</p> : null}
      </aside>
    </section>
  );
}

export default memo(CommunityMemberSidebar);
