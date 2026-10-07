import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createServer, createServerInvite, getServers, inspectServersVisible, joinPublicServer, joinServerByInvite, leaveServer, patchCachedServerUnreadSummary, patchServerUnreadSummary, peekCachedServers, reorderServers, subscribeToDmEvents } from '../app/dmApi';
import { inviteUrl, parseInviteInput, peekPendingInvite, takePendingInvite } from '../app/invite';
import { formatUnreadCount, setAppBadge } from '../app/pwa';
import AddServerDialog from '../features/community/AddServerDialog';
import AppRail from '../features/community/AppRail';
import AccountChrome from '../features/dm/AccountChrome';
import { Avatar, MessageAttachment, PresenceWrap } from '../features/dm/DmPrimitives';
import { formatDateDivider, formatMessageTime, isGroupedMessage, shouldShowDivider } from '../features/dm/formatters';
import { MessageBody } from '../features/dm/MessageBody';
import MessageComposer from '../features/dm/MessageComposer';
import { messageMentionsUser } from '../features/dm/mentions';
import { useChatAutoscroll } from '../features/dm/useChatAutoscroll';
import { useDmData } from '../features/dm/useDmData';
import { useUserPopout } from '../features/dm/userPopout';
import { setPushFocus } from '../app/desktopPush';
import { USERNAME_INPUT_MAX_LENGTH } from '../app/username';
import DiscoverPanel, { DISCOVER_FILTERS, countDiscoverPeople } from '../features/dm/DiscoverPanel';
import AnalyticsPanel from '../features/dm/AnalyticsPanel';
import { CompassIcon, ChartIcon, ChevronLeftIcon, PhoneIcon, PhoneOffIcon } from '../features/dm/icons';
import DisplayName from '../features/dm/DisplayName';
import CustomBadges from '../features/dm/CustomBadges';
import { MessageHoverActions, ReplyQuote } from '../features/dm/MessageActions';
import { DmCallSlot, useDmCall } from '../features/dm/DmCall';

export default function DirectMessagesScreen({ account, goTo, onAccountUpdated, onSignedOut }) {
  const username = account?.username || 'you';
  const [activeView, setActiveView] = useState(() => {
    try {
      const view = sessionStorage.getItem('glean.dmView');
      sessionStorage.removeItem('glean.dmView');
      if (view === 'discover' || view === 'analytics' || view === 'requests' || view === 'friends') return view;
    } catch { /* ignore */ }
    return 'messages';
  });
  const [friendName, setFriendName] = useState('');
  const [dmSearch, setDmSearch] = useState('');
  const [friendsSearch, setFriendsSearch] = useState('');
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discoverFilter, setDiscoverFilter] = useState('all');
  const [discoverAttributeFilters, setDiscoverAttributeFilters] = useState([]);
  const [isFriendInputActive, setIsFriendInputActive] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [notice, setNotice] = useState('');
  const [dmContextMenu, setDmContextMenu] = useState(null);
  const [isSending, setIsSending] = useState(false);
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
    friends, requests, sent, people, conversations, messages, selectedId, selectedConversation, isLoading, isLoadingPeople, loadPeople,
    isLoadingMessages, messagesError, retryMessages,
    setSelectedId, startConversation, requestFriendship, acceptFriendship, declineFriendship, cancelFriendship, unfriendConversation, blockConversation, pinConversation, submitMessage: submitDmMessage, editMessage, removeMessage, updateTyping,
    hasMoreMessages, isLoadingOlder, loadOlder, connectionState,
  } = useDmData(account, reportError, applyRailUnread);
  const composerRef = useRef(null);
  const messageScrollRef = useRef(null);
  const mentionUsers = useMemo(
    () => [account, selectedConversation?.user, ...friends].filter(Boolean),
    [account, selectedConversation, friends],
  );
  const conversationByUserId = useMemo(() => {
    const next = new Map();
    conversations.forEach((conversation) => {
      const id = Number(conversation.user?.id);
      if (!Number.isFinite(id) || next.has(id)) return;
      next.set(id, { conversation });
    });
    return next;
  }, [conversations]);
  const friendsInView = useMemo(() => {
    const needle = friendsSearch.trim().toLowerCase();
    return [...friends]
      .filter((friend) => !needle || String(friend.username || '').toLowerCase().includes(needle))
      .sort((left, right) => {
    const leftConversation = conversationByUserId.get(Number(left.id))?.conversation;
    const rightConversation = conversationByUserId.get(Number(right.id))?.conversation;
    const leftTime = leftConversation?.lastMessageAt ? Date.parse(leftConversation.lastMessageAt) : 0;
    const rightTime = rightConversation?.lastMessageAt ? Date.parse(rightConversation.lastMessageAt) : 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return String(left.username || '').localeCompare(String(right.username || ''), undefined, { sensitivity: 'base' });
      });
  }, [friends, friendsSearch, conversationByUserId]);
  const visibleConversations = useMemo(() => {
    const needle = dmSearch.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((conversation) => (
      String(conversation.user?.username || '').toLowerCase().includes(needle)
      || String(conversation.lastMessage || '').toLowerCase().includes(needle)
    ));
  }, [conversations, dmSearch]);
  const { atBottom, hasNewMessages, jumpToBottom } = useChatAutoscroll(
    messageScrollRef,
    isLoading ? null : selectedId,
    messages.at(-1)?.id ?? messages.length,
  );
  useEffect(() => { if (selectedConversation) updateTyping(Boolean(draft.trim())); }, [draft, selectedConversation, updateTyping]);
  useEffect(() => {
    setDirectory(mentionUsers);
  }, [mentionUsers, setDirectory]);
  useEffect(() => () => setDirectory([]), [setDirectory]);
  useEffect(() => {
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
    const closeOnViewportChange = () => setDmContextMenu(null);
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
    }, 10_000);
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
      if (eventName === 'server-membership' || eventName === 'server-updated') serverRefreshRef.current?.();
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
      await requestFriendship(username);
      setFriendName('');
      setNotice(`Friend request sent to ${username}.`);
    } catch (error) { setNotice(error.message); }
  };

  const acceptRequest = async (id) => {
    setNotice('');
    try {
      await acceptFriendship(id);
      setActiveView('friends');
    } catch (error) { setNotice(error.message); }
  };

  const addPerson = async (username) => {
    setNotice('');
    try {
      await requestFriendship(username);
      setNotice(`Friend request sent to ${username}.`);
    } catch (error) { setNotice(error.message); }
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

  const discoverCounts = useMemo(() => countDiscoverPeople(people), [people]);
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
    () => conversations.reduce((total, conversation) => total + Number(conversation.unreadCount || 0), 0) + requests.length,
    [conversations, requests.length],
  );
  const serverUnreadBadge = useMemo(
    () => servers.reduce((total, server) => server.inspecting ? total : total + Number(server.unreadCount || server.mentionCount || (server.unread ? 1 : 0)), 0),
    [servers],
  );
  useEffect(() => { setAppBadge(homeBadge + serverUnreadBadge); }, [homeBadge, serverUnreadBadge]);

  const submitMessage = async (event, extra) => {
    event.preventDefault();
    const files = extra?.attachments ?? attachments;
    if (!selectedConversation || selectedConversation.blocked || (!draft.trim() && !files.length) || isSending) return;
    setIsSending(true);
    setNotice('');
    try {
      await submitDmMessage(draft, files, replyTo?.id || null);
      setDraft('');
      setAttachments([]);
      setReplyTo(null);
    } catch (error) { setNotice(error.message); } finally { setIsSending(false); }
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
    try {
      await editMessage(message.id, editDraft);
      cancelEdit();
    } catch (error) { setNotice(error.message); }
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
    const menuHeight = 158;
    setDmContextMenu({
      conversation,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8)),
    });
  };

  const runDmContextAction = async (action) => {
    const conversation = dmContextMenu?.conversation;
    if (!conversation) return;
    setDmContextMenu(null);
    const target = conversation.user?.username || 'this user';
    if (action === 'unfriend' && !window.confirm(`Remove ${target} as a friend?`)) return;
    if (action === 'block' && !window.confirm(`Block ${target}?`)) return;
    try {
      if (action === 'pin') {
        const nextPinned = !conversation.pinned;
        await pinConversation(conversation.id, nextPinned);
        setNotice(nextPinned ? `${target} pinned.` : `${target} unpinned.`);
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
    if (activeView === 'friends') return <div className="dm-list-content">
      <div className="dm-section-title">Friends <span>{friends.length}</span></div>
      <input
        className="dm-list-search"
        type="search"
        value={friendsSearch}
        onChange={(event) => setFriendsSearch(event.target.value)}
        placeholder="Search friends"
        aria-label="Search friends"
        autoComplete="off"
      />
      {friendsInView.length ? friendsInView.map((friend) => {
        const thread = conversationByUserId.get(Number(friend.id))?.conversation;
        return (
        <PresenceWrap className="dm-person-row" user={friend} key={friend.id}>
          <Avatar user={friend} presence />
          <button className="dm-person-row-open" type="button" onClick={() => beginConversation(friend.username)}>
            <span><strong><DisplayName user={friend} /></strong><small>{thread?.lastMessage || 'No messages yet'}</small></span>
          </button>
        </PresenceWrap>
        );
      }) : <p className="dm-empty-copy">Accepted friends appear here.</p>}
    </div>;
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
    return <div className="dm-list-content">
      <div className="dm-section-title">Messages <span>{dmSearch.trim() ? `${visibleConversations.length}/${conversations.length}` : conversations.length}</span></div>
      <input
        className="dm-list-search"
        type="search"
        value={dmSearch}
        onChange={(event) => setDmSearch(event.target.value)}
        placeholder="Search DMs"
        aria-label="Search direct messages"
        autoComplete="off"
      />
      {conversations.length ? visibleConversations.length ? visibleConversations.map((conversation) => (
        <PresenceWrap className={`dm-person-row${conversation.id === selectedId ? ' is-selected' : ''}${conversation.unreadCount ? ' is-unread' : ''}`} user={conversation.user} key={conversation.id} onContextMenu={(event) => openDmContextMenu(event, conversation)}>
          <Avatar user={conversation.user} presence />
          <button className="dm-person-row-open" type="button" onClick={() => { setSelectedId(conversation.id); setActiveView('messages'); }}>
            <span><strong><DisplayName user={conversation.user} /></strong><small>{conversation.lastMessage || 'No messages yet'}</small></span>
          </button>
          {conversation.pinned ? <span className="dm-pinned-mark" title="Pinned DM" aria-label="Pinned DM">📌</span> : null}
          {conversation.unreadCount ? <b className="dm-unread-count">{formatUnreadCount(conversation.unreadCount)}</b> : null}
        </PresenceWrap>
      )) : <p className="dm-empty-copy">No DMs match that search.</p> : <p className="dm-empty-copy">Start a conversation with an accepted friend.</p>}
    </div>;
  };

  return <main className="dm-app" aria-label="Glean direct messages">
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
      />

    {dmContextMenu ? (
      <div
        className="dm-context-menu"
        role="menu"
        style={{ left: dmContextMenu.x, top: dmContextMenu.y }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button type="button" role="menuitem" onClick={() => runDmContextAction('pin')}>{dmContextMenu.conversation.pinned ? 'Unpin DM' : 'Pin DM'}</button>
        <button type="button" role="menuitem" onClick={() => runDmContextAction('unfriend')}>Unfriend</button>
        <button type="button" role="menuitem" className="is-danger" onClick={() => runDmContextAction('block')}>Block</button>
      </div>
    ) : null}

    <aside className="dm-sidebar">
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
        <form className={`dm-search${isFriendInputActive ? ' is-focused' : ''}`} onSubmit={submitFriendRequest} onFocus={() => setIsFriendInputActive(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setIsFriendInputActive(false); }}>
          <input value={friendName} onChange={(event) => setFriendName(event.target.value)} placeholder="Friend username" aria-label="Friend username" maxLength={USERNAME_INPUT_MAX_LENGTH} />
          {isFriendInputActive ? <button type="submit">Add</button> : null}
        </form>
      )}
      <div className="dm-tabs">
        <button type="button" className={activeView === 'friends' ? 'is-active' : ''} onClick={() => setActiveView('friends')}>Friends</button>
        <button type="button" className={activeView === 'requests' ? 'is-active' : ''} onClick={() => setActiveView('requests')}>Requests{requests.length ? <b>{requests.length}</b> : null}</button>
        <button type="button" className={`dm-discover-tab${activeView === 'discover' ? ' is-active' : ''}`} onClick={openDiscover} aria-label="Discover people" title="Discover people"><CompassIcon /></button>
        <button type="button" className={`dm-discover-tab${activeView === 'analytics' ? ' is-active' : ''}`} onClick={openAnalytics} aria-label="Community analytics" title="Community analytics"><ChartIcon /></button>
      </div>
      {isLoading && activeView !== 'discover' && activeView !== 'analytics' ? <p className="dm-empty-copy">Loading your messages…</p> : renderSidebarContent()}
      <div data-voice-dock-host />
      <AccountChrome account={account} onAccountUpdated={onAccountUpdated} onSignedOut={onSignedOut} />
    </aside>

    <section className={`dm-main-panel${selectedConversation && (call.status === 'outgoing' || call.status === 'active') && Number(call.conversationId) === Number(selectedConversation.id) ? ' is-voice-chat' : ''}`}>
      {notice ? <div className="dm-notice" role="status">{notice}</div> : null}
      {activeView === 'discover' ? (
        <DiscoverPanel
          people={people}
          query={discoverQuery}
          onQuery={setDiscoverQuery}
          filter={discoverFilter}
          onFilter={setDiscoverFilter}
          attributeFilters={discoverAttributeFilters}
          onAttributeFilterToggle={toggleDiscoverAttributeFilter}
          isLoading={isLoadingPeople}
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
          <PresenceWrap as="button" type="button" className="dm-contact-trigger" user={selectedConversation.user} onClick={(event) => open(selectedConversation.user, event.currentTarget)} title={`View ${selectedConversation.user.username}'s profile`}>
            <Avatar user={selectedConversation.user} interactive={false} presence/>
            <span className="dm-chat-header-copy">
              <strong><DisplayName user={selectedConversation.user} /></strong>
              <small className="dm-secure-label">Messages are readable across devices</small>
            </span>
          </PresenceWrap>
          {selectedConversation.blocked ? null : (
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
        </header>
        {hasNewMessages ? (
          <button className="dm-new-messages-banner" type="button" onClick={jumpToBottom}>
            <span aria-hidden="true">—</span> New messages
          </button>
        ) : null}
        <div className="dm-message-scroll" ref={messageScrollRef}>
          {isLoadingMessages ? <div className="community-chat-loading"><span className="community-spinner" />Loading messages…</div> : null}
          {!isLoadingMessages && messagesError ? <div className="dm-history-error" role="alert"><p>{messagesError}</p><button type="button" onClick={retryMessages}>Try again</button></div> : null}
          {!isLoadingMessages && !messagesError ? <>
          {hasMoreMessages ? <button className="dm-load-older" type="button" onClick={loadOlder} disabled={isLoadingOlder}>{isLoadingOlder ? 'Loading…' : 'Load older messages'}</button> : <div className="dm-history-start"><Avatar user={selectedConversation.user} large/><h1><DisplayName user={selectedConversation.user} /></h1><p>This is the beginning of your message history with <strong><DisplayName user={selectedConversation.user} /></strong>.</p></div>}
          {messages.map((message, index) => {
            const grouped = isGroupedMessage(messages[index - 1], message);
            const sender = Number(message.sender.id) === Number(account.id)
              ? { ...message.sender, ...account }
              : Number(message.sender.id) === Number(selectedConversation.user.id)
                ? { ...message.sender, ...selectedConversation.user }
                : message.sender;
            const isAuthor = Number(message.sender.id) === Number(account.id);
            const persisted = Number.isFinite(Number(message.id));
            const isEditing = persisted && Number(editingMessageId) === Number(message.id);
            return (
          <div key={message.id}>
            {shouldShowDivider(messages[index - 1], message) ? <div className="dm-date-divider"><span>{formatDateDivider(message.createdAt)}</span></div> : null}
            <article className={`dm-message${message.status === 'failed' ? ' is-failed' : ''}${grouped ? ' is-grouped' : ''}${messageMentionsUser(message.body, account.username) ? ' is-mentioned' : ''}`} id={persisted ? `m-${message.id}` : undefined}>
              {grouped ? <span className="dm-avatar-spacer" /> : <Avatar user={sender} />}
              <div className="dm-message-body">
                {grouped ? null : (
                  <div className="dm-message-meta">
                    <div className="dm-message-author-line">
                      <button type="button" className="dm-message-author" onClick={(event) => open(sender, event.currentTarget)}><DisplayName user={sender} /></button>
                      <CustomBadges badges={sender.customBadges} inline />
                    </div>
                    <time>{formatMessageTime(message.createdAt)}</time>
                    {message.editedAt ? <small className="community-edited-label">edited</small> : null}
                  </div>
                )}
                <MessageHoverActions
                  canReply={persisted && !selectedConversation.blocked}
                  canEdit={persisted && isAuthor && !message.encrypted}
                  canDelete={persisted && isAuthor}
                  onReply={() => beginReply(message)}
                  onEdit={() => beginEdit(message)}
                  onDelete={() => deleteOwnMessage(message)}
                />
                {isEditing ? (
                  <form className="community-edit-form" onSubmit={(event) => submitEdit(event, message)}>
                    <textarea value={editDraft} onChange={(event) => setEditDraft(event.target.value)} maxLength="4000" autoFocus aria-label="Edit message" />
                    <div><button type="submit" disabled={!editDraft.trim() && !message.attachments?.length}>Save</button><button type="button" onClick={cancelEdit}>Cancel</button></div>
                  </form>
                ) : (
                  <>
                    <ReplyQuote reply={message.replyTo} />
                    {message.body ? <MessageBody className="dm-message-text" body={message.body} users={mentionUsers} currentUsername={account.username} /> : null}
                    {grouped && message.editedAt ? <small className="community-edited-label">edited</small> : null}
                    {message.attachments?.length ? <div className="dm-message-attachments">{message.attachments.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} message={message} accountId={account.id} />)}</div> : null}
                    {message.status ? <small className="dm-message-status">{message.status === 'sending' ? 'Encrypting & sending…' : message.status === 'failed' ? 'Failed to send' : ''}</small> : null}
                  </>
                )}
              </div>
            </article>
          </div>
            );
          })}
          <div data-chat-end aria-hidden="true" />
          </> : null}
        </div>
        {!atBottom ? (
          <button className="dm-jump-latest" type="button" onClick={jumpToBottom} aria-label="Jump to latest messages" title="Jump to latest messages">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        ) : null}
        <MessageComposer
          key={selectedConversation.id}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submitMessage}
          placeholder={selectedConversation.blocked ? "You can't message this person." : `Message ${selectedConversation.user.username}`}
          disabled={Boolean(selectedConversation.blocked)}
          isSending={isSending}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) updateTyping(false); }}
          composerRef={composerRef}
          accessibility={account?.accessibility}
          mentionUsers={mentionUsers}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
        />
      </> : <div className="dm-welcome"><Avatar user={account} username={username} avatarUrl={account?.avatarUrl} large/><h1>Your messages</h1><p>Select a conversation or open Friends to start a private direct message.</p></div>}
    </section>
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
