import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acceptFriendRequest,
  blockUser,
  cancelFriendRequest,
  declineFriendRequest,
  editDirectMessage,
  getConversations,
  getFriends,
  getPeople,
  getMessages,
  markConversationRead,
  openDirectConversation,
  registerE2EEKey,
  removeDirectMessage,
  sendEncryptedMessage,
  sendFriendRequest,
  setConversationPinned,
  sendTyping,
  subscribeToDmEvents,
  unfriendUser,
} from '../../app/dmApi';
import { decryptMessage, ensureE2EEIdentity, prepareEncryptedMessage } from '../../app/e2ee';
import { peekCachedDmSidebar, rememberDmSidebar } from '../../app/storage';
import { createLiveMessageJournal } from '../../app/liveMessages';

function conversationPreview(message) {
  if (!message) return 'No messages yet';
  if (message.encrypted && message.decryptionFailed !== false) return message.attachments?.length ? 'Attachment' : 'Message';
  return message.body || 'Attachment';
}

function rememberCachedConversationPatch(accountId, conversationId, patch) {
  const cached = peekCachedDmSidebar(accountId);
  if (!cached) return;
  const conversations = cached.conversations.map((conversation) => Number(conversation.id) === Number(conversationId)
    ? { ...conversation, ...patch }
    : conversation);
  rememberDmSidebar(accountId, { ...cached, conversations });
}

export function useDmData(account, reportError, onUnread = null) {
  const cachedSidebar = peekCachedDmSidebar(account?.id);
  const [friends, setFriends] = useState(() => cachedSidebar?.friends || []);
  const [requests, setRequests] = useState(() => cachedSidebar?.requests || []);
  const [sent, setSent] = useState(() => cachedSidebar?.sent || []);
  const [people, setPeople] = useState([]);
  const [conversations, setConversations] = useState(() => cachedSidebar?.conversations || []);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [messagesError, setMessagesError] = useState('');
  const [messageHistoryRetry, setMessageHistoryRetry] = useState(0);
  const [isLoading, setIsLoading] = useState(() => !cachedSidebar);
  const [isLoadingPeople, setIsLoadingPeople] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [typingByConversation, setTypingByConversation] = useState({});
  const [connectionState, setConnectionState] = useState('connecting');
  const [identity, setIdentity] = useState(null);
  const realtimeRef = useRef(null);
  const selectedIdRef = useRef(selectedId);
  const accountIdRef = useRef(account?.id);
  const onUnreadRef = useRef(onUnread);
  const peopleLoadedRef = useRef(false);
  const unreadRevisionsRef = useRef(new Map());
  const sidebarRefreshRef = useRef(null);
  const sidebarRefreshQueuedRef = useRef(false);
  const liveMessageJournalRef = useRef(null);
  if (!liveMessageJournalRef.current) liveMessageJournalRef.current = createLiveMessageJournal();
  selectedIdRef.current = selectedId;
  accountIdRef.current = account?.id;
  onUnreadRef.current = onUnread;

  const recordConversationUpdate = useCallback((conversationId, patch) => {
    const id = Number(conversationId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const previous = unreadRevisionsRef.current.get(id) || { revision: 0 };
    const next = { ...previous, ...patch, revision: previous.revision + 1 };
    unreadRevisionsRef.current.set(id, next);
    const { revision: _revision, ...cachedPatch } = next;
    rememberCachedConversationPatch(accountIdRef.current, id, cachedPatch);
    return next;
  }, []);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) || null,
    [conversations, selectedId],
  );

  const refreshSidebar = useCallback(() => {
    if (sidebarRefreshRef.current) {
      sidebarRefreshQueuedRef.current = true;
      return sidebarRefreshRef.current;
    }
    const refresh = async () => {
      let latestConversations = [];
      do {
        sidebarRefreshQueuedRef.current = false;
        const revisionsAtStart = new Map([...unreadRevisionsRef.current].map(([id, state]) => [id, state.revision]));
        const [{ friends: nextFriends, requests: nextRequests, sent: nextSent }, { conversations: nextConversations }] = await Promise.all([
          getFriends(),
          getConversations(),
        ]);
        setFriends(nextFriends);
        setRequests(nextRequests);
        setSent(nextSent || []);
        const previewIdentity = identityRef.current;
        const previews = await Promise.all(nextConversations.map(async conversation => {
          if (!conversation.lastEncryptedMessage) return conversation;
          const decrypted = await decryptMessage(previewIdentity, conversation.lastEncryptedMessage, conversation.id);
          return { ...conversation, lastMessage: conversationPreview(decrypted) };
        }));
        latestConversations = previews.map((conversation) => {
          const latest = unreadRevisionsRef.current.get(Number(conversation.id));
          if (!latest || latest.revision <= (revisionsAtStart.get(Number(conversation.id)) || 0)) return conversation;
          const { revision: _revision, ...state } = latest;
          return { ...conversation, ...state };
        });
        setConversations(latestConversations);
        setSelectedId((current) => current && nextConversations.some((conversation) => conversation.id === current) ? current : null);
        if (accountIdRef.current) rememberDmSidebar(accountIdRef.current, { friends: nextFriends, requests: nextRequests, sent: nextSent || [], conversations: latestConversations });
      } while (sidebarRefreshQueuedRef.current);
      return latestConversations;
    };
    const pending = refresh().finally(() => {
      if (sidebarRefreshRef.current === pending) sidebarRefreshRef.current = null;
      sidebarRefreshQueuedRef.current = false;
    });
    sidebarRefreshRef.current = pending;
    return pending;
  }, []);

  const markConversationReadAndApply = useCallback(async (conversationId, lastReadMessageId) => {
    const id = Number(conversationId);
    const revisionAtStart = unreadRevisionsRef.current.get(id)?.revision || 0;
    const result = await markConversationRead(id, lastReadMessageId);
    const latest = unreadRevisionsRef.current.get(id);
    if (!latest || latest.revision === revisionAtStart) {
      const next = recordConversationUpdate(id, { unreadCount: Number(result.unreadCount || 0) });
      setConversations((current) => current.map((item) => Number(item.id) === id ? { ...item, unreadCount: next.unreadCount } : item));
    }
    return result;
  }, [recordConversationUpdate]);

  const refreshPeople = useCallback(async () => {
    const directory = await getPeople().catch(() => ({ people: [] }));
    peopleLoadedRef.current = true;
    setPeople(directory.people || []);
    return directory.people || [];
  }, []);

  const loadPeople = useCallback(async () => {
    if (peopleLoadedRef.current) return;
    setIsLoadingPeople(true);
    try {
      await refreshPeople();
    } finally {
      setIsLoadingPeople(false);
    }
  }, [refreshPeople]);

  useEffect(() => {
    let cancelled = false;
    if (!account?.id) return undefined;
    if (!peekCachedDmSidebar(account.id)) setIsLoading(true);
    refreshSidebar()
      .catch((error) => { if (!cancelled) reportError(error); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    ensureE2EEIdentity(account.id, account.username)
      .then(async (nextIdentity) => {
        if (cancelled) return;
        // Reading saved messages must not depend on registering a sending key.
        setIdentity(nextIdentity);
        if (nextIdentity.serverKeyMismatch) return;
        const registration = await registerE2EEKey(nextIdentity.publicKey, nextIdentity.fingerprint);
        if (cancelled) return;
        if (registration.changed) reportError(new Error('This browser created a new encryption identity. Older encrypted messages may require your previous device.'));
      })
      .catch((error) => { if (!cancelled) reportError(error); });
    return () => { cancelled = true; };
  }, [account?.id, refreshSidebar, reportError]);

  useEffect(() => {
    const synced = event => {
      if (Number(event.detail?.accountId) !== Number(account?.id)) return;
      ensureE2EEIdentity(account.id, account.username).then(next => {
        setIdentity(next);
        setMessageHistoryRetry(value => value + 1);
        refreshSidebar().catch(reportError);
      }).catch(reportError);
    };
    window.addEventListener('glean-encryption-synced', synced);
    return () => window.removeEventListener('glean-encryption-synced', synced);
  }, [account?.id, account?.username, refreshSidebar, reportError]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setIsLoadingMessages(false);
      setMessagesError('');
      setHasMoreMessages(false);
      return undefined;
    }
    let cancelled = false;
    setMessages([]);
    setIsLoadingMessages(true);
    setMessagesError('');
    setIsLoadingOlder(false);
    setConversations((current) => current.map((item) => item.id === selectedId ? { ...item, unreadCount: 0 } : item));
    const messageScope = `dm:${Number(selectedId)}`;
    const snapshotRevision = liveMessageJournalRef.current.revision();
    getMessages(selectedId, { limit: 50 }).then(async ({ messages: nextMessages, page }) => {
      const decrypted = await Promise.all(nextMessages.map((message) => decryptMessage(identity, message, selectedId)));
      if (!cancelled && Number(selectedIdRef.current) === Number(selectedId)) {
        setMessages((current) => liveMessageJournalRef.current.mergeSnapshot(
          messageScope,
          current,
          decrypted,
          snapshotRevision,
          { isPending: (message) => !(Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0) },
        ));
        setHasMoreMessages(Boolean(page?.hasMore));
        markConversationReadAndApply(selectedId, decrypted[decrypted.length - 1]?.id).catch(() => {});
      }
    }).catch((error) => {
      if (!cancelled) setMessagesError(error.message || 'Could not load this conversation.');
    }).finally(() => { if (!cancelled) setIsLoadingMessages(false); });
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      markConversationReadAndApply(selectedId).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [selectedId, identity, markConversationReadAndApply, messageHistoryRetry]);

  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    if (!account?.id) return undefined;
    let busy = false;
    const syncVisibleState = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      const conversationId = Number(selectedIdRef.current);
      try { await refreshSidebar(); } catch { /* realtime/API reconnect handles the next refresh */ }
      if (conversationId && Number(selectedIdRef.current) === conversationId) {
        try {
          const snapshotRevision = liveMessageJournalRef.current.revision();
          const { messages: latest } = await getMessages(conversationId, { limit: 50 });
          const decrypted = await Promise.all(latest.map((message) => decryptMessage(identityRef.current, message, conversationId)));
          if (Number(selectedIdRef.current) === conversationId) {
            setMessages((current) => liveMessageJournalRef.current.mergeSnapshot(
              `dm:${conversationId}`,
              current,
              decrypted,
              snapshotRevision,
              {
                isPending: (message) => !(Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0),
                retainCurrent: true,
              },
            ));
          }
        } catch { /* keep the visible transcript; retry on the next sync */ }
      }
      busy = false;
    };
    const onVisible = () => { if (document.visibilityState === 'visible') syncVisibleState(); };
    // WebSocket message/unread events keep the view live; this is only a recovery
    // snapshot for missed events, so avoid reloading and decrypting the whole DM list
    // every few seconds.
    const timer = window.setInterval(syncVisibleState, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [account?.id, refreshSidebar]);

  useEffect(() => {
    let hasConnectedOnce = false;
    const connection = subscribeToDmEvents(async (eventName, payload) => {
      if (eventName === 'connected') {
        if (hasConnectedOnce) {
          refreshSidebar().catch(() => {});
          if (selectedIdRef.current) setMessageHistoryRetry((value) => value + 1);
        }
        hasConnectedOnce = true;
        return;
      }
      if (eventName === 'message' && payload.message) {
        const conversationId = Number(payload.conversationId);
        const selected = conversationId === Number(selectedIdRef.current);
        const action = payload.action || 'created';
        liveMessageJournalRef.current.record(
          `dm:${conversationId}`,
          action,
          action === 'deleted' ? null : payload.message,
          payload.message.id,
        );
        if (action === 'deleted') {
          if (selected) setMessages((current) => current.filter((item) => Number(item.id) !== Number(payload.message.id)));
          refreshSidebar().catch(() => {});
          return;
        }
        const mine = Number(payload.message.sender?.id) === Number(accountIdRef.current);
        const focused = selected && document.visibilityState === 'visible';
        if (action !== 'edited') {
          const conversationPatch = {
            lastMessage: conversationPreview(payload.message),
            lastMessageAt: payload.message.createdAt,
            unreadCount: focused || mine ? 0 : Number(payload.unreadCount || 0),
          };
          recordConversationUpdate(conversationId, conversationPatch);
          setConversations((current) => {
            if (!current.some((item) => Number(item.id) === conversationId)) {
              refreshSidebar().catch(() => {});
              return current;
            }
            return current.map((item) => Number(item.id) === conversationId ? { ...item, ...conversationPatch } : item);
          });
        }
        if (selected) {
          const decrypted = await decryptMessage(identityRef.current, payload.message, conversationId);
          setConversations(current => current.map(item => Number(item.id) === conversationId ? { ...item, lastMessage: conversationPreview(decrypted) } : item));
          setMessages((current) => {
            if (Number(selectedIdRef.current) !== conversationId) return current;
            const duplicateIndex = current.findIndex((item) =>
              (decrypted.clientMessageId && item.clientMessageId === decrypted.clientMessageId)
              || Number(item.id) === Number(decrypted.id)
              || (String(item.id).startsWith('pending-')
                && Number(item.sender?.id) === Number(decrypted.sender?.id)
                && item.body === decrypted.body),
            );
            if (duplicateIndex >= 0) {
              const copy = [...current];
              copy[duplicateIndex] = { ...decrypted, status: 'sent' };
              return copy;
            }
            if (action === 'edited') return current;
            return [...current, { ...decrypted, status: 'sent' }];
          });
        }
        if (action === 'edited') {
          refreshSidebar().catch(() => {});
          return;
        }
        if (focused && !mine) markConversationReadAndApply(conversationId, payload.message.id).catch(() => {});
      }
      if (eventName === 'unread' && payload.kind === 'dm') {
        const conversationId = Number(payload.conversationId);
        const unreadCount = Number(payload.unreadCount || 0);
        recordConversationUpdate(conversationId, { unreadCount });
        setConversations((current) => current.map((item) => Number(item.id) === conversationId ? { ...item, unreadCount } : item));
      }
      if (eventName === 'unread' || (eventName === 'channel-message' && payload.action === 'created')) {
        onUnreadRef.current?.(payload);
      }
      if (eventName === 'typing') {
        const conversationId = Number(payload.conversationId);
        const userKey = String(payload.userId || payload.username || 'peer');
        setTypingByConversation((current) => {
          const users = { ...(current[conversationId] || {}) };
          if (payload.typing === true) users[userKey] = { name: payload.username || 'Someone', expiresAt: Date.now() + 6000 };
          else delete users[userKey];
          return { ...current, [conversationId]: users };
        });
        if (payload.typing === true) window.setTimeout(() => {
          setTypingByConversation((current) => {
            const users = { ...(current[conversationId] || {}) };
            if (users[userKey]?.expiresAt > Date.now()) return current;
            delete users[userKey];
            return { ...current, [conversationId]: users };
          });
        }, 6100);
      }
      if (eventName === 'key-changed') {
        reportError(new Error('A contact changed their encryption identity. Verify their safety key before sharing sensitive information.'));
        refreshSidebar().catch(() => {});
        if (peopleLoadedRef.current) refreshPeople().catch(() => {});
      }
      if (eventName === 'friends' || eventName === 'conversations') {
        refreshSidebar().catch(() => {});
        if (peopleLoadedRef.current) refreshPeople().catch(() => {});
      }
    }, setConnectionState, account?.id);
    realtimeRef.current = connection;
    return () => {
      realtimeRef.current = null;
      connection.close();
    };
  }, [account?.id, markConversationReadAndApply, recordConversationUpdate, refreshPeople, refreshSidebar, reportError]);

  const startConversation = useCallback(async (username) => {
    const { conversation } = await openDirectConversation(username);
    await refreshSidebar();
    setSelectedId(conversation.id);
    return conversation;
  }, [refreshSidebar]);

  const requestFriendship = useCallback(async (username) => {
    await sendFriendRequest(username);
    await refreshSidebar();
    if (peopleLoadedRef.current) await refreshPeople();
  }, [refreshPeople, refreshSidebar]);

  const acceptFriendship = useCallback(async (requestId) => {
    await acceptFriendRequest(requestId);
    await refreshSidebar();
    if (peopleLoadedRef.current) await refreshPeople();
  }, [refreshPeople, refreshSidebar]);

  const cancelFriendship = useCallback(async (requestId) => {
    await cancelFriendRequest(requestId);
    await refreshSidebar();
    if (peopleLoadedRef.current) await refreshPeople();
  }, [refreshPeople, refreshSidebar]);

  const unfriendConversation = useCallback(async (username) => {
    await unfriendUser(username);
    await refreshSidebar();
    if (peopleLoadedRef.current) await refreshPeople();
  }, [refreshPeople, refreshSidebar]);

  const blockConversation = useCallback(async (username) => {
    await blockUser(username);
    await refreshSidebar();
    if (peopleLoadedRef.current) await refreshPeople();
  }, [refreshPeople, refreshSidebar]);

  const pinConversation = useCallback(async (conversationId, pinned) => {
    await setConversationPinned(conversationId, pinned);
    await refreshSidebar();
  }, [refreshSidebar]);

  const declineFriendship = useCallback(async (requestId) => {
    await declineFriendRequest(requestId);
    await refreshSidebar();
    if (peopleLoadedRef.current) await refreshPeople();
  }, [refreshPeople, refreshSidebar]);

  const submitMessage = useCallback(async (body, attachments, replyToMessageId = null) => {
    if (!selectedConversation || !account) return null;
    const clientMessageId = `plain-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const replyParent = replyToMessageId
      ? messages.find((item) => Number(item.id) === Number(replyToMessageId))
      : null;
    const optimistic = {
      id: `pending-${clientMessageId}`,
      clientMessageId,
      body: String(body || ''),
      createdAt: new Date().toISOString(),
      editedAt: null,
      replyTo: replyParent ? {
        id: Number(replyParent.id),
        username: replyParent.sender?.username || 'Unknown',
        deleted: false,
        body: String(replyParent.body || ''),
      } : null,
      sender: { id: Number(account.id), username: account.username, avatarUrl: account.avatarUrl || null, nameStyle: account.nameStyle || null, customBadges: account.customBadges || [] },
      attachments: [],
      encrypted: false,
      status: 'sending',
    };
    setMessages((current) => [...current, optimistic]);
    try {
      const activeIdentity = await ensureE2EEIdentity(account.id, account.username);
      const latest = (await getConversations()).conversations.find(item => Number(item.id) === Number(selectedConversation.id));
      if (!latest) throw new Error('Conversation not found.');
      const encrypted = await prepareEncryptedMessage(activeIdentity, latest, body, attachments);
      const response = await sendEncryptedMessage(selectedConversation.id, { ...encrypted, replyToMessageId });
      if (response.message) response.message = await decryptMessage(activeIdentity, response.message, selectedConversation.id);
      if (response.duplicate) {
        setMessages((current) => current.map((message) => message.clientMessageId === optimistic.clientMessageId ? { ...message, id: response.messageId, status: 'sent' } : message));
        return response;
      }
      setMessages((current) => [
        ...current.filter((message) => message.clientMessageId !== optimistic.clientMessageId && Number(message.id) !== Number(response.message.id)),
        { ...response.message, status: 'sent' },
      ]);
      setConversations((current) => current.map((conversation) => conversation.id === selectedConversation.id
        ? { ...conversation, lastMessage: body || 'Attachment', lastMessageAt: response.message.createdAt, unreadCount: 0 }
        : conversation));
      return response.message;
    } catch (error) {
      setMessages((current) => current.map((message) => message.clientMessageId === optimistic.clientMessageId ? { ...message, status: 'failed' } : message));
      throw error;
    }
  }, [account, messages, selectedConversation]);

  const editMessage = useCallback(async (messageId, body) => {
    if (!selectedConversation) return null;
    const { message } = await editDirectMessage(selectedConversation.id, messageId, body);
    setMessages((current) => current.map((item) => Number(item.id) === Number(message.id) ? { ...item, ...message, status: 'sent' } : item));
    refreshSidebar().catch(() => {});
    return message;
  }, [refreshSidebar, selectedConversation]);

  const removeMessage = useCallback(async (messageId) => {
    if (!selectedConversation) return;
    await removeDirectMessage(selectedConversation.id, messageId);
    setMessages((current) => current.filter((item) => Number(item.id) !== Number(messageId)));
    refreshSidebar().catch(() => {});
  }, [refreshSidebar, selectedConversation]);

  const loadOlder = useCallback(async () => {
    if (!selectedId || !hasMoreMessages || isLoadingOlder) return;
    const firstServerMessage = messages.find((message) => Number.isInteger(message.id));
    if (!firstServerMessage) return;
    setIsLoadingOlder(true);
    const requestedConversationId = selectedId;
    const messageScope = `dm:${Number(requestedConversationId)}`;
    const snapshotRevision = liveMessageJournalRef.current.revision();
    try {
      const { messages: older, page } = await getMessages(requestedConversationId, { before: firstServerMessage.id, limit: 50 });
      const decrypted = await Promise.all(older.map((message) => decryptMessage(identity, message, requestedConversationId)));
      if (Number(selectedIdRef.current) !== Number(requestedConversationId)) return;
      setMessages((current) => {
        return liveMessageJournalRef.current.mergeSnapshot(
          messageScope,
          current,
          [...decrypted, ...current],
          snapshotRevision,
          {
            isPending: (message) => !(Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0),
            retainCurrent: true,
          },
        );
      });
      setHasMoreMessages(Boolean(page?.hasMore));
    } catch (error) {
      if (Number(selectedIdRef.current) === Number(requestedConversationId)) reportError(error);
    } finally {
      if (Number(selectedIdRef.current) === Number(requestedConversationId)) setIsLoadingOlder(false);
    }
  }, [hasMoreMessages, identity, isLoadingOlder, messages, reportError, selectedId]);

  const updateTyping = useCallback((typing) => {
    if (!selectedConversation) return;
    const realtime = realtimeRef.current;
    if (realtime?.send) realtime.send('typing', { conversationId: selectedConversation.id, typing });
    else sendTyping(selectedConversation.id, typing).catch(() => {});
  }, [selectedConversation]);

  return {
    friends, requests, sent, people, conversations, messages, selectedId, selectedConversation, isLoading, isLoadingPeople, loadPeople,
    isLoadingMessages, messagesError, retryMessages: () => setMessageHistoryRetry((value) => value + 1),
    refreshSidebar, setSelectedId, startConversation, requestFriendship, acceptFriendship, declineFriendship, cancelFriendship, unfriendConversation, blockConversation, pinConversation, submitMessage, editMessage, removeMessage, updateTyping,
    hasMoreMessages, isLoadingOlder, loadOlder, connectionState,
    typingUsers: selectedId ? Object.values(typingByConversation[selectedId] || {}).filter((item) => item.expiresAt > Date.now()).map((item) => item.name) : [],
    isRecipientTyping: Boolean(selectedId && Object.keys(typingByConversation[selectedId] || {}).length),
  };
}
