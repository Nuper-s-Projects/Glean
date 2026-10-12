import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  assignMemberRole,
  createChannel,
  createServerInvite,
  createRole,
  createServer,
  deleteChannel,
  deleteServer,
  deleteRole,
  editChannelMessage,
  getChannelMessages,
  getServer,
  getServerMembers,
  getServers,
  joinServerByInvite,
  markChannelRead,
  moderateMember,
  banMemberDevice,
  leaveServer,
  peekCachedServers,
  patchCachedServerUnreadSummary,
  patchServerUnreadSummary,
  reactToChannelMessage,
  removeChannelMessage,
  reorderChannels,
  reorderRoles,
  reorderServers,
  sendChannelMessage,
  voteChannelPoll,
  closeChannelPoll,
  subscribeToDmEvents,
  timeoutMember,
  disconnectVoiceMember,
  updateRole,
  inspectServersVisible,
  setServerMuted,
} from '../app/dmApi';
import AddServerDialog from '../features/community/AddServerDialog';
import AppRail from '../features/community/AppRail';
import useHoldReorder from '../features/community/useHoldReorder';
import { CommunityAvatar, ServerIcon } from '../features/community/CommunityAvatar';
import ChannelTranscript from '../features/community/ChannelTranscript';
import CommunityMemberSidebar from '../features/community/CommunityMemberSidebar';
import ServerChannelHeader, { ChannelGlyph, formatSlowmode } from '../features/community/ServerChannelHeader';
import '../features/community/CommunityWorkspace.css';
import VoiceRoom, { microphoneError } from '../features/community/VoiceRoom';
import VoiceDock from '../features/community/VoiceDock';
import { VoiceOccupantRow, allVoiceOccupants, occupantsOf } from '../features/community/VoiceBits';
import ServerSettingsModal from '../features/community/ServerSettingsModal';
import ServerChannelCategories from '../features/community/ServerChannelCategories';
import AccountChrome from '../features/dm/AccountChrome';
import { IsolatedMessageComposer, normalizePoll, typingStatusText } from '../features/dm/MessageComposer';
import { EVERYONE_MENTION } from '../features/dm/mentions';
import { useChatAutoscroll } from '../features/dm/useChatAutoscroll';
import { useUserPopout } from '../features/dm/userPopout';
import { LeaveIcon, LockIcon, MoreIcon, SettingsIcon, SpeakerIcon, TrashIcon, UserIcon } from '../features/dm/icons';
import DisplayName from '../features/dm/DisplayName';
import { inviteUrl, parseInviteInput, peekPendingInvite, takePendingInvite } from '../app/invite';
import { setPushFocus } from '../app/desktopPush';
import { formatUnreadCount, setAppBadge } from '../app/pwa';
import { createLiveMessageJournal } from '../app/liveMessages';

function groupMembers(server) {
  const roles = server?.roles || [];
  const members = server?.members || [];
  const counts = server?.memberCounts || {};
  const grouped = roles.map((role) => ({ role, members: [], totalCount: Number(counts[String(role.id)] || 0) }));
  const byRole = new Map(grouped.map((group) => [Number(group.role.id), group]));
  const leftover = [];
  for (const member of members) {
    const group = byRole.get(Number(member.roleId));
    if (group) group.members.push(member);
    else leftover.push(member);
  }
  const visibleGroups = grouped
    .map((group) => ({ ...group, totalCount: group.totalCount || group.members.length }))
    .filter((group) => group.members.length || group.totalCount);
  if (leftover.length) visibleGroups.push({ role: { id: 'ungrouped', name: 'Members', color: 'var(--muted-text)' }, members: leftover, totalCount: leftover.length });
  return visibleGroups;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function sameMember(left, right) {
  return sameValue(left, right);
}

function reuseEquivalentItems(incoming, existing) {
  if (!Array.isArray(incoming) || !Array.isArray(existing)) return incoming;
  const oldById = new Map(existing.map((item) => [Number(item.id), item]));
  const next = incoming.map((item) => {
    const previous = oldById.get(Number(item.id));
    return sameMember(previous, item) ? previous : item;
  });
  return next.length === existing.length && next.every((item, index) => item === existing[index]) ? existing : next;
}

function mergeLoadedServerMembers(server, current) {
  if (!server || !current || Number(server.id) !== Number(current.id)) return server;
  const stableServer = {
    ...server,
    channels: reuseEquivalentItems(server.channels, current.channels),
    categories: reuseEquivalentItems(server.categories || [], current.categories || []),
    roles: reuseEquivalentItems(server.roles, current.roles),
    memberCounts: sameMember(current.memberCounts, server.memberCounts) ? current.memberCounts : server.memberCounts,
  };
  const incoming = server.members || [];
  const loaded = current.members || [];
  if (!loaded.length) return stableServer;
  const total = Number(server.memberTotal ?? incoming.length);
  const oldById = new Map(loaded.map((member) => [Number(member.id), member]));
  const incomingIds = new Set(incoming.map((member) => Number(member.id)));
  let members = incoming.map((member) => {
    const previous = oldById.get(Number(member.id));
    return sameMember(previous, member) ? previous : member;
  });
  if (loaded.length > incoming.length && loaded.length <= total) {
    members.push(...loaded.filter((member) => !incomingIds.has(Number(member.id))));
  }
  if (members.length > total) members = members.slice(0, total);
  if (members.length === loaded.length && members.every((member, index) => member === loaded[index])) members = loaded;
  return {
    ...stableServer,
    members,
    membersPage: {
      ...(server.membersPage || {}),
      nextOffset: members.length,
      hasMore: members.length < total,
    },
  };
}

const MEMBER_CHUNK_SIZE = 50;

function sortServerRoles(roles) {
  return [...roles].sort((left, right) => (
    Number(right.position || 0) - Number(left.position || 0)
    || Number(left.id) - Number(right.id)
  ));
}

function messageId(value) {
  return Number(value?.id ?? value);
}

function isPendingChannelMessage(item) {
  return item?.status === 'sending' || messageId(item) < 0;
}

function mutedServerStorageKey(id) { return `glean.mutedServer.${Number(id)}`; }
function isServerMuted(id) {
  try { return window.localStorage.getItem(mutedServerStorageKey(id)) === '1'; } catch { return false; }
}

function matchesPendingChannelMessage(pending, incoming) {
  if (!isPendingChannelMessage(pending) || !incoming) return false;
  if (Number(pending.author?.id) !== Number(incoming.author?.id)) return false;
  if (String(pending.body || '') !== String(incoming.body || '')) return false;
  if (String(pending.poll?.question || '') !== String(incoming.poll?.question || '')) return false;
  return Number(pending.replyTo?.id || 0) === Number(incoming.replyTo?.id || 0);
}

const CREATE_CHANNEL_TYPES = [
  { value: 'text', label: 'Text', icon: '#', description: 'Send messages, images, GIFs, emoji, and polls.' },
  { value: 'voice', label: 'Voice', icon: '◖', description: 'Hang out together with voice, video, and screen share.' },
  { value: 'announcement', label: 'Announcement', icon: '⚑', description: 'Share important updates with the server.' },
  { value: 'rules', label: 'Rules', icon: '◉', description: 'Create a read-only space for server rules.' },
];

function CreateChannelDialog({ serverName, channelName, channelType, categories = [], categoryId, error, onNameChange, onTypeChange, onCategoryChange, onCreate, onClose }) {
  const nameRef = useRef(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div className="community-overlay community-create-channel-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="community-dialog community-create-channel" role="dialog" aria-modal="true" aria-labelledby="create-channel-title">
        <header>
          <div><h2 id="create-channel-title">Create Channel</h2><p>in {serverName}</p></div>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <form onSubmit={onCreate}>
          <fieldset className="community-channel-type-list">
            <legend>Channel Type</legend>
            {CREATE_CHANNEL_TYPES.map((type) => (
              <label className={`community-channel-type${channelType === type.value ? ' is-selected' : ''}`} key={type.value}>
                <input type="radio" name="channel-type" value={type.value} checked={channelType === type.value} onChange={() => onTypeChange(type.value)} />
                <span className="community-channel-type-radio" aria-hidden="true" />
                <span className="community-channel-type-icon" aria-hidden="true">{type.icon}</span>
                <span><strong>{type.label}</strong><small>{type.description}</small></span>
              </label>
            ))}
          </fieldset>
          <label className="community-channel-name-label" htmlFor="create-channel-name">Channel Name</label>
          <div className="community-channel-name-input"><span aria-hidden="true">#</span><input ref={nameRef} id="create-channel-name" value={channelName} onChange={(event) => onNameChange(event.target.value)} placeholder="new-channel" maxLength="32" autoComplete="off" /></div>
          {categories.length ? <label className="community-settings-field"><span>Category</span><select aria-label="Channel category" value={categoryId ?? ''} onChange={(event) => onCategoryChange(event.target.value === '' ? null : Number(event.target.value))}><option value="">Uncategorized</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label> : null}
          {error ? <p className="community-dialog-error" role="alert">{error}</p> : null}
          <div className="community-dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="community-dialog-primary" type="submit" disabled={!channelName.trim()}>Create Channel</button></div>
        </form>
      </section>
    </div>
  );
}

function upsertChannelMessage(current, incoming, { appendIfMissing = true } = {}) {
  if (!incoming) return current;
  const id = messageId(incoming);
  if (!Number.isFinite(id)) return current;
  const index = current.findIndex((item) => messageId(item) === id);
  if (index >= 0) {
    const next = current.slice();
    next[index] = { ...incoming, status: 'sent' };
    return next;
  }
  if (id > 0) {
    for (let i = current.length - 1; i >= 0; i -= 1) {
      if (!matchesPendingChannelMessage(current[i], incoming)) continue;
      const next = current.slice();
      next[i] = { ...incoming, status: 'sent' };
      return next;
    }
  }
  return appendIfMissing ? [...current, incoming] : current;
}

function uniqueChannelMessages(items) {
  const seen = new Set();
  const next = [];
  for (const item of items || []) {
    const id = messageId(item);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(item);
  }
  return next;
}

function postLockReason(channel, { canModerate, timeoutUntil, inspecting }) {
  if (!channel || channel.voice || inspecting) return '';
  if (timeoutUntil && Date.parse(timeoutUntil) > Date.now()) return 'You are timed out in this server.';
  if (!canModerate && channel.locked) {
    if (channel.kind === 'rules') return 'Only moderators can post in rules.';
    if (channel.kind === 'announcement') return 'Only moderators can post in announcements.';
    return 'This channel is locked.';
  }
  return '';
}

function pickActiveServer(items, account, currentId = null) {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = Number(params.get('s'));
  let stored = 0;
  try { stored = Number(sessionStorage.getItem('glean.activeServerId')); } catch { /* ignore */ }
  const wanted = currentId || stored || fromUrl;
  const match = items.find((item) => Number(item.id) === Number(wanted));
  if (match?.inspecting && !inspectServersVisible(account)) {
    return items.find((item) => !item.inspecting) || null;
  }
  return match || items.find((item) => !item.inspecting) || items[0] || null;
}

function hasServerDetails(server) {
  return Array.isArray(server?.channels);
}

function mergeServerSummary(current, next) {
  if (!current || !next || Number(current.id) !== Number(next.id) || !hasServerDetails(current) || hasServerDetails(next)) return next;
  return {
    ...next,
    channels: current.channels,
    roles: current.roles,
    members: current.members,
    membership: current.membership,
    inspecting: current.inspecting,
    voiceOccupancy: current.voiceOccupancy,
    liveApps: current.liveApps,
  };
}

function serverUnreadRevision(revisions, serverId) {
  return revisions.get(Number(serverId)) || 0;
}

function preserveServerUnread(previous, next) {
  if (!previous?.channels || !next?.channels) return next;
  const previousChannels = new Map(previous.channels.map((channel) => [Number(channel.id), channel]));
  return {
    ...next,
    channels: next.channels.map((channel) => {
      const current = previousChannels.get(Number(channel.id));
      return current ? { ...channel, unreadCount: current.unreadCount, mentionCount: current.mentionCount } : channel;
    }),
  };
}

function reconcileServerSummaries(nextServers, currentServers, revisionsAtStart, revisionsNow) {
  const currentById = new Map(currentServers.map((server) => [Number(server.id), server]));
  return nextServers.map((server) => {
    const id = Number(server.id);
    const current = currentById.get(id);
    if (!current || serverUnreadRevision(revisionsNow, id) <= serverUnreadRevision(revisionsAtStart, id)) return server;
    return { ...server, unread: current.unread, unreadCount: current.unreadCount, mentionCount: current.mentionCount };
  });
}

export default function CommunityScreen({ account, goTo, onAccountUpdated, onSignedOut }) {
  const cachedServers = peekCachedServers();
  const [servers, setServers] = useState(() => cachedServers?.servers || []);
  const [activeServer, setActiveServer] = useState(() => pickActiveServer(cachedServers?.servers || [], account));
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesError, setMessagesError] = useState('');
  const [messageHistoryRetry, setMessageHistoryRetry] = useState(0);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [serverName, setServerName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [channelName, setChannelName] = useState('');
  const [channelType, setChannelType] = useState('text');
  const [channelCategoryId, setChannelCategoryId] = useState(null);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [roleName, setRoleName] = useState('');
  const [roleColor, setRoleColor] = useState('#249cff');
  const [rolePermissions, setRolePermissions] = useState('moderator');
  const [roleFlags, setRoleFlags] = useState(['manageChannels', 'manageMessages', 'manageMembers', 'manageInvites', 'postStaff', 'manageApps']);
  const [editingRoleId, setEditingRoleId] = useState(null);
  const [editRoleName, setEditRoleName] = useState('');
  const [editRoleColor, setEditRoleColor] = useState('#249cff');
  const [editRolePermissions, setEditRolePermissions] = useState('moderator');
  const [editRoleFlags, setEditRoleFlags] = useState([]);
  const [showAddServer, setShowAddServer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState('overview');
  const [settingsStartPage, setSettingsStartPage] = useState(false);
  const [showServerMenu, setShowServerMenu] = useState(false);
  const [moderationMenu, setModerationMenu] = useState(null);
  const moderationMenuRef = useRef(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [membersVisible, setMembersVisible] = useState(() => window.matchMedia('(min-width: 1101px)').matches);
  const [notice, setNotice] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [realtimeConnection, setRealtimeConnection] = useState(null);
  const [voiceOccupancy, setVoiceOccupancy] = useState({});
  const [voiceCallOccupancy, setVoiceCallOccupancy] = useState({});
  const [liveApps, setLiveApps] = useState({});
  const [typingByChannel, setTypingByChannel] = useState({});
  const [voiceLiveId, setVoiceLiveId] = useState(null);
  const [voiceCall, setVoiceCall] = useState(null);
  const [voiceStream, setVoiceStream] = useState(null);
  const [voiceJoining, setVoiceJoining] = useState(false);
  const [voiceFlags, setVoiceFlags] = useState({ muted: false, deafened: false, camera: false, sharing: false, speaking: false });
  const [isLoadingServers, setIsLoadingServers] = useState(() => !peekCachedServers()?.servers?.length);
  const [serverDetailReload, setServerDetailReload] = useState(0);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersHasMore, setMembersHasMore] = useState(false);
  const [membersNextOffset, setMembersNextOffset] = useState(0);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [homeUnread, setHomeUnread] = useState(() => Number(peekCachedServers()?.homeUnread || 0));
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [reactionPickerId, setReactionPickerId] = useState(null);
  const messageScrollRef = useRef(null);
  const olderLoadRequestRef = useRef(null);
  const historyAnchorRef = useRef(null);
  const memberScrollRef = useRef(null);
  const memberLoadSentinelRef = useRef(null);
  const closeMembers = useCallback(() => {
    setMembersVisible(false);
    window.requestAnimationFrame(() => document.getElementById('server-members-toggle')?.focus({ preventScroll: true }));
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1101px)');
    const update = event => setMembersVisible(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!membersVisible) return undefined;
    const dismiss = event => {
      if (event.key !== 'Escape' || event.defaultPrevented || window.matchMedia('(min-width: 1101px)').matches) return;
      if (document.querySelector('.community-overlay, .dm-settings-backdrop')) return;
      closeMembers();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [membersVisible, closeMembers]);
  const composerRef = useRef(null);
  const menuRef = useRef(null);
  const sendingRef = useRef(false);
  const historyReadyRef = useRef(false);
  const realtimeRef = useRef(null);
  const channelRef = useRef(null);
  const activeServerRef = useRef(activeServer);
  const voiceStreamRef = useRef(null);
  const voiceCallRef = useRef(null);
  const leaveVoiceRef = useRef(null);
  const voiceApiRef = useRef(null);
  const serverUnreadRevisionsRef = useRef(new Map());
  const homeUnreadRevisionRef = useRef(0);
  const serverSummaryRefreshRef = useRef(null);
  const serverSummaryRefreshQueuedRef = useRef(false);
  const liveMessageJournalRef = useRef(null);
  if (!liveMessageJournalRef.current) liveMessageJournalRef.current = createLiveMessageJournal();
  const { open, setDirectory } = useUserPopout();

  const channels = activeServer?.channels || [];
  const textChannels = useMemo(() => channels.filter((item) => !item.voice), [channels]);
  const voiceChannels = useMemo(() => channels.filter((item) => item.voice), [channels]);
  const channel = useMemo(
    () => channels.find((item) => Number(item.id) === Number(activeChannelId)) || channels[0] || null,
    [activeChannelId, channels],
  );
  const permissions = activeServer?.membership?.permissions;
  const inspecting = Boolean(activeServer?.inspecting || activeServer?.membership?.inspecting);
  const platformAdmin = Boolean(account?.platformAdmin);
  const canModerate = permissions === 'owner' || permissions === 'moderator' || platformAdmin;
  const isOwner = permissions === 'owner' || platformAdmin;
  const canPermission = (flag) => isOwner || (permissions === 'moderator' && activeServer?.membership?.permissionFlags?.includes(flag));
  const canManageChannels = canPermission('manageChannels');
  const canManageMembers = canPermission('manageMembers');
  const canManageVoice = canPermission('manageVoice');
  const canManageInvites = canPermission('manageInvites');
  const canManageRoles = canPermission('manageRoles');
  const canViewAuditLog = canPermission('viewAuditLog');
  const hasManageMessagesPermission = canPermission('manageMessages');
  const canPostStaff = canPermission('postStaff');
  const memberGroups = useMemo(() => groupMembers(activeServer), [activeServer?.members, activeServer?.memberCounts, activeServer?.roles]);
  const mentionUsers = useMemo(() => [EVERYONE_MENTION, ...(activeServer?.members || [])], [activeServer?.members]);
  const voicePeople = useMemo(() => allVoiceOccupants(voiceOccupancy), [voiceOccupancy]);
  const timeoutUntil = activeServer?.membership?.timeoutUntil || null;
  const postLock = postLockReason(channel, { canModerate: canPostStaff, timeoutUntil, inspecting });
  useEffect(() => {
    setDirectory(activeServer?.members || []);
  }, [activeServer?.members, setDirectory]);
  useEffect(() => () => setDirectory([]), [setDirectory]);
  useEffect(() => {
    for (const server of servers) {
      if (!server.muted) continue;
      try { window.localStorage.setItem(mutedServerStorageKey(server.id), '1'); } catch { /* server state remains authoritative */ }
    }
  }, [servers]);
  const liveChannel = useMemo(
    () => voiceCall?.channel || channels.find((item) => Number(item.id) === Number(voiceLiveId)) || null,
    [channels, voiceCall, voiceLiveId],
  );
  const visibleMessages = useMemo(() => uniqueChannelMessages(messages), [messages]);
  channelRef.current = channel;
  activeServerRef.current = activeServer;
  const inspectingRef = useRef(inspecting);
  const accountIdRef = useRef(account?.id);
  const activeServerIdRef = useRef(activeServer?.id);
  voiceCallRef.current = voiceCall;
  inspectingRef.current = inspecting;
  accountIdRef.current = account?.id;
  activeServerIdRef.current = activeServer?.id;
  const applyHomeUnread = useCallback((value) => {
    if (value == null) return;
    homeUnreadRevisionRef.current += 1;
    setHomeUnread(Number(value || 0));
  }, []);
  const updateChannelTyping = useCallback((typing) => {
    const channelId = Number(channelRef.current?.id);
    if (channelId) realtimeRef.current?.send?.('channel-typing', { channelId, typing });
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTypingByChannel((current) => {
        let changed = false;
        const next = {};
        for (const [channelId, users] of Object.entries(current)) {
          const active = Object.fromEntries(Object.entries(users).filter(([, item]) => item.expiresAt > Date.now()));
          if (Object.keys(active).length !== Object.keys(users).length) changed = true;
          if (Object.keys(active).length) next[channelId] = active;
        }
        return changed ? next : current;
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const applyChannelUnreadState = useCallback((payload, { updateHome = true } = {}) => {
    const serverId = Number(payload.serverId);
    const channelId = Number(payload.channelId);
    if (!Number.isInteger(serverId) || !Number.isInteger(channelId)) return;
    patchCachedServerUnreadSummary(payload);
    setServers((current) => patchServerUnreadSummary(current, payload));
    setActiveServer((current) => current && Number(current.id) === serverId && current.channels ? {
      ...current,
      channels: current.channels.map((channel) => Number(channel.id) === channelId ? {
        ...channel,
        ...(payload.unreadCount != null ? { unreadCount: Number(payload.unreadCount) } : {}),
        ...(payload.mentionCount != null ? { mentionCount: Number(payload.mentionCount) } : {}),
      } : channel),
    } : current);
    if (updateHome) applyHomeUnread(payload.homeUnread);
  }, [applyHomeUnread]);
  const refreshServerSummaries = useCallback(() => {
    if (serverSummaryRefreshRef.current) {
      serverSummaryRefreshQueuedRef.current = true;
      return serverSummaryRefreshRef.current;
    }
    const refresh = async () => {
      let items = [];
      do {
        serverSummaryRefreshQueuedRef.current = false;
        const revisionsAtStart = new Map(serverUnreadRevisionsRef.current);
        const homeRevisionAtStart = homeUnreadRevisionRef.current;
        const result = await getServers({ force: true });
        items = result.servers;
        setServers((current) => reconcileServerSummaries(items, current, revisionsAtStart, serverUnreadRevisionsRef.current));
        if (homeUnreadRevisionRef.current === homeRevisionAtStart) applyHomeUnread(result.homeUnread);
      } while (serverSummaryRefreshQueuedRef.current);
      return items;
    };
    const pending = refresh().finally(() => {
      if (serverSummaryRefreshRef.current === pending) serverSummaryRefreshRef.current = null;
      serverSummaryRefreshQueuedRef.current = false;
    });
    serverSummaryRefreshRef.current = pending;
    return pending;
  }, [applyHomeUnread]);
  const markChannelReadAndApply = useCallback(async (channelId, lastReadMessageId, knownServerId = activeServerIdRef.current) => {
    const serverId = Number(knownServerId);
    const revisionAtStart = serverUnreadRevision(serverUnreadRevisionsRef.current, serverId);
    const homeRevisionAtStart = homeUnreadRevisionRef.current;
    const payload = await markChannelRead(channelId, lastReadMessageId);
    if (serverUnreadRevision(serverUnreadRevisionsRef.current, serverId) === revisionAtStart) {
      serverUnreadRevisionsRef.current.set(serverId, revisionAtStart + 1);
      applyChannelUnreadState(payload, { updateHome: homeUnreadRevisionRef.current === homeRevisionAtStart });
    }
    return payload;
  }, [applyChannelUnreadState]);
  const serverUnreadBadge = useMemo(
    () => servers.reduce((total, server) => server.inspecting ? total : total + Number(server.unreadCount || 0), 0),
    [servers],
  );
  useEffect(() => { setAppBadge(homeUnread + serverUnreadBadge); }, [homeUnread, serverUnreadBadge]);
  const { atBottom, hasNewMessages, jumpToBottom } = useChatAutoscroll(
    messageScrollRef,
    channel?.voice || isLoadingMessages ? null : channel?.id,
    visibleMessages.at(-1)?.id ?? visibleMessages.length,
  );
  useLayoutEffect(() => {
    historyReadyRef.current = false;
    olderLoadRequestRef.current = null;
    historyAnchorRef.current = null;
  }, [channel?.id]);
  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    const scroller = messageScrollRef.current;
    if (!anchor || !scroller || Number(channel?.id) !== anchor.channelId) return;
    const message = document.getElementById(`m-${anchor.messageId}`);
    if (message) {
      const scrollerTop = scroller.getBoundingClientRect().top;
      scroller.scrollTop += message.getBoundingClientRect().top - scrollerTop - anchor.offset;
    }
    historyAnchorRef.current = null;
  }, [messages, channel?.id]);
  useLayoutEffect(() => {
    if (isLoadingMessages || channel?.voice) return;
    const node = messageScrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    const frame = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      historyReadyRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [channel?.id, channel?.voice, isLoadingMessages, mobileChatOpen]);
  useEffect(() => {
    setPushFocus(channel?.id ? { kind: 'channel', id: channel.id, serverId: activeServer?.id } : null);
    return () => setPushFocus(null);
  }, [channel?.id, activeServer?.id]);
  useEffect(() => {
    const onOpen = (event) => {
      const serverId = Number(event.detail?.serverId || event.detail?.server?.id);
      const channelId = Number(event.detail?.channelId);
      if (Number.isInteger(serverId) && serverId > 0) {
        const match = servers.find((item) => Number(item.id) === serverId) || event.detail?.server;
        if (match) {
          setServers((current) => current.some((item) => Number(item.id) === serverId) ? current : [...current, match]);
          setActiveServer((current) => mergeServerSummary(current, match));
        }
      }
      if (Number.isInteger(channelId) && channelId > 0) {
        try { sessionStorage.setItem('glean.activeChannelId', String(channelId)); } catch { /* ignore */ }
        setActiveChannelId(channelId);
      }
    };
    window.addEventListener('glean-open-target', onOpen);
    window.addEventListener('glean-open-server', onOpen);
    return () => {
      window.removeEventListener('glean-open-target', onOpen);
      window.removeEventListener('glean-open-server', onOpen);
    };
  }, [servers]);

  const closeAddServer = useCallback(() => {
    setShowAddServer(false);
    setDialogError('');
  }, []);

  const closeSettings = useCallback(() => setShowSettings(false), []);

  const acquireMic = useCallback(async () => {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    voiceStreamRef.current = media;
    setVoiceStream(media);
    return media;
  }, []);

  const leaveVoice = useCallback(() => {
    const media = voiceStreamRef.current;
    voiceStreamRef.current = null;
    setVoiceStream(null);
    setVoiceLiveId(null);
    setVoiceCall(null);
    setVoiceCallOccupancy({});
    setVoiceJoining(false);
    setVoiceFlags({ muted: false, deafened: false, camera: false, sharing: false, speaking: false });
    media?.getTracks().forEach((track) => track.stop());
    if (channelRef.current?.voice) {
      const fallback = (activeServer?.channels || []).find((item) => !item.voice);
      if (fallback) setActiveChannelId(fallback.id);
      setMobileChatOpen(false);
    }
  }, [activeServer?.channels]);
  leaveVoiceRef.current = leaveVoice;

  useEffect(() => {
    const onLeave = () => leaveVoice();
    window.addEventListener('glean-leave-voice', onLeave);
    return () => window.removeEventListener('glean-leave-voice', onLeave);
  }, [leaveVoice]);

  const openSettings = (tab) => {
    setSettingsTab(tab || 'overview');
    setSettingsStartPage(Boolean(tab));
    setShowSettings(true);
    setShowServerMenu(false);
  };

  const applyServerPatch = useCallback((patch) => {
    if (!patch?.id) return;
    setActiveServer((current) => (current && Number(current.id) === Number(patch.id) ? { ...current, ...patch } : current));
    setServers((current) => current.map((item) => (Number(item.id) === Number(patch.id) ? { ...item, ...patch } : item)));
  }, []);

  const applyChannelPatch = useCallback((channel) => {
    if (!channel?.id) return;
    setActiveServer((current) => (current ? {
      ...current,
      channels: (current.channels || []).map((item) => Number(item.id) === Number(channel.id) ? { ...item, ...channel } : item),
    } : current));
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!moderationMenu) return undefined;
    const close = () => setModerationMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); }, { once: true });
    return () => window.removeEventListener('click', close);
  }, [moderationMenu]);

  useEffect(() => {
    if (!moderationMenu || !moderationMenuRef.current) return undefined;
    const frame = requestAnimationFrame(() => {
      const menu = moderationMenuRef.current;
      if (!menu) return;
      const bounds = menu.getBoundingClientRect();
      const margin = 8;
      const x = Math.max(margin, Math.min(moderationMenu.x, window.innerWidth - bounds.width - margin));
      const y = Math.max(margin, Math.min(moderationMenu.y, window.innerHeight - bounds.height - margin));
      if (x !== moderationMenu.x || y !== moderationMenu.y) setModerationMenu((current) => current ? { ...current, x, y } : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [moderationMenu]);

  useEffect(() => {
    let cancelled = false;
    if (!peekCachedServers()?.servers?.length) setIsLoadingServers(true);
    const revisionsAtStart = new Map(serverUnreadRevisionsRef.current);
    const homeRevisionAtStart = homeUnreadRevisionRef.current;
    getServers()
      .then(({ servers: items, homeUnread: nextHome }) => {
        if (cancelled) return;
        setServers((current) => reconcileServerSummaries(items, current, revisionsAtStart, serverUnreadRevisionsRef.current));
        if (homeUnreadRevisionRef.current === homeRevisionAtStart) applyHomeUnread(nextHome);
        setActiveServer((current) => {
          const params = new URLSearchParams(window.location.search);
          const fromUrlChannel = Number(params.get('ch'));
          if (fromUrlChannel) {
            try { sessionStorage.setItem('glean.activeChannelId', String(fromUrlChannel)); } catch { /* ignore */ }
          }
          const next = pickActiveServer(items, account, current?.id);
          try { sessionStorage.removeItem('glean.activeServerId'); } catch { /* ignore */ }
          return mergeServerSummary(current, next);
        });
      })
      .catch((error) => { if (!cancelled) setNotice(error.message); })
      .finally(() => { if (!cancelled) setIsLoadingServers(false); });
    return () => { cancelled = true; };
  }, [account?.showInspectServers, applyHomeUnread]);

  useEffect(() => {
    if (!activeServer?.id) return undefined;
    let cancelled = false;
    const loadServerDetails = async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 2 && !cancelled; attempt += 1) {
        try {
          const revisionAtStart = serverUnreadRevision(serverUnreadRevisionsRef.current, activeServer.id);
          const { server } = await getServer(activeServer.id);
          if (!hasServerDetails(server)) throw new Error('Server channels are temporarily unavailable.');
          if (cancelled) return;
          const mergedServer = mergeLoadedServerMembers(server, activeServerRef.current);
          setActiveServer((current) => {
            if (!current || Number(current.id) !== Number(server.id)) return current;
            const next = serverUnreadRevision(serverUnreadRevisionsRef.current, server.id) > revisionAtStart
              ? preserveServerUnread(current, mergedServer)
              : mergedServer;
            return { ...current, ...next };
          });
          setMembersNextOffset(Number(mergedServer.membersPage?.nextOffset ?? mergedServer.members?.length ?? 0));
          setMembersHasMore(Boolean(mergedServer.membersPage?.hasMore));
          setMembersLoading(false);
          setVoiceOccupancy(server.voiceOccupancy || {});
          setLiveApps(server.liveApps || {});
          const savedKey = `glean.lastChannel.${account?.id || 'current'}.${server.id}`;
          let savedChannel = 0;
          try { savedChannel = Number(localStorage.getItem(savedKey)); } catch { /* ignore unavailable storage */ }
          const wantedChannel = Number(sessionStorage.getItem('glean.activeChannelId')) || savedChannel;
          if (wantedChannel) sessionStorage.removeItem('glean.activeChannelId');
          setActiveChannelId((current) => {
            const pick = wantedChannel || current;
            return server.channels.some((item) => Number(item.id) === Number(pick)) ? pick : server.channels[0]?.id || null;
          });
          return;
        } catch (error) {
          lastError = error;
          if (attempt === 0 && !cancelled) await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      }
      if (!cancelled) setNotice(lastError?.message || 'Could not load this server.');
    };
    loadServerDetails();
    return () => { cancelled = true; };
  }, [account?.id, activeServer?.id, serverDetailReload]);

  const loadMoreMembers = useCallback(async () => {
    const serverId = Number(activeServerIdRef.current);
    if (!serverId || membersLoading || !membersHasMore) return;
    const offset = membersNextOffset;
    setMembersLoading(true);
    try {
      const result = await getServerMembers(serverId, { offset, limit: MEMBER_CHUNK_SIZE });
      if (Number(activeServerIdRef.current) !== serverId) return;
      const nextMembers = Array.isArray(result.members) ? result.members : [];
      setActiveServer((current) => {
        if (!current || Number(current.id) !== serverId) return current;
        const byId = new Map((current.members || []).map((member) => [Number(member.id), member]));
        nextMembers.forEach((member) => byId.set(Number(member.id), member));
        return {
          ...current,
          members: [...byId.values()],
          memberTotal: result.memberTotal ?? current.memberTotal,
          memberCounts: result.memberCounts || current.memberCounts,
        };
      });
      const page = result.page || {};
      setMembersNextOffset(Number(page.nextOffset ?? offset + nextMembers.length));
      setMembersHasMore(Boolean(page.hasMore));
    } catch (error) {
      setNotice(error.message || 'Could not load more members.');
    } finally {
      setMembersLoading(false);
    }
  }, [membersHasMore, membersLoading, membersNextOffset]);

  useEffect(() => {
    const sentinel = memberLoadSentinelRef.current;
    const root = memberScrollRef.current;
    if (!sentinel || !root || !membersHasMore || !membersVisible) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreMembers();
      },
      { root, rootMargin: '240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeServer?.id, loadMoreMembers, membersHasMore, membersVisible]);

  useEffect(() => {
    if (!channel?.id || channel.voice) {
      setMessages([]);
      setMessagesError('');
      setIsLoadingMessages(false);
      return undefined;
    }
    let cancelled = false;
    setMessages([]);
    setMessagesError('');
    setIsLoadingMessages(true);
    setHasMoreMessages(false);
    setIsLoadingOlder(false);
    if (!inspectingRef.current) {
      setActiveServer((current) => current ? {
        ...current,
        channels: (current.channels || []).map((entry) => Number(entry.id) === Number(channel.id) ? { ...entry, unreadCount: 0, mentionCount: 0 } : entry),
      } : current);
    }
    const messageScope = `channel:${Number(activeServerIdRef.current)}:${Number(channel.id)}`;
    const snapshotRevision = liveMessageJournalRef.current.revision();
    getChannelMessages(channel.id, { limit: 50 })
      .then(({ messages: items, page }) => {
        if (cancelled) return;
        setMessages((current) => liveMessageJournalRef.current.mergeSnapshot(
          messageScope,
          current,
          uniqueChannelMessages(items),
          snapshotRevision,
          { isPending: isPendingChannelMessage },
        ));
        setHasMoreMessages(Boolean(page?.hasMore));
        if (!inspectingRef.current) {
          markChannelReadAndApply(channel.id, items[items.length - 1]?.id, activeServerIdRef.current).catch(() => {});
        }
      })
      .catch((error) => { if (!cancelled) setMessagesError(error.message || 'Could not load channel history.'); })
      .finally(() => { if (!cancelled) setIsLoadingMessages(false); });
    const onVisible = () => {
      if (inspectingRef.current || document.visibilityState !== 'visible' || channel.voice) return;
      markChannelReadAndApply(channel.id, undefined, activeServerIdRef.current).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [channel?.id, channel?.voice, markChannelReadAndApply, messageHistoryRetry]);

  useEffect(() => {
    if (!account?.id) return undefined;
    let hasConnectedOnce = false;
    const connection = subscribeToDmEvents((eventName, payload) => {
      if (eventName === 'connected') {
        realtimeRef.current?.onVoice?.('voice-reconnect', payload);
        if (hasConnectedOnce) {
          refreshServerSummaries().catch(() => {});
          if (activeServerIdRef.current) setServerDetailReload((value) => value + 1);
          if (channelRef.current?.id && !channelRef.current.voice) setMessageHistoryRetry((value) => value + 1);
        }
        hasConnectedOnce = true;
        return;
      }
      if (eventName === 'voice-disconnected') {
        if (Number(voiceCallRef.current?.serverId) === Number(payload.serverId)
          && Number(voiceCallRef.current?.channel?.id) === Number(payload.channelId)) {
          setNotice('A moderator disconnected you from voice.');
          if (voiceApiRef.current?.hangUp) voiceApiRef.current.hangUp();
          else leaveVoiceRef.current?.();
        }
        return;
      }
      if (eventName === 'voice-occupancy') {
        const eventServerId = Number(payload.serverId);
        const activeServerId = Number(activeServerIdRef.current);
        const callServerId = Number(voiceCallRef.current?.serverId);
        if (eventServerId === activeServerId) setVoiceOccupancy(payload.channels || {});
        if (eventServerId === callServerId) setVoiceCallOccupancy(payload.channels || {});
        if (eventServerId === activeServerId || eventServerId === callServerId) realtimeRef.current?.onVoice?.(eventName, payload);
        if (eventServerId === activeServerId || eventServerId === callServerId) return;
      }
      if (eventName === 'voice-state') {
        const eventServerId = Number(payload.serverId);
        const activeServerId = Number(activeServerIdRef.current);
        const callServerId = Number(voiceCallRef.current?.serverId);
        if (eventServerId === activeServerId) {
          setVoiceOccupancy((current) => {
            const key = String(payload.channelId);
            const list = current[key] || [];
            return { ...current, [key]: list.map((item) => Number(item.id) === Number(payload.userId) ? { ...item, ...payload } : item) };
          });
        }
        if (eventServerId === callServerId) {
          setVoiceCallOccupancy((current) => {
            const key = String(payload.channelId);
            const list = current[key] || [];
            return { ...current, [key]: list.map((item) => Number(item.id) === Number(payload.userId) ? { ...item, ...payload } : item) };
          });
        }
        if (eventServerId === activeServerId || eventServerId === callServerId) realtimeRef.current?.onVoice?.(eventName, payload);
        if (eventServerId === activeServerId || eventServerId === callServerId) return;
      }
      if (eventName.startsWith('voice-')) { realtimeRef.current?.onVoice?.(eventName, payload); return; }
      if (eventName.startsWith('app-')) {
        if (eventName === 'app-session' && Number(payload.serverId) === Number(activeServerIdRef.current) && payload.channelId) {
          setLiveApps((current) => {
            const key = String(payload.channelId);
            if (!payload.session) {
              if (!(key in current)) return current;
              const next = { ...current };
              delete next[key];
              return next;
            }
            return { ...current, [key]: payload.session };
          });
        }
        realtimeRef.current?.onApp?.(eventName, payload);
        return;
      }
      if (eventName === 'message' || eventName === 'friends' || (eventName === 'unread' && payload.kind === 'dm')) {
        applyHomeUnread(payload.homeUnread);
      }
      if (eventName === 'channel-typing') {
        const channelId = Number(payload.channelId);
        const userKey = String(payload.userId || payload.username || 'user');
        setTypingByChannel((current) => {
          const users = { ...(current[channelId] || {}) };
          if (payload.typing === true) users[userKey] = { name: payload.username || 'Someone', expiresAt: Date.now() + 6000 };
          else delete users[userKey];
          return { ...current, [channelId]: users };
        });
      }
      if ((eventName === 'unread' && payload.kind === 'channel') || (eventName === 'channel-message' && payload.action === 'created')) {
        const eventServerId = Number(payload.serverId);
        const muted = isServerMuted(eventServerId);
        if (Number.isInteger(eventServerId) && eventServerId > 0) {
          serverUnreadRevisionsRef.current.set(eventServerId, serverUnreadRevision(serverUnreadRevisionsRef.current, eventServerId) + 1);
        }
        const mine = Number(payload.message?.author?.id) === Number(accountIdRef.current);
        const sameServer = Number(payload.serverId) === Number(activeServerIdRef.current);
        const sameChannel = Number(payload.channelId) === Number(channelRef.current?.id);
        const focused = sameServer && sameChannel && !channelRef.current?.voice && document.visibilityState === 'visible' && !inspectingRef.current;
        if (eventName === 'channel-message' && focused && !mine && payload.message?.id) markChannelReadAndApply(payload.channelId, payload.message.id, payload.serverId).catch(() => {});
        const unreadCount = muted || focused || mine ? 0 : Number(payload.unreadCount || 0);
        const mentionCount = muted || focused || mine ? 0 : Number(payload.mentionCount || 0);
        if (!muted) applyChannelUnreadState({ ...payload, unreadCount, mentionCount });
      }
      if (eventName === 'channel-message') {
        const messageIdValue = payload.message?.id ?? payload.messageId;
        liveMessageJournalRef.current.record(
          `channel:${Number(payload.serverId)}:${Number(payload.channelId)}`,
          payload.action || 'created',
          payload.action === 'deleted' ? null : payload.message,
          messageIdValue,
        );
      }
      if (eventName === 'channel-messages-cleared') {
        const scope = `channel:${Number(payload.serverId)}:${Number(payload.channelId)}`;
        liveMessageJournalRef.current.clear(scope);
        if (Number(payload.serverId) === Number(activeServerIdRef.current) && Number(payload.channelId) === Number(channelRef.current?.id)) setMessages([]);
      }
      if (eventName === 'channel-message' && Number(payload.serverId) === Number(activeServerIdRef.current) && Number(payload.channelId) === Number(channelRef.current?.id)) {
        setMessages((current) => {
          if (payload.action === 'deleted') return current.filter((message) => messageId(message) !== Number(payload.messageId));
          if (!payload.message) return current;
          if (payload.action === 'created') return upsertChannelMessage(current, payload.message);
          if (payload.action === 'edited' || payload.action === 'reaction' || payload.action === 'poll') return upsertChannelMessage(current, payload.message, { appendIfMissing: false });
          return current;
        });
      }
      if (eventName === 'server-updated') {
        const serverId = Number(payload.serverId);
        if (serverId === Number(activeServerIdRef.current)) {
          const revisionAtStart = serverUnreadRevision(serverUnreadRevisionsRef.current, serverId);
          getServer(serverId).then(({ server }) => {
            setActiveServer((current) => {
              if (!current || Number(current.id) !== Number(server.id)) return current;
              const next = serverUnreadRevision(serverUnreadRevisionsRef.current, serverId) > revisionAtStart
                ? preserveServerUnread(current, server)
                : server;
              return { ...current, ...next };
            });
            setServers((current) => current.map((item) => (Number(item.id) === Number(server.id) ? { ...item, name: server.name, iconUrl: server.iconUrl, description: server.description, banner: server.banner } : item)));
            if (server.voiceOccupancy && Object.keys(server.voiceOccupancy).length) setVoiceOccupancy(server.voiceOccupancy);
            if (Number(voiceCallRef.current?.serverId) === Number(server.id) && server.voiceOccupancy) setVoiceCallOccupancy(server.voiceOccupancy);
          }).catch(() => {});
        } else {
          refreshServerSummaries().catch(() => {});
        }
      }
      if (eventName === 'official-server-visibility') {
        const affectedServerId = Number(payload.serverId);
        if (payload.hidden === true) {
          if (Number(activeServerIdRef.current) === affectedServerId) {
            leaveVoiceRef.current?.();
            setActiveServer(null);
            setActiveChannelId(null);
            setMobileChatOpen(false);
            setShowSettings(false);
            setNotice('The official Glean server is currently hidden.');
          }
          setServers((current) => current.filter((item) => Number(item.id) !== affectedServerId));
        } else {
          refreshServerSummaries().catch(() => {});
        }
        return;
      }
      if (eventName === 'server-membership') {
        const affectedServerId = Number(payload.serverId);
        refreshServerSummaries().then((items) => {
          if (payload.action === 'joined' && Number(activeServerIdRef.current) === affectedServerId) {
            setServerDetailReload((value) => value + 1);
          }
          if (!items.some((item) => Number(item.id) === affectedServerId) && Number(voiceCallRef.current?.serverId) === affectedServerId) leaveVoiceRef.current?.();
          if (!items.some((item) => Number(item.id) === affectedServerId) && Number(activeServerIdRef.current) === affectedServerId) {
            setActiveServer(null);
            setActiveChannelId(null);
            setMobileChatOpen(false);
            setShowSettings(false);
            setNotice('Your access to this server changed.');
          }
        }).catch(() => {});
      }
    }, () => {}, account?.id);
    realtimeRef.current = connection;
    setRealtimeConnection(() => connection);
    return () => { realtimeRef.current = null; setRealtimeConnection(null); connection.close(); };
  }, [account?.id, applyChannelUnreadState, applyHomeUnread, markChannelReadAndApply, refreshServerSummaries]);

  useEffect(() => {
    if (!account?.id) return undefined;
    let busy = false;
    const syncVisibleState = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      const serverId = Number(activeServerIdRef.current);
      const channelId = Number(channelRef.current?.id);
      try {
        try { await refreshServerSummaries(); } catch { /* keep server badges and retry next sync */ }
        if (serverId) {
          try {
            const detailRevisionAtStart = serverUnreadRevision(serverUnreadRevisionsRef.current, serverId);
            const { server } = await getServer(serverId);
            if (Number(activeServerIdRef.current) === serverId) {
              const mergedServer = mergeLoadedServerMembers(server, activeServerRef.current);
              setActiveServer((current) => {
                if (!current || Number(current.id) !== serverId) return current;
                const next = serverUnreadRevision(serverUnreadRevisionsRef.current, serverId) > detailRevisionAtStart
                  ? preserveServerUnread(current, mergedServer)
                  : mergedServer;
                return { ...current, ...next };
              });
              setMembersNextOffset(Number(mergedServer.membersPage?.nextOffset ?? mergedServer.members?.length ?? 0));
              setMembersHasMore(Boolean(mergedServer.membersPage?.hasMore));
              if (server.voiceOccupancy) setVoiceOccupancy(server.voiceOccupancy);
            }
          } catch { /* keep current server details and retry next sync */ }
        }
        if (channelId && !channelRef.current?.voice && Number(channelRef.current?.id) === channelId) {
          try {
            const messageScope = `channel:${serverId}:${channelId}`;
            const snapshotRevision = liveMessageJournalRef.current.revision();
            const { messages: latest } = await getChannelMessages(channelId, { limit: 50 });
            if (Number(channelRef.current?.id) === channelId) {
              setMessages((current) => liveMessageJournalRef.current.mergeSnapshot(
                messageScope,
                current,
                latest,
                snapshotRevision,
                { isPending: isPendingChannelMessage, retainCurrent: true },
              ));
            }
          } catch { /* keep the current transcript and retry next sync */ }
        }
      } finally {
        busy = false;
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') syncVisibleState(); };
    // Realtime events update messages, unread counts, and voice state. Keep a slower
    // snapshot refresh as a safety net for events missed during a brief disconnect.
    const timer = window.setInterval(syncVisibleState, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [account?.id, refreshServerSummaries]);

  useEffect(() => () => {
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    if (!showServerMenu) return undefined;
    const onPointer = (event) => {
      if (!menuRef.current?.contains(event.target)) setShowServerMenu(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [showServerMenu]);

  useEffect(() => {
    if (!reactionPickerId) return undefined;
    const onPointer = () => setReactionPickerId(null);
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [reactionPickerId]);

  const selectServer = (server) => {
    if (!server) return;
    if (Number(server.id) === Number(activeServerIdRef.current)) {
      if (!hasServerDetails(activeServer)) setServerDetailReload((current) => current + 1);
      setMobileChatOpen(false);
      return;
    }
    setVoiceOccupancy({});
    setLiveApps({});
    setMembersLoading(false);
    setMembersHasMore(false);
    setMembersNextOffset(0);
    setActiveServer(server);
    setActiveChannelId(null);
    setMessages([]);
    setHasMoreMessages(false);
    setReplyTo(null);
    setShowSettings(false);
    setShowServerMenu(false);
    setMobileChatOpen(false);
  };

  useEffect(() => {
    if (isLoadingServers) return undefined;
    const pending = peekPendingInvite();
    if (!pending) return undefined;
    let cancelled = false;
    joinServerByInvite(pending)
      .then(({ server }) => {
        if (cancelled) return;
        takePendingInvite();
        setServers((current) => current.some((item) => Number(item.id) === Number(server.id)) ? current : [...current, server]);
        selectServer(server);
        setNotice(server.alreadyMember ? `You are already a member of ${server.name}.` : `Joined ${server.name}.`);
      })
      .catch((error) => {
        if (cancelled) return;
        takePendingInvite();
        setInviteCode(pending);
        setDialogError(error.message);
        setShowAddServer(true);
      });
    return () => { cancelled = true; };
  }, [isLoadingServers]);

  const selectChannel = async (channelId) => {
    const item = channels.find((entry) => Number(entry.id) === Number(channelId));
    setActiveChannelId(channelId);
    if (activeServer?.id) {
      try { localStorage.setItem(`glean.lastChannel.${account?.id || 'current'}.${activeServer.id}`, String(channelId)); } catch { /* ignore unavailable storage */ }
    }
    setMobileChatOpen(true);
    setEditingMessageId(null);
    setReactionPickerId(null);
    setReplyTo(null);
    if (!item?.voice && !inspecting) {
      setActiveServer((current) => current ? {
        ...current,
        channels: (current.channels || []).map((entry) => Number(entry.id) === Number(channelId) ? { ...entry, unreadCount: 0, mentionCount: 0 } : entry),
      } : current);
    }
    if (!item?.voice) return;
    const targetServerId = Number(activeServer?.id);
    if (voiceStreamRef.current) {
      setVoiceCall({ serverId: targetServerId, channel: item });
      setVoiceCallOccupancy(voiceOccupancy);
      setVoiceLiveId(item.id);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) return;
    setVoiceCall({ serverId: targetServerId, channel: item });
    setVoiceCallOccupancy(voiceOccupancy);
    setVoiceLiveId(item.id);
    setVoiceJoining(true);
    try {
      await acquireMic();
    } catch (error) {
      setVoiceLiveId(null);
      setVoiceCall(null);
      setVoiceCallOccupancy({});
      setNotice(microphoneError(error));
    } finally {
      setVoiceJoining(false);
    }
  };

  const requestMic = async () => {
    if (!channel?.voice || inspecting) return;
    const targetServerId = Number(activeServer?.id);
    const targetChannel = channel;
    setVoiceJoining(true);
    try {
      await acquireMic();
      setVoiceCall({ serverId: targetServerId, channel: targetChannel });
      setVoiceCallOccupancy(voiceOccupancy);
      setVoiceLiveId(targetChannel.id);
    } finally {
      setVoiceJoining(false);
    }
  };

  const loadOlderMessages = useCallback(async () => {
    const requestedChannelId = Number(channel?.id);
    if (!historyReadyRef.current || !requestedChannelId || channel.voice || !hasMoreMessages || olderLoadRequestRef.current?.channelId === requestedChannelId) return;
    const scroller = messageScrollRef.current;
    if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80) return;
    const currentMessages = messagesRef.current;
    const first = currentMessages.find((item) => Number.isFinite(messageId(item)) && messageId(item) > 0);
    if (!first) return;
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      const visible = [...scroller.querySelectorAll('.community-message[id]')].find((message) => message.getBoundingClientRect().bottom > bounds.top + 1);
      if (visible?.id) historyAnchorRef.current = {
        channelId: requestedChannelId,
        messageId: Number(visible.id.slice(2)),
        offset: visible.getBoundingClientRect().top - bounds.top,
      };
    }
    const request = { channelId: requestedChannelId, token: Symbol('older-message-page') };
    olderLoadRequestRef.current = request;
    setIsLoadingOlder(true);
    const messageScope = `channel:${Number(activeServerIdRef.current)}:${requestedChannelId}`;
    const snapshotRevision = liveMessageJournalRef.current.revision();
    try {
      const { messages: older, page } = await getChannelMessages(requestedChannelId, { before: messageId(first), limit: 50 });
      if (Number(channelRef.current?.id) !== requestedChannelId) return;
      if (!older?.length) historyAnchorRef.current = null;
      setMessages((current) => liveMessageJournalRef.current.mergeSnapshot(
        messageScope,
        current,
        [...(older || []), ...current],
        snapshotRevision,
        { isPending: isPendingChannelMessage, retainCurrent: true },
      ));
      setHasMoreMessages(Boolean(page?.hasMore));
    } catch (error) {
      if (Number(channelRef.current?.id) === requestedChannelId) setNotice(error.message);
    } finally {
      if (olderLoadRequestRef.current === request) {
        olderLoadRequestRef.current = null;
        if (Number(channelRef.current?.id) === requestedChannelId) setIsLoadingOlder(false);
      }
    }
  }, [channel?.id, channel?.voice, hasMoreMessages]);

  useEffect(() => {
    const node = messageScrollRef.current;
    if (!node || channel?.voice) return undefined;
    const onScroll = () => {
      if (!historyReadyRef.current) return;
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 80) return;
      if (node.scrollTop < 120) loadOlderMessages();
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [channel?.voice, loadOlderMessages]);

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

  const persistChannelOrder = useCallback((nextKind, voice) => {
    if (!activeServer?.id || inspecting) return;
    const previous = activeServer.channels || [];
    const others = previous.filter((item) => Boolean(item.voice) !== voice);
    const merged = voice ? [...others, ...nextKind] : [...nextKind, ...others];
    setActiveServer((current) => (current ? { ...current, channels: merged } : current));
    reorderChannels(activeServer.id, nextKind.map((item) => Number(item.id))).catch(() => {
      setActiveServer((current) => (current ? { ...current, channels: previous } : current));
    });
  }, [activeServer, inspecting]);

  const textReorder = useHoldReorder({
    items: textChannels,
    enabled: Boolean(activeServer) && !inspecting && textChannels.length > 1,
    onReorder: (next) => persistChannelOrder(next, false),
  });
  const voiceReorder = useHoldReorder({
    items: voiceChannels,
    enabled: Boolean(activeServer) && !inspecting && voiceChannels.length > 1,
    onReorder: (next) => persistChannelOrder(next, true),
  });

  const persistCategoryChannelOrder = async (next) => {
    if (!activeServer?.id || !canManageChannels) return;
    const previous = activeServer.channels;
    const id = activeServer.id;
    applyServerPatch({ id, channels: next });
    try { await reorderChannels(id, next.map((item) => item.id), 'all'); }
    catch (error) { applyServerPatch({ id, channels: previous }); setNotice(error.message); }
  };

  const removeCurrentChannel = async (channelToRemove) => {
    if (!activeServer || !channelToRemove || !canManageChannels || channelToRemove.name === 'general') return;
    if (!window.confirm(`Delete ${channelToRemove.voice ? '' : '#'}${channelToRemove.name}?${channelToRemove.voice ? '' : ' This removes its messages.'}`)) return;
    try {
      await deleteChannel(activeServer.id, channelToRemove.id);
      const remaining = channels.filter((item) => item.id !== channelToRemove.id);
      setActiveServer((current) => ({ ...current, channels: remaining }));
      setActiveChannelId(remaining[0]?.id || null);
      setMessages([]);
      setNotice(`${channelToRemove.voice ? '' : '#'}${channelToRemove.name} was deleted.`);
    } catch (error) { setNotice(error.message); }
  };

  const leaveCurrentServer = async ({ confirmed = false } = {}) => {
    if (!activeServer || isOwner || (!confirmed && !window.confirm(`Leave ${activeServer.name}?`))) return;
    try {
      await leaveServer(activeServer.id);
      leaveVoice();
      setServers((current) => current.filter((server) => server.id !== activeServer.id));
      setActiveServer(null);
      setActiveChannelId(null);
      setMessages([]);
      setShowSettings(false);
      setMobileChatOpen(false);
      setNotice(`You left ${activeServer.name}.`);
    } catch (error) { setNotice(error.message); }
  };

  const leaveFromServerRail = useCallback(async (server) => {
    if (!server?.id || !window.confirm(`Leave ${server.name}?`)) return;
    if (Number(server.id) === Number(activeServer?.id)) {
      await leaveCurrentServer({ confirmed: true });
      return;
    }
    try {
      await leaveServer(server.id);
      setServers((current) => current.filter((item) => Number(item.id) !== Number(server.id)));
      setNotice(`You left ${server.name}.`);
    } catch (error) { setNotice(error.message); }
  }, [activeServer?.id]);

  const removeCurrentServer = async () => {
    if (!activeServer || !isOwner || !window.confirm(`Delete ${activeServer.name}? This cannot be undone.`)) return;
    try {
      await deleteServer(activeServer.id);
      leaveVoice();
      setServers((current) => current.filter((server) => server.id !== activeServer.id));
      setActiveServer(null);
      setActiveChannelId(null);
      setMessages([]);
      setShowSettings(false);
      setMobileChatOpen(false);
      setNotice(`${activeServer.name} was deleted.`);
    } catch (error) { setNotice(error.message); }
  };

  const submitServer = async (event) => {
    event.preventDefault();
    const cleanName = serverName.trim();
    if (!cleanName) return;
    try {
      const { server } = await createServer(cleanName);
      setServers((current) => [...current, server]);
      setActiveServer(server);
      setActiveChannelId(server.channels?.[0]?.id || null);
      setServerName('');
      setDialogError('');
      setShowAddServer(false);
      setNotice(`Created ${server.name}.`);
    } catch (error) { setDialogError(error.message); }
  };

  const submitInviteJoin = async (event) => {
    event.preventDefault();
    const cleanCode = parseInviteInput(inviteCode) || inviteCode.trim();
    if (!cleanCode) return;
    try {
      const { server } = await joinServerByInvite(cleanCode);
      setServers((current) => current.some((item) => item.id === server.id) ? current : [...current, server]);
      selectServer(server);
      setInviteCode('');
      setDialogError('');
      setShowAddServer(false);
      setNotice(server.alreadyMember ? `You are already a member of ${server.name}.` : `Joined ${server.name}.`);
    } catch (error) { setDialogError(error.message); }
  };

  const submitChannel = async (event) => {
    event.preventDefault();
    if (!activeServer || !channelName.trim()) return;
    try {
      const { channel: nextChannel } = await createChannel(activeServer.id, channelName, channelType, activeServer.categories?.some((category) => category.id === channelCategoryId) ? channelCategoryId : null);
      setActiveServer((current) => ({ ...current, channels: [...(current.channels || []), nextChannel] }));
      setActiveChannelId(nextChannel.id);
      setChannelName('');
      setChannelType('text');
      setChannelCategoryId(null);
      setDialogError('');
      setShowCreateChannel(false);
      setMobileChatOpen(true);
    } catch (error) { setDialogError(error.message); }
  };

  const submitRole = async (event) => {
    event.preventDefault();
    if (!activeServer || !roleName.trim() || !canManageRoles) return;
    try {
      const { role } = await createRole(activeServer.id, { name: roleName, color: roleColor, permissions: rolePermissions, permissionFlags: roleFlags });
      setActiveServer((current) => ({ ...current, roles: sortServerRoles([...(current.roles || []), role]) }));
      setRoleName('');
      setRolePermissions('moderator');
      setNotice(`Added the ${role.name} role.`);
    } catch (error) { setNotice(error.message); }
  };

  const beginRoleEdit = (role) => {
    setEditingRoleId(role.id);
    setEditRoleName(role.name);
    setEditRoleColor(role.color);
    setEditRolePermissions(role.permissions);
    setEditRoleFlags(role.permissionFlags || []);
  };

  const cancelRoleEdit = () => {
    setEditingRoleId(null);
    setEditRoleName('');
  };

  const submitRoleEdit = async (event, role) => {
    event.preventDefault();
    if (!activeServer || !editRoleName.trim() || !canManageRoles) return;
    try {
      const payload = role.permissions === 'owner'
        ? { name: editRoleName }
        : { name: editRoleName, color: editRoleColor, permissions: editRolePermissions, permissionFlags: editRoleFlags };
      const { role: updated } = await updateRole(activeServer.id, role.id, payload);
      setActiveServer((current) => ({
        ...current,
        roles: sortServerRoles(current.roles.map((item) => item.id === role.id ? updated : item)),
        members: current.members.map((member) => member.roleId === role.id ? { ...member, roleName: updated.name, roleColor: updated.color, permissions: updated.permissions, permissionFlags: updated.permissionFlags } : member),
        membership: current.membership?.roleId === role.id ? { ...current.membership, roleName: updated.name, permissions: updated.permissions, permissionFlags: updated.permissionFlags } : current.membership,
      }));
      cancelRoleEdit();
      setNotice(role.permissions === 'owner' ? `Renamed the Owner role to ${updated.name}.` : `Updated the ${updated.name} role.`);
    } catch (error) { setNotice(error.message); }
  };

  const removeRole = async (role) => {
    if (!activeServer || !canManageRoles || !role || role.permissions === 'owner' || role.name === 'Member') return;
    if (!window.confirm(`Delete the ${role.name} role? Members will become Members.`)) return;
    try {
      await deleteRole(activeServer.id, role.id);
      const memberRole = activeServer.roles.find((item) => item.permissions === 'member');
      setActiveServer((current) => ({
        ...current,
        roles: current.roles.filter((item) => item.id !== role.id),
        members: current.members.map((member) => member.roleId === role.id && memberRole ? { ...member, roleId: memberRole.id, roleName: memberRole.name, roleColor: memberRole.color, permissions: memberRole.permissions } : member),
      }));
      if (editingRoleId === role.id) cancelRoleEdit();
      setNotice(`Deleted the ${role.name} role.`);
    } catch (error) { setNotice(error.message); }
  };

  const changeMemberRole = async (memberId, roleId, selectedMember = null) => {
    if (!activeServer || !roleId) return false;
    const normalizedMemberId = Number(memberId);
    const target = Number(selectedMember?.id) === normalizedMemberId
      ? selectedMember
      : activeServer.members?.find((member) => Number(member.id) === normalizedMemberId);
    const role = activeServer.roles?.find((item) => Number(item.id) === Number(roleId));
    if (!target || !role || target.permissions === 'owner' || role.permissions === 'owner') return false;
    if (Number(target.roleId) === Number(role.id)) return true;
    if (!isOwner && (target.permissions === 'moderator' || role.permissions === 'moderator')) {
      setNotice('Only the server owner can manage moderator roles.');
      return false;
    }
    try {
      await assignMemberRole(activeServer.id, memberId, role.id);
      setActiveServer((current) => {
        if (!current || Number(current.id) !== Number(activeServer.id)) return current;
        const members = current.members || [];
        const targetIsLoaded = members.some((member) => Number(member.id) === normalizedMemberId);
        const memberCounts = { ...(current.memberCounts || {}) };
        const previousRoleId = String(target.roleId);
        const nextRoleId = String(role.id);
        if (previousRoleId !== nextRoleId) {
          memberCounts[previousRoleId] = Math.max(0, Number(memberCounts[previousRoleId] || 0) - 1);
          memberCounts[nextRoleId] = Number(memberCounts[nextRoleId] || 0) + 1;
        }
        return {
          ...current,
          memberCounts,
          members: targetIsLoaded ? members.map((member) => Number(member.id) === normalizedMemberId
            ? { ...member, roleId: role.id, roleName: role.name, roleColor: role.color, permissions: role.permissions, permissionFlags: role.permissionFlags || [] }
            : member) : members,
        };
      });
      setNotice(`${target.username} is now ${role.name}.`);
      return true;
    } catch (error) {
      setNotice(error.message);
      return false;
    }
  };

  const reorderServerRoles = async (roles) => {
    if (!activeServer || !canManageRoles) return;
    const roleIds = roles.map((role) => Number(role.id));
    try {
      const response = await reorderRoles(activeServer.id, roleIds);
      if (!Array.isArray(response.roles)) throw new Error('The updated role order was invalid. Try again.');
      setActiveServer((current) => (current ? { ...current, roles: sortServerRoles(response.roles) } : current));
      setNotice('Role order saved.');
    } catch (error) { setNotice(error.message); }
  };

  const moderate = async (member, action) => {
    if (!activeServer || !member || !canManageMembers) return false;
    const verb = action === 'ban' ? 'ban' : 'kick';
    if (!window.confirm(`${verb[0].toUpperCase()}${verb.slice(1)} ${member.username} from ${activeServer.name}?`)) return false;
    try {
      await moderateMember(activeServer.id, member.id, action);
      setActiveServer((current) => {
        if (!current || Number(current.id) !== Number(activeServer.id)) return current;
        const members = current.members || [];
        const wasLoaded = members.some((item) => Number(item.id) === Number(member.id));
        const memberCounts = { ...(current.memberCounts || {}) };
        const roleKey = String(member.roleId ?? '');
        if (roleKey && Object.hasOwn(memberCounts, roleKey)) memberCounts[roleKey] = Math.max(0, Number(memberCounts[roleKey]) - 1);
        const nextMembers = members.filter((item) => Number(item.id) !== Number(member.id));
        return {
          ...current,
          memberTotal: Math.max(0, Number(current.memberTotal ?? members.length) - 1),
          memberCounts,
          members: nextMembers,
          membersPage: {
            ...(current.membersPage || {}),
            nextOffset: Math.max(0, Number(current.membersPage?.nextOffset ?? members.length) - (wasLoaded ? 1 : 0)),
          },
        };
      });
      if ((activeServer.members || []).some((item) => Number(item.id) === Number(member.id))) {
        setMembersNextOffset((current) => Math.max(0, current - 1));
      }
      setNotice(`${member.username} was ${verb}ed.`);
      return true;
    } catch (error) {
      setNotice(error.message);
      return false;
    }
  };

  const deviceBan = async (member) => {
    if (!activeServer || !member || !canManageMembers) return false;
    const confirmed = window.confirm(
      `Ban the known Glean installation(s) used by ${member.username} from ${activeServer.name}? Accounts using those installations will be removed and blocked from rejoining. People sharing the same browser installation may also be affected.`,
    );
    if (!confirmed) return false;
    try {
      const { deviceCount, removedMembers = [] } = await banMemberDevice(activeServer.id, member.id);
      const removedIds = new Set(removedMembers.map((item) => Number(item.userId)));
      let loadedRemoved = 0;
      setActiveServer((current) => {
        if (!current || Number(current.id) !== Number(activeServer.id)) return current;
        const members = current.members || [];
        loadedRemoved = members.filter((item) => removedIds.has(Number(item.id))).length;
        const memberCounts = { ...(current.memberCounts || {}) };
        removedMembers.forEach((item) => {
          const roleKey = String(item.roleId ?? '');
          if (roleKey && Object.hasOwn(memberCounts, roleKey)) memberCounts[roleKey] = Math.max(0, Number(memberCounts[roleKey]) - 1);
        });
        return {
          ...current,
          memberTotal: Math.max(0, Number(current.memberTotal ?? members.length) - removedMembers.length),
          memberCounts,
          members: members.filter((item) => !removedIds.has(Number(item.id))),
          membersPage: { ...(current.membersPage || {}), nextOffset: Math.max(0, Number(current.membersPage?.nextOffset ?? members.length) - loadedRemoved) },
        };
      });
      setMembersNextOffset((current) => Math.max(0, current - loadedRemoved));
      setModerationMenu(null);
      setNotice(`${member.username}'s ${deviceCount} known installation${deviceCount === 1 ? '' : 's'} banned. ${removedMembers.length} linked account${removedMembers.length === 1 ? '' : 's'} removed.`);
      return true;
    } catch (error) {
      setNotice(error.message || 'Could not ban this installation.');
      return false;
    }
  };

  const timeout = async (member, seconds) => {
    if (!activeServer || !member || !canManageMembers) return { ok: false };
    try {
      const { timeoutUntil: until } = await timeoutMember(activeServer.id, member.id, { seconds });
      setActiveServer((current) => ({
        ...current,
        members: (current.members || []).map((item) => Number(item.id) === Number(member.id) ? { ...item, timeoutUntil: until || null } : item),
      }));
      setNotice(until ? `${member.username} is timed out.` : `Timeout removed from ${member.username}.`);
      return { ok: true, timeoutUntil: until || null };
    } catch (error) {
      setNotice(error.message);
      return { ok: false };
    }
  };

  const openModerationMenu = useCallback((event, member, voice = false) => {
    if (!activeServer) return;
    const self = Number(member?.id) === Number(account?.id);
    const canAct = voice ? (self || canManageMembers || canManageVoice) : canManageMembers && !self;
    if (!canAct) return;
    event.preventDefault();
    event.stopPropagation();
    setModerationMenu({ x: event.clientX, y: event.clientY, member, voice, self });
  }, [activeServer?.id, account?.id, canManageMembers, canManageVoice]);
  const openMemberModerationMenu = useCallback((event, member) => {
    const loadedMember = activeServer?.members?.find((item) => Number(item.id) === Number(member?.id));
    const target = loadedMember ? { ...loadedMember, ...member, timeoutUntil: loadedMember.timeoutUntil || member?.timeoutUntil || null } : member;
    openModerationMenu(event, target);
  }, [activeServer?.members, openModerationMenu]);
  const openVoiceModerationMenu = useCallback((event, member) => openModerationMenu(event, member, true), [openModerationMenu]);

  const disconnectVoice = async (member) => {
    if (!activeServer || !member) return;
    try {
      await disconnectVoiceMember(activeServer.id, member.id);
      setNotice(`${member.username} was disconnected from voice.`);
      setModerationMenu(null);
    } catch (error) { setNotice(error.message); }
  };

  const submitMessage = async (event, { draft, attachments, poll, setDraft, setAttachments, setPoll }) => {
    event.preventDefault();
    if (!channel || inspecting || postLock || isSending || sendingRef.current) return;
    const pollPayload = normalizePoll(poll);
    if (poll && !pollPayload) {
      setNotice('Polls need 2–10 options.');
      return;
    }
    if (!draft.trim() && !attachments.length && !pollPayload) return;
    if (attachments.length > 10) {
      setNotice('You can attach up to 10 files.');
      return;
    }
    const totalSize = attachments.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (totalSize > 250 * 1024 * 1024 || attachments.some((file) => Number(file.size || 0) > 100 * 1024 * 1024)) {
      setNotice('Each attachment and the total message can be up to 2 GB.');
      return;
    }
    sendingRef.current = true;
    setIsSending(true);
    const pendingId = -Date.now();
    const pendingMessage = {
      id: pendingId,
      body: draft,
      createdAt: new Date().toISOString(),
      editedAt: null,
      replyTo: replyTo ? {
        id: Number(replyTo.id),
        username: replyTo.author?.username || 'Unknown',
        deleted: false,
        body: String(replyTo.body || ''),
      } : null,
      author: { id: Number(account.id), username: account.username, avatarUrl: account.avatarUrl || null, nameStyle: account.nameStyle || null },
      attachments: [],
      reactions: [],
      poll: pollPayload ? {
        question: pollPayload.question,
        options: pollPayload.options.map((text, index) => ({ index, text, votes: 0, voted: false })),
        allowMultiple: Boolean(pollPayload.allowMultiple),
        closed: false,
        voterCount: 0,
      } : null,
      status: 'sending',
    };
    setMessages((current) => [...current, pendingMessage]);
    const messageDraft = draft;
    const files = attachments;
    const replyId = replyTo?.id || null;
    const sentPoll = pollPayload;
    setDraft('');
    setAttachments([]);
    setPoll?.(null);
    setReplyTo(null);
    try {
      const { message, moderationAction, channel: updatedChannel } = await sendChannelMessage(channel.id, messageDraft, files, replyId, sentPoll);
      setMessages((current) => message
        ? upsertChannelMessage(current.filter((item) => messageId(item) !== pendingId), message)
        : current.filter((item) => messageId(item) !== pendingId));
      if (updatedChannel) applyChannelPatch(updatedChannel);
      if (moderationAction === 'flag') setNotice('Your message was sent and flagged for moderator review.');
      else if (moderationAction === 'warn') setNotice('Your message was sent. Please keep server rules in mind.');
    } catch (error) {
      setMessages((current) => current.filter((item) => messageId(item) !== pendingId));
      setDraft(messageDraft);
      setAttachments(files);
      if (sentPoll) setPoll?.(sentPoll);
      setNotice(error.message);
    }
    finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  };

  const beginEdit = (message) => {
    setEditingMessageId(messageId(message));
    setEditDraft(message.body);
    setReactionPickerId(null);
    setReplyTo(null);
  };

  const beginReply = (message) => {
    if (inspecting || postLock || !Number.isFinite(messageId(message))) return;
    setReplyTo(message);
    setEditingMessageId(null);
    setReactionPickerId(null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const cancelEdit = () => {
    setEditingMessageId(null);
    setEditDraft('');
  };

  const submitEdit = async (event, message) => {
    event.preventDefault();
    if (!channel || (!editDraft.trim() && !message.attachments?.length)) return;
    try {
      const { message: updated, moderationAction } = await editChannelMessage(channel.id, message.id, editDraft);
      setMessages((current) => upsertChannelMessage(current, updated));
      if (moderationAction === 'flag') setNotice('Your edit was sent and flagged for moderator review.');
      else if (moderationAction === 'warn') setNotice('Your edit was sent. Please keep server rules in mind.');
      cancelEdit();
    } catch (error) { setNotice(error.message); }
  };

  const toggleReaction = async (message, emoji) => {
    if (!channel || inspecting) return;
    try {
      const { message: updated } = await reactToChannelMessage(channel.id, message.id, emoji);
      setMessages((current) => upsertChannelMessage(current, updated));
    } catch (error) { setNotice(error.message); }
  };

  const votePoll = async (message, optionIndex) => {
    if (!channel || inspecting || !Number.isFinite(messageId(message))) return;
    try {
      const { message: updated } = await voteChannelPoll(channel.id, message.id, optionIndex);
      setMessages((current) => upsertChannelMessage(current, updated));
    } catch (error) { setNotice(error.message); }
  };

  const closePoll = async (message) => {
    if (!channel || inspecting || !Number.isFinite(messageId(message))) return;
    try {
      const { message: updated } = await closeChannelPoll(channel.id, message.id);
      setMessages((current) => upsertChannelMessage(current, updated));
    } catch (error) { setNotice(error.message); }
  };

  const deleteMessage = async (message) => {
    const canDelete = Number(message.author?.id) === Number(account?.id) || hasManageMessagesPermission;
    if (!channel || !canDelete || !window.confirm('Delete this message?')) return;
    try {
      await removeChannelMessage(channel.id, message.id);
      setMessages((current) => current.filter((item) => messageId(item) !== messageId(message)));
    } catch (error) { setNotice(error.message); }
  };

  const muteServer = async (server, muted) => {
    try {
      await setServerMuted(server.id, muted);
      try {
        if (muted) window.localStorage.setItem(mutedServerStorageKey(server.id), '1');
        else window.localStorage.removeItem(mutedServerStorageKey(server.id));
      } catch { /* server preference remains authoritative */ }
      setServers((current) => current.map((item) => Number(item.id) === Number(server.id)
        ? { ...item, muted, unread: false, unreadCount: 0, mentionCount: 0 }
        : item));
      setActiveServer((current) => current && Number(current.id) === Number(server.id)
        ? { ...current, muted, unread: false, unreadCount: 0, mentionCount: 0, channels: current.channels?.map((item) => ({ ...item, unreadCount: 0, mentionCount: 0 })) }
        : current);
    } catch (error) { setNotice(error.message || 'Could not change server notifications.'); }
  };

  const voiceSessionActive = Boolean(voiceStream && voiceCall && liveChannel);
  const voiceRoomChannel = voiceSessionActive ? liveChannel : channel;
  const voiceRoomServerId = voiceSessionActive ? voiceCall.serverId : activeServer?.id;
  const voiceRoomOccupants = voiceSessionActive
    ? occupantsOf(voiceCallOccupancy, liveChannel.id)
    : occupantsOf(voiceOccupancy, channel?.id);
  const voiceRoomStashed = Boolean(
    voiceSessionActive
    && (Number(activeServer?.id) !== Number(voiceCall.serverId)
      || !channel?.voice
      || Number(channel.id) !== Number(liveChannel.id)),
  );

  return (
    <main className={`community-app community-workspace${mobileChatOpen ? ' mobile-chat-open' : ''}${voiceSessionActive ? ' has-voice' : ''}${membersVisible ? ' members-visible' : ' members-hidden'}`} aria-label="Glean servers">
      <AppRail
        account={account}
        servers={servers}
        activeServerId={activeServer?.id}
        homeBadge={homeUnread}
        isLoading={isLoadingServers}
        onHome={() => goTo('app')}
        onDiscover={() => {
          try { sessionStorage.setItem('glean.dmView', 'discover'); } catch { /* ignore */ }
          goTo('app');
        }}
        onOpenServer={selectServer}
        onAddServer={() => { setDialogError(''); setShowAddServer(true); }}
        onReorder={persistServerOrder}
        onInviteServer={inviteFromServerRail}
        onLeaveServer={leaveFromServerRail}
        onMuteServer={muteServer}
      />

      <aside className="community-channel-sidebar" aria-label="Server channels">
        <header ref={menuRef}>
          {activeServer ? <ServerIcon server={activeServer} /> : null}
          <strong>{activeServer?.name || 'Your servers'}</strong>
          {activeServer ? (
            <button type="button" className={showServerMenu ? 'is-open' : ''} onClick={() => setShowServerMenu((open) => !open)} aria-label="Server menu" aria-expanded={showServerMenu}><MoreIcon /></button>
          ) : null}
          {showServerMenu && activeServer ? (
            <div className="community-server-menu" role="menu">
              {canManageInvites ? <button type="button" role="menuitem" onClick={() => openSettings('invites')}><UserIcon size={16} /> Invite people</button> : null}
              <button type="button" role="menuitem" onClick={() => openSettings()}><SettingsIcon /> Server settings</button>
              <div className="community-server-menu-sep" />
              {isOwner ? <button type="button" className="is-danger" role="menuitem" onClick={removeCurrentServer}><TrashIcon /> Delete server</button> : inspecting ? null : <button type="button" className="is-danger" role="menuitem" onClick={leaveCurrentServer}><LeaveIcon /> Leave server</button>}
            </div>
          ) : null}
        </header>
        {activeServer ? (
          <>
            {inspecting ? <p className="community-inspect-banner">Inspecting · not a member</p> : null}
            <div className="community-channel-lists">
              {activeServer.categories?.length ? <>
                <div className="community-channel-heading"><p className="community-label">Channels</p>{canManageChannels ? <button type="button" onClick={() => { setDialogError(''); setShowCreateChannel(true); }} aria-label="Create channel">+</button> : null}</div>
                <ServerChannelCategories key={activeServer.id} server={activeServer} activeChannel={channel} voiceLiveId={voiceLiveId} liveApps={liveApps} voiceOccupancy={voiceOccupancy} accountId={account.id} canManage={canManageChannels} inspecting={inspecting} onSelect={selectChannel} onRemove={removeCurrentChannel} onContextMenu={openModerationMenu} onReorder={persistCategoryChannelOrder} />
              </> : <>
              <div className="community-channel-heading"><p className="community-label">Text channels</p>{canManageChannels ? <button type="button" onClick={() => { setDialogError(''); setShowCreateChannel(true); }} aria-label="Create channel" title="Create channel">+</button> : null}</div>
              <div className={`community-channel-list${textReorder.isDragging ? ' is-reordering' : ''}`} data-reorder-list="text">
                {textReorder.items.map((item) => (
                  <div
                    className={`community-channel-row${textChannels.length > 1 && !inspecting ? ' is-reorderable' : ''}${String(textReorder.draggingId) === String(item.id) ? ' is-dragging' : ''}`}
                    key={item.id}
                    {...textReorder.bind(item.id)}
                  >
                    <button className={`community-channel${channel?.id === item.id ? ' is-active' : ''}${item.unreadCount || item.mentionCount ? ' is-unread' : ''}`} type="button" aria-current={channel?.id === item.id ? 'page' : undefined} onClick={() => selectChannel(item.id)}>
                      <ChannelGlyph kind={item.kind} /><span>{item.name}</span>
                      {item.locked ? <LockIcon /> : null}
                      {item.mentionCount ? <b className="channel-unread-count">{formatUnreadCount(item.mentionCount)}</b> : item.unreadCount ? <b className="channel-unread-count">{formatUnreadCount(item.unreadCount)}</b> : null}
                    </button>
                    {canManageChannels && item.name !== 'general' ? <button className="community-channel-delete" type="button" data-no-reorder onClick={() => removeCurrentChannel(item)} aria-label={`Delete ${item.name} channel`} title="Delete channel"><TrashIcon /></button> : null}
                  </div>
                ))}
              </div>
              <p className="community-label">Voice channels</p>
              <div className={`community-channel-list${voiceReorder.isDragging ? ' is-reordering' : ''}`} data-reorder-list="voice">
                {voiceReorder.items.map((item) => (
                  <div
                    className={`community-voice-block${voiceChannels.length > 1 && !inspecting ? ' is-reorderable' : ''}${String(voiceReorder.draggingId) === String(item.id) ? ' is-dragging' : ''}`}
                    key={item.id}
                    {...voiceReorder.bind(item.id)}
                  >
                    <div className="community-channel-row">
                      <button className={`community-channel${channel?.id === item.id ? ' is-active' : ''}${Number(voiceLiveId) === Number(item.id) ? ' is-connected' : ''}`} type="button" onClick={() => selectChannel(item.id)}>
                        <SpeakerIcon /><span>{item.name}</span>
                        {liveApps[String(item.id)] ? <b className="community-channel-app" title={`${liveApps[String(item.id)].appName} is live`}>{liveApps[String(item.id)].appName}</b> : null}
                      </button>
                      {canManageChannels ? <button className="community-channel-delete" type="button" data-no-reorder onClick={() => removeCurrentChannel(item)} aria-label={`Delete ${item.name} channel`} title="Delete channel"><TrashIcon /></button> : null}
                    </div>
                    <div className="community-voice-occupants" data-no-reorder>
                      {occupantsOf(voiceOccupancy, item.id).map((user) => (
                        <VoiceOccupantRow key={user.id} user={user} selfId={account.id} onContextMenu={(event, member) => openModerationMenu(event, member, true)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              </>}
            </div>
            {showCreateChannel && activeServer ? <CreateChannelDialog serverName={activeServer.name} channelName={channelName} channelType={channelType} categories={activeServer.categories} categoryId={channelCategoryId} error={dialogError} onNameChange={setChannelName} onTypeChange={setChannelType} onCategoryChange={setChannelCategoryId} onCreate={submitChannel} onClose={() => { setDialogError(''); setShowCreateChannel(false); }} /> : null}
          </>
        ) : (
          <div className="community-empty">
            <p>No servers yet.</p>
            <button type="button" className="community-dialog-primary" onClick={() => setShowAddServer(true)}>Add a server</button>
          </div>
        )}
        <div className="community-sidebar-footer">
          <div data-voice-dock-host />
          {voiceSessionActive ? (
            <VoiceDock
              channel={liveChannel}
              muted={voiceFlags.muted}
              deafened={voiceFlags.deafened}
              camera={voiceFlags.camera}
              sharing={voiceFlags.sharing}
              onMute={() => voiceApiRef.current?.toggleMute()}
              onDeafen={() => voiceApiRef.current?.toggleDeafen()}
              onCamera={() => voiceApiRef.current?.toggleCamera()}
              onShare={() => voiceApiRef.current?.toggleShare()}
              onDisconnect={() => voiceApiRef.current?.hangUp() || leaveVoice()}
            />
          ) : null}
          <AccountChrome account={account} onAccountUpdated={onAccountUpdated} onSignedOut={onSignedOut} />
        </div>
      </aside>

      <section className={`community-chat${channel?.voice ? ' is-voice-chat' : ''}`} aria-label={channel ? `${channel.voice ? 'Voice' : '#'} ${channel.name}` : 'Server chat'}>
        {notice ? <p className="community-notice" role="status">{notice}</p> : null}
        {channel?.voice || voiceSessionActive ? (
          <VoiceRoom
            serverId={voiceRoomServerId}
            channel={voiceRoomChannel}
            account={account}
            realtime={realtimeConnection}
            stream={voiceSessionActive ? voiceStream : null}
            occupants={voiceRoomOccupants}
            stashed={voiceRoomStashed}
            joining={voiceJoining}
            apiRef={voiceApiRef}
            onHangUp={leaveVoice}
            onNeedMic={requestMic}
            onStateChange={setVoiceFlags}
          />
        ) : null}
        {!channel?.voice ? <>
        <ServerChannelHeader
          server={activeServer} channel={channel} inspecting={inspecting} membersVisible={membersVisible}
          onBack={() => { setMobileChatOpen(false); setMembersVisible(false); }}
          onToggleMembers={() => {
            setMembersVisible(visible => !visible);
            if (!membersVisible && window.matchMedia('(max-width: 1100px)').matches) window.requestAnimationFrame(() => document.getElementById('server-members-close')?.focus({ preventScroll: true }));
          }}
          onSettings={() => openSettings()}
        />
        <div className="community-transcript-region">
        <div className="community-messages" aria-live="polite" aria-busy={isLoadingMessages || isLoadingOlder} ref={messageScrollRef}>
          <ChannelTranscript
            messages={visibleMessages}
            isLoading={isLoadingMessages}
            loadError={messagesError}
            onRetry={() => setMessageHistoryRetry((value) => value + 1)}
            hasMore={hasMoreMessages}
            isLoadingOlder={isLoadingOlder}
            onLoadOlder={loadOlderMessages}
            activeServer={activeServer}
            channel={channel}
            account={account}
            mentionUsers={mentionUsers}
            canModerate={hasManageMessagesPermission}
            canPost={!postLock}
            inspecting={inspecting}
            editingMessageId={editingMessageId}
            editDraft={editDraft}
            reactionPickerId={reactionPickerId}
            onOpenAuthor={open}
            onModerationContextMenu={openMemberModerationMenu}
            onReply={beginReply}
            onEdit={beginEdit}
            onDelete={deleteMessage}
            onEditDraft={setEditDraft}
            onSubmitEdit={submitEdit}
            onCancelEdit={cancelEdit}
            onToggleReaction={toggleReaction}
            onOpenReactions={setReactionPickerId}
            onVotePoll={votePoll}
            onClosePoll={closePoll}
          />
        </div>
        {!atBottom && channel && !isLoadingMessages ? <button type="button" className="community-jump-latest" onClick={jumpToBottom}>{hasNewMessages ? 'New messages' : 'Back to latest'}</button> : null}
        </div>
        <div className="community-compose-dock">
        {inspecting ? (
          <div className="community-inspect-note">Read-only inspect. You can moderate, but you are not in this server.</div>
        ) : postLock ? (
          <div className="community-composer-lock">{postLock}</div>
        ) : (
        <IsolatedMessageComposer
          resetKey={channel?.id || 'none'}
          onSend={submitMessage}
          allowPolls
          placeholder={channel ? `${channel.slowmode && !canPostStaff ? `Slowmode ${formatSlowmode(channel.slowmode)} · ` : ''}Message #${channel.name}` : 'Select a channel to chat'}
          commandBots={activeServer?.bots || []}
          disabled={!channel}
          isSending={isSending}
          maxLength={4000}
          mentionUsers={mentionUsers}
          composerRef={composerRef}
          accessibility={account?.accessibility}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          onTyping={updateChannelTyping}
          typingText={typingStatusText(Object.values(typingByChannel[Number(channel?.id)] || {}).filter((item) => item.expiresAt > Date.now()).map((item) => item.name))}
        />
        )}
        </div>
        </> : null}</section>

      {membersVisible ? <button type="button" className="community-members-scrim" aria-label="Close members panel" onClick={closeMembers} /> : null}
      <CommunityMemberSidebar
        key={activeServer?.id || 'no-server'}
        serverId={activeServer?.id}
        groups={memberGroups}
        voicePeople={voicePeople}
        accountId={account?.id}
        loading={membersLoading}
        hasMore={membersHasMore}
        scrollRef={memberScrollRef}
        sentinelRef={memberLoadSentinelRef}
        onOpen={open}
        onMemberContextMenu={openMemberModerationMenu}
        onVoiceContextMenu={openVoiceModerationMenu}
        onClose={closeMembers}
      />

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
      {showSettings && activeServer ? (
        <ServerSettingsModal
          server={activeServer}
          tab={settingsTab}
          startOnPage={settingsStartPage}
          onTabChange={setSettingsTab}
          canModerate={canViewAuditLog}
          canManageMessages={hasManageMessagesPermission}
          canManageRoles={canManageRoles}
          canManageChannels={canManageChannels}
          canManageMembers={canManageMembers}
          canManageInvites={canManageInvites}
          isOwner={isOwner}
          canUseModel={Boolean(account?.id && (Number(activeServer.ownerId) === Number(account.id) || (account.platformAdmin && String(account.username).toLowerCase() === 'nuper')))}
          accountId={account?.id}
          roleName={roleName}
          roleColor={roleColor}
          rolePermissions={rolePermissions}
          roleFlags={roleFlags}
          onRoleFlagsChange={setRoleFlags}
          onRoleNameChange={setRoleName}
          onRoleColorChange={setRoleColor}
          onRolePermissionsChange={setRolePermissions}
          onCreateRole={submitRole}
          editingRoleId={editingRoleId}
          editRoleName={editRoleName}
          editRoleColor={editRoleColor}
          editRolePermissions={editRolePermissions}
          editRoleFlags={editRoleFlags}
          onEditRoleFlagsChange={setEditRoleFlags}
          onEditRoleNameChange={setEditRoleName}
          onEditRoleColorChange={setEditRoleColor}
          onEditRolePermissionsChange={setEditRolePermissions}
          onBeginRoleEdit={beginRoleEdit}
          onCancelRoleEdit={cancelRoleEdit}
          onSubmitRoleEdit={submitRoleEdit}
          onRemoveRole={removeRole}
          onReorderRoles={reorderServerRoles}
          onChangeMemberRole={changeMemberRole}
          onModerate={moderate}
          onTimeout={timeout}
          onChannelUpdated={applyChannelPatch}
          onLeave={leaveCurrentServer}
          onDelete={removeCurrentServer}
          onServerUpdated={applyServerPatch}
          onNotice={setNotice}
          onClose={closeSettings}
        />
      ) : null}
      {moderationMenu ? (
        <div ref={moderationMenuRef} className="community-moderation-menu" style={{ left: moderationMenu.x, top: moderationMenu.y }} role="menu" onMouseDown={(event) => event.stopPropagation()}>
          {!moderationMenu.self && canManageMembers ? <button type="button" role="menuitem" onClick={() => { setModerationMenu(null); moderate(moderationMenu.member, 'kick'); }}>Kick</button> : null}
          {!moderationMenu.self && canManageMembers ? <button type="button" role="menuitem" className="is-danger" onClick={() => { setModerationMenu(null); moderate(moderationMenu.member, 'ban'); }}>Ban</button> : null}
          {!moderationMenu.voice && !moderationMenu.self && canManageMembers ? <button type="button" role="menuitem" className="is-danger" onClick={() => { setModerationMenu(null); void deviceBan(moderationMenu.member); }}>Ban device</button> : null}
          {!moderationMenu.voice && canManageMembers && moderationMenu.member.timeoutUntil && Date.parse(moderationMenu.member.timeoutUntil) > Date.now() ? <button type="button" role="menuitem" onClick={() => { setModerationMenu(null); timeout(moderationMenu.member, 0); }}>Remove timeout</button> : null}
          {!moderationMenu.voice && canManageMembers && !(moderationMenu.member.timeoutUntil && Date.parse(moderationMenu.member.timeoutUntil) > Date.now()) ? <button type="button" role="menuitem" onClick={() => { setModerationMenu(null); timeout(moderationMenu.member, 600); }}>Timeout (10 minutes)</button> : null}
          {moderationMenu.voice && moderationMenu.self ? <button type="button" role="menuitem" onClick={() => { setModerationMenu(null); leaveVoice(); setNotice('You disconnected from voice.'); }}>Disconnect from call</button> : null}
          {moderationMenu.voice && !moderationMenu.self && canPermission('manageVoice') ? <button type="button" role="menuitem" onClick={() => disconnectVoice(moderationMenu.member)}>Disconnect</button> : null}
        </div>
      ) : null}
    </main>
  );
}
