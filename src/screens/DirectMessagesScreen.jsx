import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createServer, createServerInvite, getServers, inspectServersVisible, joinPublicServer, joinServerByInvite, leaveServer, patchCachedServerUnreadSummary, patchServerUnreadSummary, peekCachedServers, reorderServers, setServerMuted, subscribeToDmEvents } from '../app/dmApi';
import { inviteUrl, parseInviteInput, peekPendingInvite, takePendingInvite } from '../app/invite';
import { formatUnreadCount, setAppBadge } from '../app/pwa';
import AddServerDialog from '../features/community/AddServerDialog';
import AppRail from '../features/community/AppRail';
import AccountChrome from '../features/dm/AccountChrome';
import { Avatar, PresenceWrap } from '../features/dm/DmPrimitives';
import { IsolatedMessageComposer, typingStatusText } from '../features/dm/MessageComposer';
import { useDmData } from '../features/dm/useDmData';
import { useUserPopout } from '../features/dm/userPopout';
import { setPushFocus } from '../app/desktopPush';
import { USERNAME_INPUT_MAX_LENGTH } from '../app/username';
import DiscoverPanel, { DISCOVER_FILTERS } from '../features/dm/DiscoverPanel';
import { useDiscoverPeople } from '../features/dm/useDiscoverPeople';
import AnalyticsPanel from '../features/dm/AnalyticsPanel';
import { CompassIcon, ChartIcon, ChevronLeftIcon, PhoneIcon, PhoneOffIcon, PlusIcon, MoreIcon, CloseIcon } from '../features/dm/icons';
import DisplayName from '../features/dm/DisplayName';
import DmInbox from '../features/dm/DmInbox';
import DmTranscript from '../features/dm/DmTranscript';
import { presenceLabel, usePresence } from '../app/presence';
import '../features/dm/DmWorkspace.css';
import { DmCallSlot, useDmCall } from '../features/dm/DmCall';
import GroupDmDialog, { GroupAvatar } from '../features/dm/GroupDmDialog';

export default function DirectMessagesScreen({ account, goTo, onAccountUpdated, onSignedOut }) {
  const username = account?.username || 'you';
  const [activeView, setActiveView] = useState(() => {
    try {
      const view = sessionStorage.getItem('glean.dmView');
      sessionStorage.removeItem('glean.dmView');
      if (view === 'discover' || view === 'analytics' || view === 'requests') return view;
    } catch { /* ignore */ }
    return 'messages';
  });
  const [friendName, setFriendName] = useState('');
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [groupDialog, setGroupDialog] = useState(null);
  const closeGroupDialog = useCallback(() => setGroupDialog(null), []);
  const friendInputRef = useRef(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const draftStoreRef = useRef(new Map());
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discoverFilter, setDiscoverFilter] = useState('all');
  const [discoverAttributeFilters, setDiscoverAttributeFilters] = useState([]);
  const [notice, setNotice] = useState('');
  const [dmContextMenu, setDmContextMenu] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [showAddServer, setShowAddServer] = useState(false);
  const [serverName, setServerName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [servers, setServers] = useState(() => peekCachedServers()?.servers || []);
  const [isLoadingServers, setIsLoadingServers] = useState(() => !peekCachedServers()?.servers?.length);
  const serverUnreadRevisionsRef = useRef(new Map());
  const serverRefreshRef = useRef(null);
  const { open, setDirectory } = useUserPopout();
  const { call, startCall, accept, hangup } = useDmCall();
  const reportError = useCallback((error) => setNotice(error.message), []);
  const applyRailUnread = useCallback((payload) => {
    if (payload?.serverId == null) return;
    const serverId = Number(payload.serverId);
    serverUnreadRevisionsRef.current.set(serverId, (serverUnreadRevisionsRef.current.get(serverId) || 0) + 1);
    patchCachedServerUnreadSummary(payload);
    setServers((current) => patchServerUnreadSummary(current, payload));
  }, []);
  const {
    friends, requests, sent, peopleRevision, conversations, messages, selectedId, selectedConversation, isLoading, loadPeople,
    isLoadingMessages, messagesError, retryMessages,
    setSelectedId, startConversation, createGroup, changeGroup, muteConversation, requestFriendship, acceptFriendship, declineFriendship, cancelFriendship, unfriendConversation, blockConversation, pinConversation, submitMessage: submitDmMessage, editMessage, removeMessage, updateTyping,
    hasMoreMessages, isLoadingOlder, loadOlder, connectionState, typingUsers, retryMessage, discardFailedMessage,
  } = useDmData(account, reportError, applyRailUnread);
  const composerRef = useRef(null);
  const isSending = false; // Uploads belong to pending messages, not the composer.
  const peerPresence = usePresence(selectedConversation?.user?.id, selectedConversation?.user?.presence || 'offline');
  const selectConversation = useCallback(id => { setSelectedId(id); setActiveView('messages'); setSearchOpen(false); }, [setSelectedId]);
  const showChats = useCallback(() => { setSelectedId(null); setShowAddFriend(false); setActiveView('messages'); }, [setSelectedId]);
  const showNewChat = useCallback(() => { setSelectedId(null); setActiveView('requests'); setShowAddFriend(true); }, [setSelectedId]);
  useEffect(() => {
    if (activeView === 'requests' && showAddFriend) friendInputRef.current?.focus();
  }, [activeView, showAddFriend]);
  useEffect(() => {
    const openFriendRequest = (username) => {
      setSelectedId(null);
      setFriendName(String(username || '').trim());
      setShowAddFriend(true);
      setActiveView('requests');
    };
    const onOpenFriendRequest = (event) => openFriendRequest(event.detail?.username);
    window.addEventListener('glean-open-friend-request', onOpenFriendRequest);
    try {
      const username = sessionStorage.getItem('glean.friendRequestUsername');
      if (username) {
        sessionStorage.removeItem('glean.friendRequestUsername');
        openFriendRequest(username);
      }
    } catch { /* ignore */ }
    return () => window.removeEventListener('glean-open-friend-request', onOpenFriendRequest);
  }, [setSelectedId]);
  const mentionUsers = useMemo(
    () => [account, ...(selectedConversation?.kind === 'group' ? selectedConversation.members : [selectedConversation?.user]), ...friends].filter(Boolean),
    [account, selectedConversation, friends],
  );
  useEffect(() => {
    setDirectory(mentionUsers);
  }, [mentionUsers, setDirectory]);
  useEffect(() => () => setDirectory([]), [setDirectory]);
  useEffect(() => {
    setSearchOpen(false);
    setReplyTo(null);
    setEditingMessageId(null);
    setEditDraft('');
  }, [selectedId]);
  useEffect(() => {
    if (!dmContextMenu) return undefined;
    const closeOnOutsidePress = (event) => {
      if (!event.target.closest('.dm-context-menu')) setDmContextMenu(null);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setDmContextMenu(null);
    };
    const closeOnViewportChange = event => {
      if (event.type === 'scroll' && event.target instanceof Node && !event.target.contains(dmContextMenu.anchor)) return;
      setDmContextMenu(null);
    };
    const firstItem = document.querySelector('.dm-context-menu button');
    firstItem?.focus();
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
  }, [dmContextMenu]);
  useEffect(() => {
    const fromUrl = Number(new URLSearchParams(window.location.search).get('c'));
    const stored = Number(sessionStorage.getItem('glean.openConversationId'));
    try { sessionStorage.removeItem('glean.openConversationId'); } catch { /* ignore */ }
    const wanted = fromUrl || stored;
    if (Number.isInteger(wanted) && wanted > 0) setSelectedId(wanted);
  }, [setSelectedId]);
  useEffect(() => {
    const onOpen = (event) => {
      const wanted = Number(event.detail?.conversationId);
      if (Number.isInteger(wanted) && wanted > 0) setSelectedId(wanted);
    };
    window.addEventListener('glean-open-target', onOpen);
    return () => window.removeEventListener('glean-open-target', onOpen);
  }, [setSelectedId]);
  useEffect(() => {
    setPushFocus(selectedId ? { kind: 'dm', id: selectedId } : null);
    return () => setPushFocus(null);
  }, [selectedId]);

  const closeAddServer = useCallback(() => {
    setShowAddServer(false);
    setDialogError('');
  }, []);

  const openCreatedServer = (server) => {
    try { sessionStorage.setItem('glean.activeServerId', String(server.id)); } catch { /* ignore */ }
    closeAddServer();
    goTo('servers');
  };

  const joinDiscoveredServer = async (serverId) => {
    const { server } = await joinPublicServer(serverId);
    openCreatedServer(server);
  };

  const inspectVisible = inspectServersVisible(account);
  useEffect(() => {
    let cancelled = false;
    let busy = false;
    let pendingRefresh = false;
    const cached = peekCachedServers();
    if (!cached?.servers?.length) setIsLoadingServers(true);
    const refresh = async (showError = false) => {
      if (cancelled) return;
      if (busy) {
        pendingRefresh = true;
        return;
      }
      busy = true;
      const revisionsAtStart = new Map(serverUnreadRevisionsRef.current);
      try {
        const { servers: items } = await getServers({ force: true });
        if (!cancelled) setServers((current) => {
          const currentById = new Map(current.map((server) => [Number(server.id), server]));
          return items.map((server) => {
            const id = Number(server.id);
            const previous = currentById.get(id);
            if (!previous || (serverUnreadRevisionsRef.current.get(id) || 0) <= (revisionsAtStart.get(id) || 0)) return server;
            return { ...server, unread: previous.unread, unreadCount: previous.unreadCount, mentionCount: previous.mentionCount };
          });
        });
      } catch (error) {
        if (!cancelled && showError) setNotice(error.message);
      } finally {
        busy = false;
        if (!cancelled) setIsLoadingServers(false);
        if (pendingRefresh && !cancelled) {
          pendingRefresh = false;
          Promise.resolve().then(() => refresh());
        }
      }
    };
    serverRefreshRef.current = refresh;
    refresh(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (serverRefreshRef.current === refresh) serverRefreshRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [inspectVisible]);

  useEffect(() => {
    if (!account?.id) return undefined;
    const connection = subscribeToDmEvents((eventName) => {
      if (eventName === 'server-membership' || eventName === 'server-updated' || eventName === 'notification-settings') serverRefreshRef.current?.();
    }, () => {}, account.id);
    return () => connection.close();
  }, [account?.id]);

  const persistServerOrder = useCallback((nextMembers) => {
    const previous = servers;
    setServers([...nextMembers, ...previous.filter((item) => item.inspecting)]);
    reorderServers(nextMembers.map((item) => Number(item.id))).catch(() => setServers(previous));
  }, [servers]);

  const inviteFromServerRail = useCallback(async (server) => {
    if (!server?.id) return;
    try {
      const { invite } = await createServerInvite(server.id);
      const link = inviteUrl(invite?.code);
      if (link && navigator.clipboard?.writeText) await navigator.clipboard.writeText(link).catch(() => {});
      setNotice('Invite link copied.');
    } catch (error) { setNotice(error.message); }
  }, []);

  const leaveFromServerRail = useCallback(async (server) => {
    if (!server?.id || !window.confirm(`Leave ${server.name}?`)) return;
    try {
      await leaveServer(server.id);
      setServers((current) => current.filter((item) => Number(item.id) !== Number(server.id)));
      setNotice(`You left ${server.name}.`);
    } catch (error) { setNotice(error.message); }
  }, []);
  const muteFromServerRail = useCallback(async (server, muted) => {
    try {
      await setServerMuted(server.id, muted);
      setServers(current => current.map(item => Number(item.id) === Number(server.id) ? { ...item, muted, unread: false, unreadCount: 0, mentionCount: 0 } : item));
      setNotice(`${server.name} ${muted ? 'muted' : 'unmuted'}.`);
    } catch (error) { setNotice(error.message); }
  }, []);

  const submitServer = async (event) => {
    event.preventDefault();
    const cleanName = serverName.trim();
    if (!cleanName) return;
    try {
      const { server } = await createServer(cleanName);
      setServerName('');
      openCreatedServer(server);
    } catch (error) { setDialogError(error.message); }
  };

  const submitInviteJoin = async (event) => {
    event.preventDefault();
    const cleanCode = parseInviteInput(inviteCode) || inviteCode.trim();
    if (!cleanCode) return;
    try {
      const { server } = await joinServerByInvite(cleanCode);
      setInviteCode('');
      openCreatedServer(server);
    } catch (error) { setDialogError(error.message); }
  };

  useEffect(() => {
    const pending = peekPendingInvite();
    if (!pending) return undefined;
    let cancelled = false;
    joinServerByInvite(pending)
      .then(({ server }) => {
        if (cancelled) return;
        takePendingInvite();
        openCreatedServer(server);
      })
      .catch((error) => {
        if (cancelled) return;
        takePendingInvite();
        setInviteCode(pending);
        setShowAddServer(true);
        setDialogError(error.message);
      });
    return () => { cancelled = true; };
  }, []);

  const beginConversation = useCallback(async (username) => {
    setNotice('');
    try {
      const conversation = await startConversation(username);
      setSelectedId(conversation.id);
      setActiveView('messages');
      window.requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) { setNotice(error.message); }
  }, [startConversation, setSelectedId]);

  useEffect(() => {
    const storedName = sessionStorage.getItem('glean.openUsername');
    try { sessionStorage.removeItem('glean.openUsername'); } catch { /* ignore */ }
    if (storedName) beginConversation(storedName);
    const onOpen = (event) => {
      const conversationId = Number(event.detail?.conversationId);
      if (Number.isInteger(conversationId) && conversationId > 0) {
        setSelectedId(conversationId);
        setActiveView('messages');
        return;
      }
      if (event.detail?.username) beginConversation(event.detail.username);
    };
    window.addEventListener('glean-open-dm', onOpen);
    return () => window.removeEventListener('glean-open-dm', onOpen);
  }, [beginConversation, setSelectedId]);

  const submitFriendRequest = async (event) => {
    event.preventDefault();
    const username = friendName.trim();
    if (!username) return;
    setNotice('');
    try {
      const result = await requestFriendship(username);
      setFriendName('');
      setShowAddFriend(false);
      if (result?.isBot) {
        setActiveView('messages');
        setNotice('Nura accepted your request. You can start chatting now.');
      } else setNotice(`Friend request sent to ${username}.`);
    } catch (error) { setNotice(error.message); }
  };

  const acceptRequest = async (id) => {
    setNotice('');
    try {
      await acceptFriendship(id);
      setActiveView('messages');
    } catch (error) { setNotice(error.message); }
  };

  const addPerson = async (username) => {
    setNotice('');
    setSelectedId(null);
    setFriendName(username);
    setShowAddFriend(true);
    setActiveView('requests');
  };

  const cancelRequest = async (id) => {
    setNotice('');
    try {
      await cancelFriendship(id);
    } catch (error) { setNotice(error.message); }
  };

  const declineRequest = async (id) => {
    setNotice('');
    try {
      await declineFriendship(id);
    } catch (error) { setNotice(error.message); }
  };

  const discover = useDiscoverPeople({ enabled: activeView === 'discover', query: discoverQuery, filter: discoverFilter, attributeFilters: discoverAttributeFilters, revision: peopleRevision, accountId: account?.id });
  const discoverCounts = discover.counts;
  const openDiscover = () => setActiveView('discover');
  const openAnalytics = () => setActiveView('analytics');
  const toggleDiscoverAttributeFilter = useCallback((filterId) => {
    setDiscoverAttributeFilters((current) => current.includes(filterId)
      ? current.filter((item) => item !== filterId)
      : [...current, filterId]);
  }, []);
  useEffect(() => {
    if (activeView === 'discover') loadPeople();
  }, [activeView, loadPeople]);
  const homeBadge = useMemo(
    () => conversations.reduce((total, conversation) => total + (conversation.muted ? 0 : Number(conversation.unreadCount || 0)), 0) + requests.length,
    [conversations, requests.length],
  );
  const serverUnreadBadge = useMemo(
    () => servers.reduce((total, server) => server.inspecting ? total : total + Number(server.unreadCount || server.mentionCount || (server.unread ? 1 : 0)), 0),
    [servers],
  );
  useEffect(() => { setAppBadge(homeBadge + serverUnreadBadge); }, [homeBadge, serverUnreadBadge]);

  const submitMessage = async (event, extra) => {
    event.preventDefault();
    const files = extra?.attachments || [];
    const draft = extra?.draft || '';
    if (!selectedConversation || selectedConversation.blocked || (!draft.trim() && !files.length) || isSending) return;
    // Each pending message owns its upload and retry state independently.
    setNotice('');
    const pending = submitDmMessage(draft, files, replyTo?.id || null);
    extra?.setDraft('');
    extra?.setAttachments([]);
    setReplyTo(null);
    void pending.catch(error => setNotice(error.message));
  };

  const beginReply = (message) => {
    if (!Number.isFinite(Number(message.id)) || selectedConversation?.blocked) return;
    setReplyTo(message);
    setEditingMessageId(null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const beginEdit = (message) => {
    if (message.encrypted || Number(message.sender?.id) !== Number(account.id)) return;
    setEditingMessageId(Number(message.id));
    setEditDraft(message.body || '');
    setReplyTo(null);
  };

  const cancelEdit = () => {
    setEditingMessageId(null);
    setEditDraft('');
  };

  const submitEdit = async (event, message) => {
    event.preventDefault();
    if (!editDraft.trim() && !message.attachments?.length) return;
    await editMessage(message.id, editDraft);
    setEditingMessageId(current => Number(current) === Number(message.id) ? null : current);
  };

  const deleteOwnMessage = async (message) => {
    if (Number(message.sender?.id) !== Number(account.id) || !window.confirm('Delete this message?')) return;
    try {
      await removeMessage(message.id);
    } catch (error) { setNotice(error.message); }
  };

  const openDmContextMenu = (event, conversation) => {
    event.preventDefault();
    const menuWidth = 220;
    const menuHeight = 220;
    setDmContextMenu({
      conversation,
      anchor: event.currentTarget,
      x: Math.min(event.type === 'click' ? event.currentTarget.getBoundingClientRect().right : event.clientX, Math.max(8, window.innerWidth - menuWidth - 8)),
      y: Math.min(event.type === 'click' ? event.currentTarget.getBoundingClientRect().bottom : event.clientY, Math.max(8, window.innerHeight - menuHeight - 8)),
    });
  };

  const runDmContextAction = async (action) => {
    const conversation = dmContextMenu?.conversation;
    if (!conversation) return;
    setDmContextMenu(null);
    const target = conversation.name || conversation.user?.username || 'this user';
    if (action === 'group') { setGroupDialog(conversation.id); return; }
    if (action === 'leave') {
      if (!window.confirm(`Leave ${target}? You will lose access to its messages.`)) return;
      try { await changeGroup(conversation.id, 'leave'); } catch (error) { setNotice(error.message); }
      return;
    }
    if (action === 'profile') { open(conversation.user, dmContextMenu.anchor); return; }
    if (action === 'unfriend' && !window.confirm(`Remove ${target} as a friend?`)) return;
    if (action === 'block' && !window.confirm(`Block ${target}?`)) return;
    try {
      if (action === 'pin') {
        const nextPinned = !conversation.pinned;
        await pinConversation(conversation.id, nextPinned);
        setNotice(nextPinned ? `${target} pinned.` : `${target} unpinned.`);
      } else if (action === 'mute') {
        await muteConversation(conversation.id, !conversation.muted);
        setNotice(`${target} ${conversation.muted ? 'unmuted' : 'muted'}.`);
      } else if (action === 'unfriend') {
        await unfriendConversation(target);
        setNotice(`${target} removed from friends.`);
      } else if (action === 'block') {
        await blockConversation(target);
        setNotice(`${target} blocked.`);
      }
    } catch (error) {
      setNotice(error.message);
    }
  };

  const renderSidebarContent = () => {
    if (activeView === 'requests') return <div className="dm-list-content">
      <div className="dm-section-title">Incoming <span>{requests.length}</span></div>
      {requests.length ? requests.map((request) => (
        <div className="dm-request-row" key={`in-${request.id}`}>
          <div><Avatar user={request.user} /><strong><DisplayName user={request.user} /></strong></div>
          <div className="dm-request-actions">
            <button className="dm-small-action" type="button" onClick={() => acceptRequest(request.id)}>Accept</button>
            <button className="dm-small-action is-quiet" type="button" onClick={() => declineRequest(request.id)}>Decline</button>
          </div>
        </div>
      )) : <p className="dm-empty-copy">No incoming requests.</p>}
      <div className="dm-section-title">Sent <span>{sent.length}</span></div>
      {sent.length ? sent.map((request) => (
        <div className="dm-request-row" key={`out-${request.id}`}>
          <div><Avatar user={request.user} /><span><strong><DisplayName user={request.user} /></strong><small>Pending</small></span></div>
          <button className="dm-small-action is-quiet" type="button" onClick={() => cancelRequest(request.id)}>Cancel</button>
        </div>
      )) : <p className="dm-empty-copy">No sent requests yet.</p>}
    </div>;
    if (activeView === 'discover') return <div className="dm-list-content">
      <div className="dm-section-title">Browse</div>
      {DISCOVER_FILTERS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`dm-discover-nav${discoverFilter === item.id ? ' is-selected' : ''}`}
          onClick={() => setDiscoverFilter(item.id)}
        >
          <span>{item.label}</span>
          <b>{discoverCounts[item.id]}</b>
        </button>
      ))}
    </div>;
    if (activeView === 'analytics') return <div className="dm-list-content">
      <p className="dm-empty-copy">Community trends and member profile details.</p>
    </div>;
    return <DmInbox conversations={conversations} friends={friends} selectedId={selectedId} onSelect={selectConversation} onMenu={openDmContextMenu} onStart={beginConversation} isLoading={isLoading} onNewConversation={showNewChat} />;
  };

  return <main className="dm-app dm-workspace" aria-label="Glean direct messages">
    <AppRail
        account={account}
        homeActive
        discoverActive={activeView === 'discover'}
        homeBadge={homeBadge}
        servers={servers}
        isLoading={isLoadingServers}
        onHome={() => setActiveView('messages')}
        onDiscover={openDiscover}
        onOpenServer={(server) => {
          try { sessionStorage.setItem('glean.activeServerId', String(server.id)); } catch { /* ignore */ }
          goTo('servers');
        }}
        onAddServer={() => { setDialogError(''); setShowAddServer(true); }}
        onReorder={persistServerOrder}
        onInviteServer={inviteFromServerRail}
        onLeaveServer={leaveFromServerRail}
        onMuteServer={muteFromServerRail}
      />

    {dmContextMenu ? (
      <div
        className="dm-context-menu"
        role="menu"
        style={{ left: dmContextMenu.x, top: dmContextMenu.y }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
          const index = items.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        {dmContextMenu.conversation.kind === 'group' ? <button type="button" role="menuitem" onClick={() => runDmContextAction('group')}>Group details</button> : <button type="button" role="menuitem" onClick={() => runDmContextAction('profile')}>View profile</button>}
        <button type="button" role="menuitem" onClick={() => runDmContextAction('pin')}>{dmContextMenu.conversation.pinned ? 'Unpin DM' : 'Pin DM'}</button>
        <button type="button" role="menuitem" onClick={() => runDmContextAction('mute')}>{dmContextMenu.conversation.muted ? 'Unmute notifications' : 'Mute notifications'}</button>
        {dmContextMenu.conversation.kind === 'group' ? <button type="button" role="menuitem" className="is-danger" onClick={() => runDmContextAction('leave')}>Leave group</button> : <><button type="button" role="menuitem" onClick={() => runDmContextAction('unfriend')}>Unfriend</button><button type="button" role="menuitem" className="is-danger" onClick={() => runDmContextAction('block')}>Block</button></>}
      </div>
    ) : null}

    <aside className="dm-sidebar" aria-label="Direct message navigation">
      <div className="dm-sidebar-heading"><div><h1>Messages</h1></div><button className="dm-group-create" type="button" onClick={() => setGroupDialog('create')} aria-label="Create a group DM" title="Create a group DM"><GroupAvatar /></button><button type="button" onClick={showNewChat} aria-label="Add a friend" title="Add a friend" aria-controls="dm-add-friend" aria-expanded={activeView === 'requests' && showAddFriend}><PlusIcon /></button></div>
      <nav className="dm-tabs" aria-label="Messages views">
        <button type="button" aria-pressed={activeView === 'messages'} className={activeView === 'messages' ? 'is-active' : ''} onClick={showChats}>Chats</button>
        <button type="button" aria-pressed={activeView === 'requests'} aria-label={`Requests${requests.length ? ` (${requests.length} pending)` : ''}`} className={activeView === 'requests' ? 'is-active' : ''} onClick={() => { setSelectedId(null); setShowAddFriend(true); setActiveView('requests'); }}>Requests{requests.length ? <b aria-hidden="true">{requests.length > 99 ? '99+' : requests.length}</b> : null}</button>
        <button type="button" aria-pressed={activeView === 'discover'} className={`dm-discover-tab${activeView === 'discover' ? ' is-active' : ''}`} onClick={openDiscover} aria-label="Discover people" title="Discover people"><CompassIcon /></button>
        <button type="button" aria-pressed={activeView === 'analytics'} className={`dm-discover-tab${activeView === 'analytics' ? ' is-active' : ''}`} onClick={openAnalytics} aria-label="Community analytics" title="Community analytics"><ChartIcon /></button>
      </nav>
      {activeView === 'discover' ? (
        <div className="dm-search is-discover-head">
          <CompassIcon />
          <strong>Discover</strong>
        </div>
      ) : activeView === 'analytics' ? (
        <div className="dm-search is-discover-head">
          <ChartIcon />
          <strong>Analytics</strong>
        </div>
      ) : (
        activeView === 'requests' ? <form className="dm-search dm-add-friend" id="dm-add-friend" onSubmit={submitFriendRequest}>
          <input ref={friendInputRef} value={friendName} onChange={event => setFriendName(event.target.value)} placeholder="Add a friend by username" aria-label="Friend username" maxLength={USERNAME_INPUT_MAX_LENGTH} required />
          <button type="submit" disabled={!friendName.trim()}>Add</button>
        </form> : null
      )}
      {renderSidebarContent()}
      {connectionState !== 'connected' ? <div className={`dm-connection-state is-${connectionState}`} role="status"><i />{connectionState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</div> : null}
      <div data-voice-dock-host />
      <AccountChrome account={account} onAccountUpdated={onAccountUpdated} onSignedOut={onSignedOut} goTo={goTo} />
    </aside>

    <section className={`dm-main-panel${selectedConversation && (call.status === 'outgoing' || call.status === 'active') && Number(call.conversationId) === Number(selectedConversation.id) ? ' is-voice-chat' : ''}`}>
      {notice ? <div className="dm-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss notice"><CloseIcon /></button></div> : null}
      {activeView === 'discover' ? (
        <DiscoverPanel
          people={discover.people}
          total={discover.total}
          counts={discover.counts}
          attributeCounts={discover.attributeCounts}
          hasMorePeople={discover.hasMore}
          isLoadingMorePeople={discover.isLoadingMore}
          peopleError={discover.error}
          onLoadMorePeople={discover.loadMore}
          onRetryPeople={discover.retry}
          query={discoverQuery}
          onQuery={setDiscoverQuery}
          filter={discoverFilter}
          onFilter={setDiscoverFilter}
          attributeFilters={discoverAttributeFilters}
          onAttributeFilterToggle={toggleDiscoverAttributeFilter}
          isLoading={discover.isLoading}
          onAdd={addPerson}
          onAccept={acceptRequest}
          onDecline={declineRequest}
          onCancel={cancelRequest}
          onMessage={beginConversation}
          onJoinPublic={joinDiscoveredServer}
          onBack={() => setActiveView('messages')}
        />
      ) : activeView === 'analytics' ? (
        <AnalyticsPanel onBack={() => setActiveView('messages')} />
      ) : selectedConversation && (call.status === 'outgoing' || call.status === 'active') && Number(call.conversationId) === Number(selectedConversation.id) ? (
        <DmCallSlot conversationId={selectedConversation.id} onBack={() => setSelectedId(null)} />
      ) : selectedConversation ? <>
        <header className="dm-chat-header">
          <button className="glean-nav-back dm-back-button" type="button" onClick={() => setSelectedId(null)} aria-label="Back to chats"><ChevronLeftIcon /><span>Chats</span></button>
          {selectedConversation.kind === 'group' ? <button type="button" className="dm-contact-trigger dm-group-contact" onClick={() => setGroupDialog(selectedConversation.id)} aria-label="Group details"><GroupAvatar /><span className="dm-chat-header-copy"><strong>{selectedConversation.name}</strong><small className="dm-secure-label">{typingUsers.length ? typingStatusText(typingUsers) : `${selectedConversation.members.length} members · End-to-end encrypted`}</small></span></button> : <PresenceWrap as="button" type="button" className="dm-contact-trigger" user={selectedConversation.user} onClick={(event) => open(selectedConversation.user, event.currentTarget)} title={`View ${selectedConversation.user.username}'s profile`}>
            <Avatar user={selectedConversation.user} interactive={false} presence/>
            <span className="dm-chat-header-copy">
              <strong><DisplayName user={selectedConversation.user} /></strong>
              <small className="dm-secure-label">{selectedConversation.blocked ? 'Blocked' : selectedConversation.user.isBot ? 'AI chat · Groq · Not end-to-end encrypted' : typingUsers.length ? typingStatusText(typingUsers) : presenceLabel(peerPresence)}</small>
            </span>
          </PresenceWrap>}
          {selectedConversation.blocked || selectedConversation.kind === 'group' ? null : (
            <button
              className={`dm-call-button${call.status !== 'idle' && Number(call.conversationId) === Number(selectedConversation.id) ? ' is-live' : ''}`}
              type="button"
              onClick={() => {
                if (call.status === 'incoming' && Number(call.conversationId) === Number(selectedConversation.id)) accept();
                else if (call.status !== 'idle' && Number(call.conversationId) === Number(selectedConversation.id)) hangup();
                else startCall(selectedConversation);
              }}
              aria-label={call.status !== 'idle' && Number(call.conversationId) === Number(selectedConversation.id) ? 'Leave call' : `Call ${selectedConversation.user.username}`}
              title={call.status !== 'idle' && Number(call.conversationId) === Number(selectedConversation.id) ? 'Leave call' : 'Start a call'}
            >
              {call.status !== 'idle' && Number(call.conversationId) === Number(selectedConversation.id) ? <PhoneOffIcon /> : <PhoneIcon />}
            </button>
          )}
          <button className="dm-header-action" type="button" onClick={() => setSearchOpen(value => !value)} aria-label="Search conversation" aria-pressed={searchOpen} title="Search conversation"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg></button>
          <button className="dm-header-action" type="button" onClick={event => openDmContextMenu(event, selectedConversation)} aria-label="Conversation options" aria-haspopup="menu"><MoreIcon /></button>
        </header>
        <DmTranscript
          key={selectedConversation.id}
          conversation={selectedConversation} account={account} messages={messages}
          isLoading={isLoadingMessages} error={messagesError} onRetryHistory={retryMessages}
          hasMore={hasMoreMessages} isLoadingOlder={isLoadingOlder} onLoadOlder={loadOlder}
          searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} mentionUsers={mentionUsers}
          openProfile={open} onReply={beginReply} onEdit={beginEdit} onDelete={deleteOwnMessage}
          editingMessageId={editingMessageId} editDraft={editDraft} onEditDraft={setEditDraft} onSubmitEdit={submitEdit} onCancelEdit={cancelEdit}
          onRetry={id => retryMessage(id).catch(reportError)} onDiscard={discardFailedMessage}
        />
        <div className="dm-compose-dock">
          {selectedConversation.blocked ? <p className="dm-blocked-notice">You cannot send messages to this person.</p> : null}
        <IsolatedMessageComposer
          key={selectedConversation.id}
          resetKey={selectedConversation.id}
          draftStore={draftStoreRef.current}
          draftKey={`${account.id}:${selectedConversation.id}`}
          typingText={typingStatusText(typingUsers)}
          onSend={submitMessage}
          onTyping={updateTyping}
          placeholder={selectedConversation.blocked ? "You can't message this person." : `Message ${selectedConversation.user.username}`}
          disabled={Boolean(selectedConversation.blocked)}
          isSending={isSending}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) updateTyping(false); }}
          composerRef={composerRef}
          accessibility={account?.accessibility}
          mentionUsers={mentionUsers}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
        />
        </div>
      </> : <div className="dm-welcome"><Avatar user={account} username={username} avatarUrl={account?.avatarUrl} large/><h1>Your messages</h1><p>Your conversations and friends, together in Chats.</p><div className="dm-welcome-stats"><span><strong>{conversations.length}</strong> conversations</span><span><strong>{friends.length}</strong> friends</span></div><button className="glean-btn" type="button" onClick={showNewChat}><PlusIcon /> Add a friend</button></div>}
    </section>
    {groupDialog && (groupDialog === 'create' || conversations.some(item => Number(item.id) === Number(groupDialog))) ? <GroupDmDialog
      key={groupDialog} conversation={groupDialog === 'create' ? null : conversations.find(item => Number(item.id) === Number(groupDialog))}
      account={account} friends={friends} onCreate={async (name, memberIds) => { await createGroup(name, memberIds); setActiveView('messages'); }}
      onChange={changeGroup} onClose={closeGroupDialog} onProfile={open}
    /> : null}
    {showAddServer ? (
      <AddServerDialog
        serverName={serverName}
        inviteCode={inviteCode}
        onServerNameChange={setServerName}
        onInviteCodeChange={setInviteCode}
        onCreate={submitServer}
        onJoin={submitInviteJoin}
        onClose={closeAddServer}
        error={dialogError}
      />
    ) : null}
  </main>;
}
