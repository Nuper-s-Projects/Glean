import { PlusIcon, CompassIcon } from '../dm/icons';
import { displayInitial } from './CommunityAvatar';
import { formatUnreadCount } from '../../app/pwa';
import { inspectServersVisible } from '../../app/dmApi';
import useHoldReorder from './useHoldReorder';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function RailMark({ count = 0, pip = false }) {
  const label = formatUnreadCount(count);
  if (label) return <b className="rail-unread-count">{label}</b>;
  if (pip) return <i className="rail-unread-pip" aria-hidden="true" />;
  return null;
}

function RailPill({ show }) {
  if (!show) return null;
  return <span className="dm-rail-pill" aria-hidden="true" />;
}

function ServerSlot({ server, activeServerId, bind = {}, dragging = false, onShowTooltip, onHideTooltip, onContextMenu }) {
  const mentions = server.inspecting || server.muted ? 0 : Number(server.mentionCount || 0);
  const unreadCount = server.inspecting || server.muted ? 0 : Number(server.unreadCount || 0);
  const unread = !server.inspecting && !server.muted && Boolean(server.unread);
  const active = Number(activeServerId) === Number(server.id);
  return (
    <div
      className={`dm-rail-slot${server.inspecting ? '' : ' is-reorderable'}${dragging ? ' is-dragging' : ''}${active ? ' is-current' : ''}`}
      {...bind}
    >
      <RailPill show={active} />
      <button
        className={`dm-rail-button${server.iconUrl ? ' has-icon' : ''}${active ? ' is-active' : ''}${server.inspecting ? ' is-inspecting' : ''}`}
        type="button"
        onClick={() => server.onOpen?.(server)}
        onContextMenu={(event) => onContextMenu?.(event, server)}
        onMouseEnter={(event) => onShowTooltip?.(server, event.currentTarget)}
        onMouseLeave={(event) => {
          const target = event.currentTarget;
          window.setTimeout(() => { if (document.activeElement !== target) onHideTooltip?.(); }, 0);
        }}
        onFocus={(event) => onShowTooltip?.(server, event.currentTarget)}
        onBlur={(event) => {
          const target = event.currentTarget;
          window.setTimeout(() => { if (document.activeElement !== target) onHideTooltip?.(); }, 0);
        }}
        aria-label={server.inspecting ? `Inspect ${server.name}` : unreadCount ? `${server.name}, ${unreadCount} unread` : mentions ? `${server.name}, ${mentions} mentions` : unread ? `${server.name}, unread` : `Open ${server.name}`}
      >
        {server.iconUrl ? <img src={server.iconUrl} alt="" draggable="false" loading="lazy" decoding="async" /> : displayInitial(server.name)}
      </button>
      <RailMark count={unreadCount || mentions} pip={unread} />
    </div>
  );
}

export default function AppRail({
  account = null,
  homeActive = false,
  discoverActive = false,
  homeBadge = 0,
  servers = [],
  activeServerId = null,
  isLoading = false,
  onHome,
  onDiscover,
  onOpenServer,
  onAddServer,
  onReorder,
  onInviteServer,
  onLeaveServer,
  onMuteServer,
}) {
  const railRef = useRef(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(false);
  const [serverTooltip, setServerTooltip] = useState(null);
  const [serverContextMenu, setServerContextMenu] = useState(null);
  const showServerTooltip = (server, target) => {
    const rect = target.getBoundingClientRect();
    const below = window.matchMedia('(max-width: 600px)').matches;
    setServerTooltip({
      name: server.name || 'Unnamed server',
      inspecting: Boolean(server.inspecting),
      placement: below ? 'below' : 'side',
      left: below ? rect.left + rect.width / 2 : rect.right + 12,
      top: below ? rect.bottom + 10 : rect.top + rect.height / 2,
    });
  };
  const hideServerTooltip = () => setServerTooltip(null);
  const openServerContextMenu = (event, server) => {
    event.preventDefault();
    event.stopPropagation();
    hideServerTooltip();
    const width = 190;
    const height = 146;
    setServerContextMenu({
      server,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    });
  };
  const updateFade = () => {
    const rail = railRef.current;
    if (!rail) return;
    const vertical = rail.scrollHeight > rail.clientHeight;
    const position = vertical ? rail.scrollTop : rail.scrollLeft;
    const remaining = vertical ? rail.scrollHeight - rail.clientHeight - rail.scrollTop : rail.scrollWidth - rail.clientWidth - rail.scrollLeft;
    setAtTop(position < 8);
    setAtBottom(remaining < 8);
  };
  useEffect(() => {
    updateFade();
    const observer = new ResizeObserver(updateFade);
    const contentObserver = new MutationObserver(updateFade);
    if (railRef.current) observer.observe(railRef.current);
    if (railRef.current) contentObserver.observe(railRef.current, { childList: true, subtree: true });
    window.addEventListener('resize', updateFade);
    return () => { observer.disconnect(); contentObserver.disconnect(); window.removeEventListener('resize', updateFade); };
  }, []);
  useEffect(() => {
    if (!serverContextMenu) return undefined;
    const closeOnOutsidePress = (event) => {
      if (!event.target.closest('.dm-server-context-menu')) setServerContextMenu(null);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setServerContextMenu(null);
    };
    const closeOnViewportChange = () => setServerContextMenu(null);
    window.addEventListener('pointerdown', closeOnOutsidePress);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePress);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [serverContextMenu]);
  const memberServers = servers.filter((server) => !server.inspecting);
  const inspectingServers = inspectServersVisible(account) ? servers.filter((server) => server.inspecting) : [];
  const reorder = useHoldReorder({
    items: memberServers,
    enabled: Boolean(onReorder) && memberServers.length > 1,
    allowTouch: false,
    onReorder,
  });

  return (
    <>
      <nav ref={railRef} className={`dm-rail${reorder.isDragging ? ' is-reordering' : ''}${atTop ? ' is-at-top' : ''}${atBottom ? ' is-at-bottom' : ''}`} aria-label="Servers" onMouseLeave={() => { if (!railRef.current?.contains(document.activeElement)) hideServerTooltip(); }} onScroll={() => { updateFade(); if (!railRef.current?.contains(document.activeElement)) hideServerTooltip(); }}>
      <div className={`dm-rail-slot${homeActive && !discoverActive ? ' is-current' : ''}`}>
        <RailPill show={homeActive && !discoverActive} />
        <button
          className={`dm-home-button${homeActive && !discoverActive ? ' is-active' : ''}`}
          type="button"
          onClick={homeActive && !discoverActive ? undefined : onHome}
          aria-label={homeBadge ? `Direct messages, ${homeBadge} unread` : 'Direct messages'}
          title="Direct messages"
          aria-current={homeActive && !discoverActive ? 'page' : undefined}
        >
          <span>g</span>
        </button>
        <RailMark count={homeBadge} />
      </div>
      <div className={`dm-rail-slot${discoverActive ? ' is-current' : ''}`}>
        <RailPill show={discoverActive} />
        <button
          className={`dm-rail-button${discoverActive ? ' is-active' : ''}`}
          type="button"
          onClick={onDiscover}
          aria-label="Discover people"
          title="Discover people"
          aria-current={discoverActive ? 'page' : undefined}
        >
          <CompassIcon />
        </button>
      </div>
      <div className="community-rail-divider" />
      <div className="dm-rail-servers" data-reorder-list="servers">
        {reorder.items.map((server) => (
          <ServerSlot
            key={server.id}
            server={{ ...server, onOpen: onOpenServer }}
            activeServerId={activeServerId}
            bind={reorder.bind(server.id)}
            dragging={String(reorder.draggingId) === String(server.id)}
            onShowTooltip={showServerTooltip}
            onHideTooltip={hideServerTooltip}
            onContextMenu={openServerContextMenu}
          />
        ))}
      </div>
      {inspectingServers.map((server) => (
        <ServerSlot key={server.id} server={{ ...server, onOpen: onOpenServer }} activeServerId={activeServerId} onShowTooltip={showServerTooltip} onHideTooltip={hideServerTooltip} onContextMenu={openServerContextMenu} />
      ))}
      {isLoading ? <span className="community-rail-loader" aria-label="Loading servers" /> : null}
      <button className="dm-rail-button" type="button" onClick={onAddServer} aria-label="Add a server" title="Add a server">
        <PlusIcon />
      </button>
      </nav>
      {serverTooltip && typeof document !== 'undefined' ? createPortal(
        <div
          className={`dm-server-tooltip is-${serverTooltip.placement}`}
          style={{ left: serverTooltip.left, top: serverTooltip.top }}
          role="tooltip"
        >
          {serverTooltip.name}
          {serverTooltip.inspecting ? <small>Inspecting</small> : null}
        </div>,
        document.body,
      ) : null}
      {serverContextMenu && typeof document !== 'undefined' ? createPortal(
        <div
          className="dm-server-context-menu"
          role="menu"
          style={{ left: serverContextMenu.left, top: serverContextMenu.top }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => { const server = serverContextMenu.server; setServerContextMenu(null); onMuteServer?.(server, !server.muted); }}>{serverContextMenu.server.muted ? 'Unmute this server' : 'Mute this server'}</button>
          <button type="button" role="menuitem" onClick={() => { const server = serverContextMenu.server; setServerContextMenu(null); onInviteServer?.(server); }}>Invite to Server</button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => { const server = serverContextMenu.server; setServerContextMenu(null); onLeaveServer?.(server); }}>Leave Server</button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
