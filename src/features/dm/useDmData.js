import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acceptFriendRequest,
  blockUser,
  cancelFriendRequest,
  declineFriendRequest,
  editDirectMessage,
  getConversations,
  getFriends,
  getMessages,
  markConversationRead,
  openDirectConversation,
  registerE2EEKey,
  removeDirectMessage,
  sendEncryptedMessage,
  sendMessage,
  sendFriendRequest,
  setConversationPinned,
  sendTyping,
  subscribeToDmEvents,
  unfriendUser,
} from '../../app/dmApi';
import { decryptMessage, ensureE2EEIdentity, prepareEncryptedMessage } from '../../app/e2ee';
import { peekCachedDmSidebar, rememberDmSidebar } from '../../app/storage';
import { createLiveMessageJournal } from '../../app/liveMessages';
import { preserveReadableMessages, recentHistorySnapshot, reconcileSentMessage } from './conversationState';

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
  const [peopleRevision, setPeopleRevision] = useState(0);
  const [conversations, setConversations] = useState(() => cachedSidebar?.conversations || []);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [transcriptId, setTranscriptId] = useState(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [messagesError, setMessagesError] = useState('');
  const [messageHistoryRetry, setMessageHistoryRetry] = useState(0);
  const [isLoading, setIsLoading] = useState(() => !cachedSidebar);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [typingByConversation, setTypingByConversation] = useState({});
  const [connectionState, setConnectionState] = useState('connecting');
  const [identity, setIdentity] = useState(null);
  const [identityReady, setIdentityReady] = useState(false);
  const realtimeRef = useRef(null);
  const selectedIdRef = useRef(selectedId);
  const accountIdRef = useRef(account?.id);
  const onUnreadRef = useRef(onUnread);
  const peopleLoadedRef = useRef(false);
  const unreadRevisionsRef = useRef(new Map());
  const sidebarRefreshRef = useRef(null);
  const sidebarRefreshQueuedRef = useRef(false);
  const liveMessageJournalRef = useRef(null);
  const transcriptCacheRef = useRef(new Map());
  const pendingSendsRef = useRef(new Map());
  const sendLocksRef = useRef(new Set());
  const liveEventVersionsRef = useRef(new Map());
  const olderLockRef = useRef(null);
  const previewCacheRef = useRef(new Map());
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
    () => conversations.find((conversation) => Number(conversation.id) === Number(selectedId)) || null,
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
          const message = conversation.lastEncryptedMessage;
          const previewKey = `${conversation.id}:${message.id}:${previewIdentity?.fingerprint || ''}:${message.crypto?.ciphertext || ''}`;
          const cachedPreview = previewCacheRef.current.get(previewKey);
          if (cachedPreview !== undefined) return { ...conversation, lastMessage: cachedPreview };
          const decrypted = await decryptMessage(previewIdentity, conversation.lastEncryptedMessage, conversation.id);
          const preview = conversationPreview(decrypted);
          if (decrypted.decryptionFailed === false) {
            previewCacheRef.current.set(previewKey, preview);
            while (previewCacheRef.current.size > 256) previewCacheRef.current.delete(previewCacheRef.current.keys().next().value);
          }
          return { ...conversation, lastMessage: preview };
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
    setPeopleRevision(current => current + 1);
  }, []);

  const loadPeople = useCallback(async () => {
    peopleLoadedRef.current = true;
  }, []);

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
      .catch((error) => { if (!cancelled) reportError(error); })
      .finally(() => { if (!cancelled) setIdentityReady(true); });
    return () => { cancelled = true; };
  }, [account?.id, refreshSidebar, reportError]);

  // The first sidebar request may finish before the account key is restored.
  // Retry encrypted previews after React has committed the ready identity/ref.
  useEffect(() => {
    if (!identity?.privateKey || Number(identity.accountId) !== Number(account?.id)) return;
    refreshSidebar().catch(reportError);
  }, [account?.id, identity, refreshSidebar, reportError]);

  useEffect(() => {
    const synced = event => {
      if (Number(event.detail?.accountId) !== Number(account?.id)) return;
      ensureE2EEIdentity(account.id, account.username).then(next => {
        transcriptCacheRef.current.clear();
        previewCacheRef.current.clear();
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
      setTranscriptId(null);
      setMessages([]);
      setIsLoadingMessages(false);
      setMessagesError('');
      setHasMoreMessages(false);
      return undefined;
    }
    if (!identityReady) { setIsLoadingMessages(true); return undefined; }
    let cancelled = false;
    const controller = new AbortController();
    const cached = transcriptCacheRef.current.get(Number(selectedId));
    setTranscriptId(selectedId);
    setMessages(cached?.messages || []);
    setHasMoreMessages(Boolean(cached?.hasMore));
    setIsLoadingMessages(!cached);
    setMessagesError('');
    setIsLoadingOlder(false);
    const messageScope = `dm:${Number(selectedId)}`;
    const snapshotRevision = liveMessageJournalRef.current.revision();
    getMessages(selectedId, { limit: 50, signal: controller.signal }).then(async ({ messages: nextMessages, page }) => {
      const decrypted = await Promise.all(nextMessages.map((message) => decryptMessage(identity, message, selectedId)));
      if (!cancelled && Number(selectedIdRef.current) === Number(selectedId)) {
        setMessages((current) => liveMessageJournalRef.current.mergeSnapshot(
          messageScope,
          current,
          recentHistorySnapshot(current, preserveReadableMessages(decrypted, current), Boolean(page?.hasMore)),
          snapshotRevision,
          { isPending: (message) => !(Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0) },
        ));
        setHasMoreMessages(cached ? cached.hasMore : Boolean(page?.hasMore));
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
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [selectedId, identity, identityReady, markConversationReadAndApply, messageHistoryRetry]);

  useEffect(() => {
    if (!selectedId || Number(transcriptId) !== Number(selectedId) || isLoadingMessages || messagesError) return;
    const cache = transcriptCacheRef.current;
    cache.delete(Number(selectedId));
    cache.set(Number(selectedId), { messages, hasMore: hasMoreMessages });
    while (cache.size > 8) cache.delete(cache.keys().next().value);
  }, [selectedId, transcriptId, messages, hasMoreMessages, isLoadingMessages, messagesError]);

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
          const { messages: latest, page } = await getMessages(conversationId, { limit: 50 });
          const decrypted = await Promise.all(latest.map((message) => decryptMessage(identityRef.current, message, conversationId)));
          if (Number(selectedIdRef.current) === conversationId) {
            setMessages((current) => liveMessageJournalRef.current.mergeSnapshot(
              `dm:${conversationId}`,
              current,
              recentHistorySnapshot(current, preserveReadableMessages(decrypted, current), Boolean(page?.hasMore)),
              snapshotRevision,
              {
                isPending: (message) => !(Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0),
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
        const eventKey = `${conversationId}:${payload.message.id}`;
        const eventVersion = Symbol();
        liveEventVersionsRef.current.set(eventKey, eventVersion);
        while (liveEventVersionsRef.current.size > 1024) liveEventVersionsRef.current.delete(liveEventVersionsRef.current.keys().next().value);
        if (action === 'deleted') {
          liveMessageJournalRef.current.record(`dm:${conversationId}`, action, null, payload.message.id);
          transcriptCacheRef.current.delete(conversationId);
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
        const decrypted = await decryptMessage(identityRef.current, payload.message, conversationId);
        if (liveEventVersionsRef.current.get(eventKey) !== eventVersion) return;
        liveMessageJournalRef.current.record(`dm:${conversationId}`, action, decrypted);
        if (mine && decrypted.clientMessageId) {
          for (const job of pendingSendsRef.current.values()) {
            if (job.conversationId === conversationId && job.encrypted?.envelope.clientMessageId === decrypted.clientMessageId) job.confirmed = decrypted;
          }
        }
        if (action !== 'edited') {
          const patch = { lastMessage: conversationPreview(decrypted), lastMessageAt: decrypted.createdAt };
          recordConversationUpdate(conversationId, patch);
          setConversations(current => current.map(item => Number(item.id) === conversationId ? { ...item, ...patch } : item));
        }
        const cached = transcriptCacheRef.current.get(conversationId);
        if (cached) transcriptCacheRef.current.set(conversationId, { ...cached, messages: reconcileSentMessage(cached.messages, null, decrypted) });
        if (selected) {
          setMessages((current) => {
            if (Number(selectedIdRef.current) !== conversationId) return current;
            const duplicateIndex = current.findIndex((item) =>
              (decrypted.clientMessageId && item.clientMessageId === decrypted.clientMessageId)
              || Number(item.id) === Number(decrypted.id),
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
    const result = await sendFriendRequest(username);
    await refreshSidebar();
    if (peopleLoadedRef.current) await refreshPeople();
    if (result.accepted && result.conversationId) {
      setSelectedId(Number(result.conversationId));
      return { ...result, isBot: true };
    }
    return result;
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
    const clientMessageId = crypto.randomUUID();
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
    const job = { conversationId: Number(selectedConversation.id), body, attachments, replyToMessageId, optimistic, encrypted: null };
    pendingSendsRef.current.set(optimistic.id, job);
    setMessages((current) => [...current, optimistic]);
    return deliverMessage(job);
  }, [account, messages, selectedConversation]);

  const deliverMessage = async (job) => {
    const { conversationId, optimistic, body, attachments, replyToMessageId } = job;
    if (sendLocksRef.current.has(optimistic.id)) return null;
    sendLocksRef.current.add(optimistic.id);
    const patchStatus = (status) => {
      if (Number(selectedIdRef.current) === conversationId) setMessages(current => current.map(message => message.id === optimistic.id ? { ...message, status } : message));
      const cached = transcriptCacheRef.current.get(conversationId);
      if (cached) transcriptCacheRef.current.set(conversationId, { ...cached, messages: cached.messages.map(message => message.id === optimistic.id ? { ...message, status } : message) });
    };
    patchStatus('sending');
    try {
      const latest = (await getConversations()).conversations.find(item => Number(item.id) === conversationId);
      if (!latest || latest.blocked) throw new Error('This conversation is unavailable.');
      if (latest.user.isBot) {
        const response = await sendMessage(conversationId, body, attachments, replyToMessageId);
        const message = response.message;
        if (!message || !Number.isSafeInteger(Number(message.id))) throw new Error('Nura did not confirm the message. Please retry.');
        liveMessageJournalRef.current.record(`dm:${conversationId}`, 'created', message);
        if (Number(selectedIdRef.current) === conversationId) setMessages(current => reconcileSentMessage(current, optimistic.id, message));
        const cached = transcriptCacheRef.current.get(conversationId);
        if (cached) transcriptCacheRef.current.set(conversationId, { ...cached, messages: reconcileSentMessage(cached.messages, optimistic.id, message) });
        pendingSendsRef.current.delete(optimistic.id);
        setConversations(current => current.map(conversation => Number(conversation.id) === conversationId
          ? { ...conversation, lastMessage: body || 'Image', lastMessageAt: message.createdAt, unreadCount: 0 }
          : conversation));
        return message;
      }
      const activeIdentity = await ensureE2EEIdentity(account.id, account.username);
      if (!job.encrypted) {
        job.encrypted = await prepareEncryptedMessage(activeIdentity, latest, body, attachments);
        optimistic.clientMessageId = job.encrypted.envelope.clientMessageId;
        if (Number(selectedIdRef.current) === conversationId) setMessages(current => current.map(message => message.id === optimistic.id ? { ...message, clientMessageId: optimistic.clientMessageId } : message));
      }
      const response = await sendEncryptedMessage(conversationId, { ...job.encrypted, replyToMessageId });
      const message = response.message
        ? await decryptMessage(activeIdentity, response.message, conversationId)
        : { ...optimistic, id: response.messageId };
      if (!Number.isSafeInteger(Number(message.id))) throw new Error('The message was not confirmed. Please retry.');
      liveMessageJournalRef.current.record(`dm:${conversationId}`, 'created', message);
      if (Number(selectedIdRef.current) === conversationId) setMessages(current => reconcileSentMessage(current, optimistic.id, message));
      const cached = transcriptCacheRef.current.get(conversationId);
      if (cached) transcriptCacheRef.current.set(conversationId, { ...cached, messages: reconcileSentMessage(cached.messages, optimistic.id, message) });
      pendingSendsRef.current.delete(optimistic.id);
      setConversations((current) => current.map((conversation) => Number(conversation.id) === conversationId
        ? { ...conversation, lastMessage: body || 'Attachment', lastMessageAt: message.createdAt, unreadCount: 0 }
        : conversation));
      return message;
    } catch (error) {
      if (job.confirmed) {
        pendingSendsRef.current.delete(optimistic.id);
        return job.confirmed;
      }
      patchStatus('failed');
      throw error;
    } finally {
      sendLocksRef.current.delete(optimistic.id);
    }
  };

  const retryMessage = (messageId) => {
    const job = pendingSendsRef.current.get(messageId);
    if (!job) return Promise.reject(new Error('This send can no longer be retried. Copy the message and send it again.'));
    return deliverMessage(job);
  };

  const discardFailedMessage = (messageId) => {
    if (sendLocksRef.current.has(messageId)) return;
    pendingSendsRef.current.delete(messageId);
    setMessages(current => current.filter(message => message.id !== messageId));
  };

  const editMessage = useCallback(async (messageId, body) => {
    if (!selectedConversation) return null;
    const { message } = await editDirectMessage(selectedConversation.id, messageId, body);
    if (Number(selectedIdRef.current) === Number(selectedConversation.id)) setMessages((current) => current.map((item) => Number(item.id) === Number(message.id) ? { ...item, ...message, status: 'sent' } : item));
    transcriptCacheRef.current.delete(Number(selectedConversation.id));
    refreshSidebar().catch(() => {});
    return message;
  }, [refreshSidebar, selectedConversation]);

  const removeMessage = useCallback(async (messageId) => {
    if (!selectedConversation) return;
    await removeDirectMessage(selectedConversation.id, messageId);
    liveMessageJournalRef.current.record(`dm:${Number(selectedConversation.id)}`, 'deleted', null, messageId);
    transcriptCacheRef.current.delete(Number(selectedConversation.id));
    if (Number(selectedIdRef.current) === Number(selectedConversation.id)) setMessages((current) => current.filter((item) => Number(item.id) !== Number(messageId)));
    refreshSidebar().catch(() => {});
  }, [refreshSidebar, selectedConversation]);

  const loadOlder = useCallback(async () => {
    if (!selectedId || !hasMoreMessages || isLoadingOlder || olderLockRef.current === selectedId) return;
    const firstServerMessage = messages.find((message) => Number.isInteger(message.id));
    if (!firstServerMessage) return;
    setIsLoadingOlder(true);
    olderLockRef.current = selectedId;
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
      if (olderLockRef.current === requestedConversationId) olderLockRef.current = null;
      if (Number(selectedIdRef.current) === Number(requestedConversationId)) setIsLoadingOlder(false);
    }
  }, [hasMoreMessages, identity, isLoadingOlder, messages, reportError, selectedId]);

  const updateTyping = useCallback((typing) => {
    if (!selectedId) return;
    const realtime = realtimeRef.current;
    if (realtime?.send) realtime.send('typing', { conversationId: selectedId, typing });
    else sendTyping(selectedId, typing).catch(() => {});
  }, [selectedId]);

  return {
    friends, requests, sent, peopleRevision, conversations, messages: Number(transcriptId) === Number(selectedId) ? messages : [], selectedId, selectedConversation, isLoading, loadPeople,
    isLoadingMessages, messagesError, retryMessages: () => setMessageHistoryRetry((value) => value + 1),
    refreshSidebar, setSelectedId, startConversation, requestFriendship, acceptFriendship, declineFriendship, cancelFriendship, unfriendConversation, blockConversation, pinConversation, submitMessage, retryMessage, discardFailedMessage, editMessage, removeMessage, updateTyping,
    hasMoreMessages, isLoadingOlder, loadOlder, connectionState,
    typingUsers: selectedId ? Object.values(typingByConversation[selectedId] || {}).filter((item) => item.expiresAt > Date.now()).map((item) => item.name) : [],
    isRecipientTyping: Boolean(selectedId && Object.keys(typingByConversation[selectedId] || {}).length),
  };
}
