import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createServerInvite,
  getFriends,
  getServerMembers,
  getServerBans,
  getServerAuditLog,
  getServerInvites,
  removeServerIcon,
  revokeServerInvite,
  sendServerInvite,
  unbanServerMember,
  updateChannel,
  clearServerChannelMessages,
  updateServerChannelMessageCleanup,
  updateServer,
  updateServerBanner,
  updateServerIcon,
} from '../../app/dmApi';
import { inviteUrl } from '../../app/invite';
import AvatarCropEditor from '../dm/AvatarCropEditor';
import BannerEditor from '../dm/BannerEditor';
import { bannerStyle } from '../dm/banner';
import { formatJoinedDate } from '../dm/formatters';
import { CloseIcon, CopyIcon, EditIcon, TrashIcon } from '../dm/icons';
import { CommunityAvatar, ServerIcon } from './CommunityAvatar';
import { ServerInvitePreview } from './ServerInviteCard';
import useHoldReorder from './useHoldReorder';

const ICON_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const EXPIRY_OPTIONS = [
  { label: '1 hour', hours: 1 },
  { label: '6 hours', hours: 6 },
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 168 },
];
const USE_OPTIONS = [
  { label: 'No limit', value: 0 },
  { label: '1 use', value: 1 },
  { label: '5 uses', value: 5 },
  { label: '10 uses', value: 10 },
  { label: '25 uses', value: 25 },
  { label: '50 uses', value: 50 },
];
const SLOWMODE_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '5 seconds', value: 5 },
  { label: '10 seconds', value: 10 },
  { label: '15 seconds', value: 15 },
  { label: '30 seconds', value: 30 },
  { label: '1 minute', value: 60 },
  { label: '2 minutes', value: 120 },
  { label: '5 minutes', value: 300 },
  { label: '10 minutes', value: 600 },
  { label: '15 minutes', value: 900 },
  { label: '30 minutes', value: 1800 },
  { label: '1 hour', value: 3600 },
];
const TIMEOUT_OPTIONS = [
  { label: 'Timeout', value: '' },
  { label: '60 seconds', value: 60 },
  { label: '5 minutes', value: 300 },
  { label: '10 minutes', value: 600 },
  { label: '1 hour', value: 3600 },
  { label: '6 hours', value: 21600 },
  { label: '1 day', value: 86400 },
  { label: '1 week', value: 604800 },
  { label: 'Remove timeout', value: 0 },
];
const MODERATOR_PERMISSION_OPTIONS = [
  ['manageChannels', 'Manage channels'],
  ['manageMessages', 'Manage messages and polls'],
  ['manageMembers', 'Manage members and bans'],
  ['manageInvites', 'Manage invites'],
  ['postStaff', 'Post in staff channels and bypass slowmode'],
  ['manageApps', 'Manage voice apps'],
  ['manageVoice', 'Disconnect voice members'],
  ['manageRoles', 'Manage roles'],
  ['manageServer', 'Manage server settings'],
  ['viewAuditLog', 'View audit log'],
];
function ModeratorFlags({ value, onChange }) {
  return <fieldset className="community-role-permissions"><legend>Moderator permissions</legend>{MODERATOR_PERMISSION_OPTIONS.map(([flag, label]) => <label key={flag}><input type="checkbox" checked={value.includes(flag)} onChange={(event) => onChange(event.target.checked ? [...value, flag] : value.filter((item) => item !== flag))} />{label}</label>)}</fieldset>;
}

function channelKindOf(channel) {
  if (channel?.kind === 'announcement' || channel?.kind === 'rules') return channel.kind;
  const name = String(channel?.name || '').toLowerCase();
  if (name === 'announcement' || name === 'announcements') return 'announcement';
  if (name === 'rules') return 'rules';
  return 'text';
}

function ChannelModerationCard({ serverId, channel, busy, onPatch, canManageChannels, canManageMessages, onChannelUpdated, onNotice }) {
  const [topic, setTopic] = useState(channel.topic || '');
  const [cleanupBusy, setCleanupBusy] = useState(false);
  useEffect(() => {
    setTopic(channel.topic || '');
  }, [channel.id, channel.topic]);
  const kind = channelKindOf(channel);
  const staffKind = kind !== 'text';
  if (channel.voice) {
    return (
      <div className="community-settings-channel-card">
        <strong>{channel.name}</strong>
        <p>Voice channel. Posting locks do not apply.</p>
      </div>
    );
  }
  return (
    <div className="community-settings-channel-card">
      <strong>#{channel.name}</strong>
      <div className="community-settings-channel-grid">
        <label className="community-settings-field">
          <span>Type</span>
          <select value={kind} disabled={busy || !canManageChannels} onChange={(event) => onPatch(channel.id, { channelKind: event.target.value })} aria-label={`${channel.name} type`}>
            <option value="text">Text</option>
            <option value="announcement">Announcements</option>
            <option value="rules">Rules</option>
          </select>
        </label>
        <label className="community-settings-field">
          <span>Posting</span>
          <select
            value={channel.locked || staffKind ? 'locked' : 'open'}
            disabled={busy || !canManageChannels || staffKind}
            onChange={(event) => onPatch(channel.id, { locked: event.target.value === 'locked' })}
            aria-label={`${channel.name} posting`}
          >
            <option value="open">Anyone</option>
            <option value="locked">Mods only</option>
          </select>
        </label>
      </div>
      <label className="community-settings-field">
        <span>Topic</span>
        <input
          value={topic}
          maxLength="200"
          disabled={busy || !canManageChannels}
          onChange={(event) => setTopic(event.target.value)}
          onBlur={() => { if (topic !== (channel.topic || '')) onPatch(channel.id, { topic }); }}
          placeholder="What is this channel for?"
        />
      </label>
      <label className="community-settings-field">
        <span>Slowmode</span>
        <select value={Number(channel.slowmode || 0)} disabled={busy || !canManageChannels} onChange={(event) => onPatch(channel.id, { slowmode: Number(event.target.value) })} aria-label={`${channel.name} slowmode`}>
          {SLOWMODE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      {canManageMessages ? <div className="community-channel-cleanup">
        <label className="community-settings-field">
          <span>Automatically delete messages</span>
          <select
            value={Number(channel.messageCleanupIntervalSeconds || 0)}
            disabled={cleanupBusy}
            onChange={async (event) => {
              const intervalSeconds = Number(event.target.value);
              if (intervalSeconds && !window.confirm(`Enable automatic permanent deletion for #${channel.name}? All messages and attachments will be erased at each scheduled run.`)) {
                event.target.value = String(channel.messageCleanupIntervalSeconds || 0);
                return;
              }
              setCleanupBusy(true);
              try {
                const { channel: updated } = await updateServerChannelMessageCleanup(serverId, channel.id, intervalSeconds);
                onChannelUpdated?.(updated);
                onNotice?.(intervalSeconds ? `Messages in #${channel.name} will be cleared on the selected schedule.` : `Automatic cleanup disabled for #${channel.name}.`);
              } catch (error) { onNotice?.(error.message); }
              finally { setCleanupBusy(false); }
            }}
          >
            <option value="0">Off</option>
            <option value="1800">Every 30 minutes</option>
            <option value="3600">Every hour</option>
            <option value="21600">Every 6 hours</option>
            <option value="43200">Every 12 hours</option>
            <option value="86400">Every day</option>
            <option value="604800">Every 7 days</option>
          </select>
        </label>
        {channel.messageCleanupNextRunAt ? <small>Next cleanup: {new Date(channel.messageCleanupNextRunAt).toLocaleString()}</small> : null}
        <button type="button" className="community-channel-clear-button" disabled={cleanupBusy || busy} onClick={async () => {
          if (!window.confirm(`Permanently delete every message and attachment in #${channel.name}? This cannot be undone.`)) return;
          setCleanupBusy(true);
          try {
            const result = await clearServerChannelMessages(serverId, channel.id);
            onNotice?.(`Permanently deleted ${result.deletedCount} messages from #${channel.name}.`);
          } catch (error) { onNotice?.(error.message); }
          finally { setCleanupBusy(false); }
        }}>{cleanupBusy ? 'Working…' : `Delete all messages in #${channel.name}`}</button>
      </div> : null}
    </div>
  );
}

function inviteSpent(invite) {
  return new Date(invite.expiresAt) <= new Date() || (invite.maxUses > 0 && invite.uses >= invite.maxUses);
}

export default function ServerSettingsModal({
  server,
  serverId,
  tab,
  startOnPage = false,
  onTabChange,
  canModerate,
  canManageChannels,
  canManageMessages,
  canManageRoles,
  canManageMembers,
  canManageInvites,
  isOwner,
  accountId,
  roleName,
  roleColor,
  rolePermissions,
  roleFlags,
  onRoleFlagsChange,
  onRoleNameChange,
  onRoleColorChange,
  onRolePermissionsChange,
  onCreateRole,
  editingRoleId,
  editRoleName,
  editRoleColor,
  editRolePermissions,
  editRoleFlags,
  onEditRoleFlagsChange,
  onEditRoleNameChange,
  onEditRoleColorChange,
  onEditRolePermissionsChange,
  onBeginRoleEdit,
  onCancelRoleEdit,
  onSubmitRoleEdit,
  onRemoveRole,
  onReorderRoles,
  onChangeMemberRole,
  onModerate,
  onTimeout,
  onChannelUpdated,
  onLeave,
  onDelete,
  onServerUpdated,
  onNotice,
  onClose,
}) {
  const fileRef = useRef(null);
  const [onPage, setOnPage] = useState(startOnPage);
  const [nameDraft, setNameDraft] = useState(server.name || '');
  const [descriptionDraft, setDescriptionDraft] = useState(server.description || '');
  const [savingOverview, setSavingOverview] = useState(false);
  const [savingModeration, setSavingModeration] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [overviewError, setOverviewError] = useState('');
  const [cropSource, setCropSource] = useState(null);
  const [cropError, setCropError] = useState('');
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(false);
  const [expiresInHours, setExpiresInHours] = useState(168);
  const [maxUses, setMaxUses] = useState(0);
  const [invites, setInvites] = useState([]);
  const [friends, setFriends] = useState([]);
  const [friendQuery, setFriendQuery] = useState('');
  const [inviteBusy, setInviteBusy] = useState('');
  const [bans, setBans] = useState([]);
  const [auditRows, setAuditRows] = useState([]);
  const [auditCursor, setAuditCursor] = useState(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [banBusy, setBanBusy] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [settingsMembers, setSettingsMembers] = useState(() => server.members || []);
  const [settingsMembersLoading, setSettingsMembersLoading] = useState(false);
  const [memberRoleBusy, setMemberRoleBusy] = useState(false);
  const [memberModerationBusy, setMemberModerationBusy] = useState('');
  const [channelBusy, setChannelBusy] = useState('');
  const cropSourceRef = useRef(null);
  cropSourceRef.current = cropSource;
  const reorderableRoles = useMemo(() => (server.roles || []).filter((role) => role.permissions !== 'owner' && role.name !== 'Member'), [server.roles]);
  const roleReorder = useHoldReorder({
    items: reorderableRoles,
    enabled: canManageRoles && Boolean(onReorderRoles) && reorderableRoles.length > 1,
    onReorder: onReorderRoles,
  });
  const orderedRoles = useMemo(() => ([
    ...(server.roles || []).filter((role) => role.permissions === 'owner'),
    ...roleReorder.items,
    ...(server.roles || []).filter((role) => role.permissions !== 'owner' && role.name === 'Member'),
  ]), [server.roles, roleReorder.items]);
  const moveRole = (roleId, direction) => {
    const index = roleReorder.items.findIndex((role) => Number(role.id) === Number(roleId));
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= roleReorder.items.length) return;
    const next = [...roleReorder.items];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onReorderRoles?.(next);
  };

  const groups = useMemo(() => ([
    {
      label: 'Server',
      items: [
        { id: 'overview', label: 'Overview' },
        ...(canManageChannels || canManageMessages ? [{ id: 'channels', label: 'Channels' }] : []),
        ...(canManageInvites ? [{ id: 'invites', label: 'Invites' }] : []),
        ...(canManageRoles ? [{ id: 'roles', label: 'Roles' }] : []),
        { id: 'members', label: 'Members' },
        ...(canManageMembers ? [{ id: 'bans', label: 'Bans' }] : []),
        ...(canModerate ? [{ id: 'audit', label: 'Audit Log' }] : []),
      ],
    },
    {
      label: 'Danger',
      items: [{ id: 'danger', label: isOwner ? 'Delete server' : 'Leave server' }],
    },
  ]), [canManageChannels, canManageMessages, canManageInvites, canManageMembers, canManageRoles, canModerate, isOwner]);

  const titles = {
    overview: 'Overview',
    channels: 'Channels',
    invites: 'Invites',
    roles: 'Roles',
    members: 'Members',
    bans: 'Bans',
    audit: 'Audit Log',
    danger: isOwner ? 'Delete server' : 'Leave server',
  };

  const closeCrop = useCallback(() => {
    const current = cropSourceRef.current;
    if (current?.url) URL.revokeObjectURL(current.url);
    setCropSource(null);
    setCropError('');
  }, []);

  const goBack = useCallback(() => {
    if (cropSourceRef.current) {
      closeCrop();
      return;
    }
    if (bannerOpen) {
      setBannerOpen(false);
      return;
    }
    if (onPage) {
      setOnPage(false);
      return;
    }
    onClose();
  }, [closeCrop, onClose, onPage, bannerOpen]);

  useEffect(() => () => {
    if (cropSourceRef.current?.url) URL.revokeObjectURL(cropSourceRef.current.url);
  }, []);

  useEffect(() => {
    setNameDraft(server.name || '');
    setDescriptionDraft(server.description || '');
  }, [server.id, server.name, server.description]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      goBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [goBack]);

  useEffect(() => {
    if (tab !== 'invites' || !canManageInvites) return undefined;
    let cancelled = false;
    Promise.all([getServerInvites(server.id), getFriends()])
      .then(([{ invites: items }, { friends: people }]) => {
        if (cancelled) return;
        setInvites(items || []);
        setFriends(people || []);
      })
      .catch((error) => onNotice?.(error.message));
    return () => { cancelled = true; };
  }, [tab, server.id, canManageInvites, onNotice]);

  useEffect(() => {
    if (tab !== 'bans' || !canManageMembers) return undefined;
    let cancelled = false;
    getServerBans(server.id)
      .then(({ bans: items }) => { if (!cancelled) setBans(items || []); })
      .catch((error) => onNotice?.(error.message));
    return () => { cancelled = true; };
  }, [tab, server.id, canManageMembers, onNotice]);

  const loadAuditPage = useCallback(async (before = null, append = false) => {
    if (auditBusy) return;
    setAuditBusy(true);
    setAuditError('');
    try {
      const { entries, nextCursor } = await getServerAuditLog(server.id, { before });
      setAuditRows((current) => append ? [...current, ...(entries || [])] : (entries || []));
      setAuditCursor(nextCursor || null);
    } catch (error) {
      setAuditError(error.message || 'Could not load the audit log.');
    } finally {
      setAuditBusy(false);
    }
  }, [server.id, auditBusy]);

  useEffect(() => {
    if (tab !== 'audit' || !canModerate) return;
    setAuditRows([]);
    setAuditCursor(null);
    loadAuditPage();
  }, [tab, canModerate, server.id]);

  const openTab = (id) => {
    onTabChange(id);
    setOnPage(true);
  };

  const pickIcon = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024 || (file.type && !ICON_TYPES.has(file.type))) {
      setCropError('Choose a JPG, PNG, WebP, or GIF up to 8 MB.');
      return;
    }
    closeCrop();
    setCropError('');
    setCropSource({ url: URL.createObjectURL(file) });
  };

  const saveIcon = async (file) => {
    setUploadingIcon(true);
    setCropError('');
    try {
      const { server: next } = await updateServerIcon(server.id, file);
      onServerUpdated?.(next);
      closeCrop();
      onNotice?.('Server photo updated.');
    } catch (error) {
      setCropError(error.message);
    } finally {
      setUploadingIcon(false);
    }
  };

  const clearIcon = async () => {
    if (uploadingIcon) return;
    setUploadingIcon(true);
    setOverviewError('');
    try {
      const { server: next } = await removeServerIcon(server.id);
      onServerUpdated?.(next);
      onNotice?.('Server photo removed.');
    } catch (error) {
      setOverviewError(error.message);
    } finally {
      setUploadingIcon(false);
    }
  };

  const saveOverview = async (event) => {
    event.preventDefault();
    if (!isOwner || savingOverview) return;
    const nextName = nameDraft.trim().replace(/\s+/g, ' ');
    if (nextName.length < 2 || nextName.length > 60) {
      setOverviewError('Server name must be 2–60 characters.');
      return;
    }
    setSavingOverview(true);
    setOverviewError('');
    try {
      const { server: next } = await updateServer(server.id, { name: nextName, description: descriptionDraft.trim().slice(0, 200) });
      onServerUpdated?.(next);
      onNotice?.('Server profile saved.');
    } catch (error) {
      setOverviewError(error.message);
    } finally {
      setSavingOverview(false);
    }
  };

  const toggleServerModeration = async () => {
    if (!isOwner || savingModeration) return;
    const moderationEnabled = !server.moderationEnabled;
    setSavingModeration(true);
    setOverviewError('');
    try {
      const { server: next } = await updateServer(server.id, { moderationEnabled });
      onServerUpdated?.(next);
      onNotice?.(moderationEnabled ? 'Server message moderation is on.' : 'Server message moderation is off.');
    } catch (error) {
      setOverviewError(error.message);
    } finally {
      setSavingModeration(false);
    }
  };

  const toggleServerVisibility = async () => {
    if (!isOwner || savingVisibility) return;
    const isPublic = !server.isPublic;
    setSavingVisibility(true);
    setOverviewError('');
    try {
      const { server: next } = await updateServer(server.id, { isPublic });
      onServerUpdated?.(next);
      onNotice?.(isPublic ? 'Server is now listed in Discover.' : 'Server is now private and no longer listed in Discover.');
    } catch (error) {
      setOverviewError(error.message);
    } finally {
      setSavingVisibility(false);
    }
  };

  const patchChannel = async (channelId, payload) => {
    if (!canManageChannels || channelBusy) return;
    setChannelBusy(String(channelId));
    try {
      const { channel } = await updateChannel(server.id, channelId, payload);
      onChannelUpdated?.(channel);
    } catch (error) {
      onNotice?.(error.message);
    } finally {
      setChannelBusy('');
    }
  };

  const createInvite = async () => {
    if (!canManageInvites || inviteBusy) return;
    setInviteBusy('create');
    try {
      const { invite } = await createServerInvite(server.id, { expiresInHours, maxUses });
      setInvites((current) => [{ ...invite, uses: 0, createdAt: new Date().toISOString(), createdBy: 'you' }, ...current]);
      const link = inviteUrl(invite.code);
      await navigator.clipboard.writeText(link || invite.code).catch(() => {});
      onNotice?.('Invite link copied.');
    } catch (error) {
      onNotice?.(error.message);
    } finally {
      setInviteBusy('');
    }
  };

  const copyInvite = async (code) => {
    const link = inviteUrl(code);
    try {
      await navigator.clipboard.writeText(link || code);
      onNotice?.('Invite link copied.');
    } catch {
      onNotice?.(link || `Invite code: ${code}`);
    }
  };

  const sendToFriend = async (friend) => {
    if (!canManageInvites || inviteBusy) return;
    setInviteBusy(`send:${friend.id}`);
    try {
      const { invite } = await sendServerInvite(server.id, { username: friend.username, expiresInHours, maxUses });
      setInvites((current) => [{ ...invite, uses: 0, createdAt: new Date().toISOString(), createdBy: 'you' }, ...current]);
      onNotice?.(`Invite sent to ${friend.username}.`);
    } catch (error) {
      onNotice?.(error.message);
    } finally {
      setInviteBusy('');
    }
  };

  const revokeInvite = async (code) => {
    if (inviteBusy) return;
    setInviteBusy(code);
    try {
      await revokeServerInvite(server.id, code);
      setInvites((current) => current.filter((item) => item.code !== code));
    } catch (error) {
      onNotice?.(error.message);
    } finally {
      setInviteBusy('');
    }
  };

  const liftBan = async (userId) => {
    if (banBusy) return;
    setBanBusy(String(userId));
    try {
      await unbanServerMember(server.id, userId);
      setBans((current) => current.filter((item) => Number(item.userId) !== Number(userId)));
      onNotice?.('User unbanned.');
    } catch (error) {
      onNotice?.(error.message);
    } finally {
      setBanBusy('');
    }
  };

  useEffect(() => {
    setSettingsMembers(server.members || []);
  }, [server.id]);

  useEffect(() => {
    if (tab !== 'members' || !server.id) return undefined;
    let cancelled = false;
    const loadAllMembers = async () => {
      setSettingsMembersLoading(true);
      const byId = new Map((server.members || []).map((member) => [Number(member.id), member]));
      let offset = byId.size;
      let hasMore = true;
      try {
        while (hasMore && !cancelled) {
          const result = await getServerMembers(server.id, { offset, limit: 50 });
          (result.members || []).forEach((member) => byId.set(Number(member.id), member));
          const page = result.page || {};
          const nextOffset = Number(page.nextOffset ?? offset + (result.members || []).length);
          hasMore = Boolean(page.hasMore) && nextOffset > offset;
          offset = nextOffset;
        }
        if (!cancelled) setSettingsMembers([...byId.values()]);
      } catch (error) {
        if (!cancelled) onNotice?.(error.message || 'Could not load all members.');
      } finally {
        if (!cancelled) setSettingsMembersLoading(false);
      }
    };
    loadAllMembers();
    return () => { cancelled = true; };
  }, [onNotice, server.id, tab]);

  const members = settingsMembers.filter((member) => {
    const query = memberQuery.trim().toLowerCase();
    if (!query) return true;
    return String(member.username || '').toLowerCase().includes(query);
  });
  const changeMemberRoleFromSettings = async (member, rawRoleId) => {
    const roleId = Number(rawRoleId);
    const role = (server.roles || []).find((item) => Number(item.id) === roleId);
    if (!role || role.permissions === 'owner' || memberRoleBusy) return;
    if (Number(member.roleId) === roleId) return;
    setMemberRoleBusy(true);
    try {
      const saved = await onChangeMemberRole?.(member.id, roleId, member);
      if (!saved) return;
      setSettingsMembers((current) => current.map((item) => Number(item.id) === Number(member.id)
        ? { ...item, roleId: Number(role.id), roleName: role.name, roleColor: role.color, permissions: role.permissions, permissionFlags: role.permissionFlags || [] }
        : item));
    } catch (error) {
      onNotice?.(error.message || 'Could not update this member role.');
    } finally {
      setMemberRoleBusy(false);
    }
  };
  const moderateMemberFromSettings = async (member, action) => {
    if (memberModerationBusy) return;
    const key = `${member.id}:${action}`;
    setMemberModerationBusy(key);
    try {
      const completed = await onModerate?.(member, action);
      if (completed) setSettingsMembers((current) => current.filter((item) => Number(item.id) !== Number(member.id)));
    } catch (error) {
      onNotice?.(error.message || 'Could not moderate this member.');
    } finally {
      setMemberModerationBusy('');
    }
  };
  const timeoutMemberFromSettings = async (member, seconds) => {
    if (memberModerationBusy) return;
    setMemberModerationBusy(`${member.id}:timeout`);
    try {
      const result = await onTimeout?.(member, seconds);
      if (result?.ok) {
        setSettingsMembers((current) => current.map((item) => Number(item.id) === Number(member.id)
          ? { ...item, timeoutUntil: result.timeoutUntil }
          : item));
      }
    } catch (error) {
      onNotice?.(error.message || 'Could not update this member timeout.');
    } finally {
      setMemberModerationBusy('');
    }
  };
  const memberIds = useMemo(() => new Set(settingsMembers.map((member) => Number(member.id))), [settingsMembers]);
  const inviteFriends = friends.filter((friend) => {
    const query = friendQuery.trim().toLowerCase();
    if (!query) return true;
    return String(friend.username || '').toLowerCase().includes(query);
  });
  const created = formatJoinedDate(server.createdAt);
  const memberCount = Number(server.memberTotal ?? settingsMembers.length);
  const onlineCount = settingsMembers.filter((member) => member.presence === 'online' || member.presence === 'idle').length;
  const channelCount = (server.channels || []).length;
  const dirty = nameDraft.trim() !== (server.name || '') || descriptionDraft.trim() !== (server.description || '');
  const invitePreviewServer = {
    id: server.id,
    name: nameDraft.trim() || server.name || 'Server',
    iconUrl: server.iconUrl,
    description: descriptionDraft.trim(),
    banner: server.banner || null,
    createdAt: server.createdAt,
    memberCount,
    onlineCount,
  };
  const saveServerBanner = async (payload) => {
    const { server: next } = await updateServerBanner(server.id, payload);
    return next;
  };

  return (
    <div className="community-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !cropSource && !bannerOpen) onClose(); }}>
      <section className={`community-settings${onPage ? ' is-page' : ''}`} role="dialog" aria-modal="true" aria-labelledby="server-settings-title">
        <aside className="community-settings-nav">
          <div className="community-settings-brand">
            <ServerIcon server={server} />
            <span>
              <strong>{server.name}</strong>
              <small>Server settings</small>
            </span>
            <button type="button" className="community-settings-nav-close" onClick={onClose} aria-label="Close settings"><CloseIcon /></button>
          </div>
          {groups.map((group) => (
            <div key={group.label} className="community-settings-group">
              <p>{group.label}</p>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`${tab === item.id ? 'is-active' : ''}${item.id === 'danger' ? ' is-danger' : ''}`}
                  onClick={() => openTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </aside>
        <div className="community-settings-content">
          <header className="community-settings-toolbar">
            <button type="button" className="community-settings-back" onClick={() => setOnPage(false)} aria-label="Back to settings">‹</button>
            <h2 id="server-settings-title">{titles[tab] || 'Settings'}</h2>
            <button type="button" className="community-settings-close" onClick={onClose} aria-label="Close settings"><CloseIcon /></button>
          </header>

          {tab === 'overview' ? (
            <form className="community-settings-section community-overview" onSubmit={saveOverview}>
              <div className="community-overview-intro">
                <div>
                  <h3>Server profile</h3>
                  <p>Manage the name, photo, description, and invite appearance for this server.</p>
                </div>
                {!isOwner ? <span className="community-overview-readonly">View only</span> : null}
              </div>
              <div className="community-overview-layout">
                <div className="community-overview-main">
                  <section className="community-overview-card">
                    <div className="community-overview-card-heading">
                      <div>
                        <h4>Identity</h4>
                        <p>Give your server a recognizable name and photo.</p>
                      </div>
                    </div>
                    <div className="community-overview-icon">
                      {isOwner ? (
                        <button
                          type="button"
                          className="community-overview-photo"
                          onClick={() => fileRef.current?.click()}
                          disabled={uploadingIcon}
                          aria-label={server.iconUrl ? 'Change server photo' : 'Upload server photo'}
                        >
                          <ServerIcon server={server} large />
                          <span className="community-overview-photo-edit">{uploadingIcon ? 'Uploading…' : 'Edit'}</span>
                        </button>
                      ) : (
                        <ServerIcon server={server} large />
                      )}
                      {isOwner ? (
                        <div className="community-overview-photo-actions">
                          <div className="community-overview-photo-buttons">
                            <button type="button" className="community-dialog-primary" onClick={() => fileRef.current?.click()} disabled={uploadingIcon}>
                              {uploadingIcon ? 'Uploading…' : server.iconUrl ? 'Change photo' : 'Upload photo'}
                            </button>
                            {server.iconUrl ? <button type="button" className="community-overview-remove" onClick={clearIcon} disabled={uploadingIcon}>Remove</button> : null}
                          </div>
                          <small>JPG, PNG, WebP, or GIF up to 8 MB. Crop before saving.</small>
                          {cropError ? <p className="community-dialog-error" role="alert">{cropError}</p> : null}
                          <input ref={fileRef} className="community-file-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={pickIcon} />
                        </div>
                      ) : null}
                    </div>
                    <div className="community-overview-fields">
                      <label className="community-settings-field" htmlFor="server-overview-name">
                        <span>Server name</span>
                        <input id="server-overview-name" value={nameDraft} onChange={(event) => { setNameDraft(event.target.value); setOverviewError(''); }} maxLength="60" disabled={!isOwner} />
                      </label>
                      <label className="community-settings-field" htmlFor="server-overview-about">
                        <span>Description</span>
                        <textarea id="server-overview-about" value={descriptionDraft} onChange={(event) => setDescriptionDraft(event.target.value)} maxLength="200" rows="4" disabled={!isOwner} placeholder="What is this server for?" />
                        <small>{descriptionDraft.length}/200</small>
                      </label>
                    </div>
                  </section>
                  <section className="community-overview-card community-moderation-setting">
                    <div className="community-overview-card-heading">
                      <div>
                        <h4>Public server</h4>
                        <p>Let people find and join this server from Discover.</p>
                      </div>
                      <button
                        type="button"
                        className="dm-accessibility-switch"
                        role="switch"
                        aria-checked={Boolean(server.isPublic)}
                        aria-label="List this server publicly in Discover"
                        onClick={toggleServerVisibility}
                        disabled={!isOwner || savingVisibility}
                      >
                        {savingVisibility ? '…' : server.isPublic ? 'On' : 'Off'}
                      </button>
                    </div>
                    <small>{isOwner ? 'Off by default. Only the server owner can change visibility.' : 'Only the server owner can change visibility.'}</small>
                  </section>
                  <section className="community-overview-card community-moderation-setting">
                    <div className="community-overview-card-heading">
                      <div>
                        <h4>Message moderation</h4>
                        <p>Those pesky users saying profanity? Turn this on to have automatic moderation. Note, I spend WAYYYY to much time training the model, if any reports come in, tell me PERSONALLY (if you know me) so I can train the model more!</p>
                      </div>
                      <button
                        type="button"
                        className="dm-accessibility-switch"
                        role="switch"
                        aria-checked={Boolean(server.moderationEnabled)}
                        aria-label="Enable server message moderation"
                        onClick={toggleServerModeration}
                        disabled={!isOwner || savingModeration}
                      >
                        {savingModeration ? '…' : server.moderationEnabled ? 'On' : 'Off'}
                      </button>
                    </div>
                    <small>{isOwner ? 'Off by default. Only the server owner can change this.' : 'Only the server owner can change this setting.'}</small>
                  </section>
                  <section className="community-overview-card community-overview-appearance">
                    <div className="community-overview-card-heading">
                      <div>
                        <h4>Appearance</h4>
                        <p>Customize the top of the invite card.</p>
                      </div>
                    </div>
                    {isOwner ? (
                      <div className="dm-account-banner-row community-overview-banner">
                        <span>Invite splash</span>
                        <div className="dm-account-banner-preview" style={bannerStyle(server.banner)} />
                        <button type="button" className="community-dialog-primary" onClick={() => setBannerOpen(true)}>Customize</button>
                        <small>Use a gradient, solid color, or image.</small>
                      </div>
                    ) : (
                      <div className="community-overview-banner community-overview-banner-readonly">
                        <span>Invite splash</span>
                        <div className="dm-account-banner-preview" style={bannerStyle(server.banner)} />
                        <small>Only the server owner can customize the invite splash.</small>
                      </div>
                    )}
                    <div className="community-overview-meta">
                      <span>{memberCount} member{memberCount === 1 ? '' : 's'}</span>
                      <span>{channelCount} channel{channelCount === 1 ? '' : 's'}</span>
                      {created ? <span>Created {created}</span> : null}
                    </div>
                  </section>
                </div>
                <aside className="community-overview-invite-live">
                  <div className="community-overview-card-heading">
                    <div>
                      <h4>Invite preview</h4>
                      <p>See what members receive before you share it.</p>
                    </div>
                  </div>
                  <ServerInvitePreview server={invitePreviewServer} goDisabled goLabel="Go to Server" />
                </aside>
              </div>
              {overviewError ? <p className="community-dialog-error" role="alert">{overviewError}</p> : null}
              {isOwner && dirty ? (
                <div className="community-settings-save is-dirty">
                  <small>Unsaved changes</small>
                  <div>
                    <button type="button" onClick={() => { setNameDraft(server.name || ''); setDescriptionDraft(server.description || ''); setOverviewError(''); }}>Reset</button>
                    <button type="submit" className="community-dialog-primary" disabled={savingOverview}>{savingOverview ? 'Saving…' : 'Save changes'}</button>
                  </div>
                </div>
              ) : null}
            </form>
          ) : null}

          {tab === 'channels' && (canManageChannels || canManageMessages) ? (
            <div className="community-settings-section">
              <p>Manage channel settings and message cleanup. Clearing a channel permanently deletes its messages and attachments.</p>
              <div className="community-settings-channel-list">
                {(server.channels || []).map((item) => (
                  <ChannelModerationCard
                    key={item.id}
                    serverId={server.id}
                    channel={item}
                    busy={channelBusy === String(item.id)}
                    canManageChannels={canManageChannels}
                    canManageMessages={canManageMessages}
                    onChannelUpdated={onChannelUpdated}
                    onNotice={onNotice}
                    onPatch={patchChannel}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {tab === 'invites' && canManageInvites ? (
            <div className="community-settings-section">
              <p>Click a friend to DM them this server. Generate a link to share anywhere — the letters-and-numbers code still works in Add a server.</p>
              <div className="community-invite-builder">
                <label>
                  Expires
                  <select value={expiresInHours} onChange={(event) => setExpiresInHours(Number(event.target.value))}>
                    {EXPIRY_OPTIONS.map((item) => <option key={item.hours} value={item.hours}>{item.label}</option>)}
                  </select>
                </label>
                <label>
                  Max uses
                  <select value={maxUses} onChange={(event) => setMaxUses(Number(event.target.value))}>
                    {USE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <button type="button" className="community-dialog-primary" onClick={createInvite} disabled={Boolean(inviteBusy)}>
                  {inviteBusy === 'create' ? 'Creating…' : 'Generate link'}
                </button>
              </div>
              <div className="community-invite-friends">
                <strong>Send to a friend</strong>
                {friends.length ? (
                  <input className="community-settings-search" value={friendQuery} onChange={(event) => setFriendQuery(event.target.value)} placeholder="Search friends" aria-label="Search friends" />
                ) : null}
                <div className="community-member-list">
                  {inviteFriends.length ? inviteFriends.map((friend) => {
                    const inServer = memberIds.has(Number(friend.id));
                    return (
                      <button
                        type="button"
                        className="community-invite-friend"
                        key={friend.id}
                        onClick={() => sendToFriend(friend)}
                        disabled={Boolean(inviteBusy)}
                      >
                        <CommunityAvatar user={friend} small interactive={false} presence />
                        <span>
                          <strong>{friend.username}</strong>
                          <small>{inviteBusy === `send:${friend.id}` ? 'Sending…' : inServer ? 'In server' : 'Send invite'}</small>
                        </span>
                      </button>
                    );
                  }) : <p>{friends.length ? 'No friends match that search.' : 'Add friends to send them an invite from here.'}</p>}
                </div>
              </div>
              <div className="community-invite-list">
                {invites.length ? invites.map((invite) => (
                  <div className={`community-invite-row${inviteSpent(invite) ? ' is-spent' : ''}`} key={invite.code}>
                    <div>
                      <code>{invite.code}</code>
                      <small>
                        {inviteUrl(invite.code)}
                        {' · '}
                        {invite.maxUses ? `${invite.uses || 0} / ${invite.maxUses} uses` : `${invite.uses || 0} uses`}
                        {invite.expiresAt ? ` · expires ${formatJoinedDate(invite.expiresAt)}` : ''}
                        {inviteSpent(invite) ? ' · spent' : ''}
                      </small>
                    </div>
                    <div className="community-invite-row-actions">
                      <button type="button" onClick={() => copyInvite(invite.code)} aria-label="Copy invite link"><CopyIcon /> Copy link</button>
                      <button type="button" onClick={() => revokeInvite(invite.code)} disabled={inviteBusy === invite.code}>Revoke</button>
                    </div>
                  </div>
                )) : <p>No invites yet.</p>}
              </div>
            </div>
          ) : null}

          {tab === 'roles' && canManageRoles ? (
            <div className="community-settings-section">
              <p>Set a member’s role from Members. Hold and drag custom roles to reorder them. Owner stays first and can only be renamed. Member stays last.</p>
              <form className="community-role-form" onSubmit={onCreateRole}>
                <input value={roleName} onChange={(event) => onRoleNameChange(event.target.value)} placeholder="Role name" aria-label="Role name" maxLength="32" />
                <input className="community-role-color" type="color" value={roleColor} onChange={(event) => onRoleColorChange(event.target.value)} aria-label="Role color" />
                <select value={rolePermissions} onChange={(event) => onRolePermissionsChange(event.target.value)} aria-label="Role permissions">
                  <option value="moderator">Moderator</option>
                  <option value="member">Member</option>
                </select>
                <button type="submit" className="community-dialog-primary">Add role</button>
                {rolePermissions === 'moderator' ? <ModeratorFlags value={roleFlags} onChange={onRoleFlagsChange} /> : null}
              </form>
              <div className="community-role-list" data-reorder-list>
                {orderedRoles.map((role) => {
                  const isOwnerRole = role.permissions === 'owner';
                  const editable = canManageRoles && !isOwnerRole && role.name !== 'Member';
                  const canRename = role.name !== 'Member';
                  const roleIndex = roleReorder.items.findIndex((item) => Number(item.id) === Number(role.id));
                  return (
                  <div
                    className={`community-role-row${editable && roleReorder.items.length > 1 ? ' is-reorderable' : ''}${String(roleReorder.draggingId) === String(role.id) ? ' is-dragging' : ''}`}
                    key={role.id}
                    {...(editable ? roleReorder.bind(role.id) : {})}
                  >
                    {editingRoleId === role.id ? (
                      <form className="community-role-edit-form" data-no-reorder onSubmit={(event) => onSubmitRoleEdit(event, role)}>
                        <input value={editRoleName} onChange={(event) => onEditRoleNameChange(event.target.value)} aria-label={`Edit ${role.name} role name`} maxLength="32" />
                        {isOwnerRole ? <small className="community-role-owner-only">Name only</small> : <>
                          <input className="community-role-color" type="color" value={editRoleColor} onChange={(event) => onEditRoleColorChange(event.target.value)} aria-label={`Edit ${role.name} role color`} />
                          <select value={editRolePermissions} onChange={(event) => onEditRolePermissionsChange(event.target.value)} aria-label={`Edit ${role.name} permissions`}>
                            <option value="moderator">Moderator</option>
                            <option value="member">Member</option>
                          </select>
                          {editRolePermissions === 'moderator' ? <ModeratorFlags value={editRoleFlags} onChange={onEditRoleFlagsChange} /> : null}
                        </>}
                        <button type="submit">Save</button>
                        <button type="button" onClick={onCancelRoleEdit}>Cancel</button>
                      </form>
                    ) : (
                      <>
                        <i style={{ backgroundColor: role.color }} aria-hidden="true" />
                        <span>{role.name}</span>
                        <small>{role.permissions === 'moderator' ? `Moderator · ${(role.permissionFlags || []).length} permissions` : role.permissions}</small>
                        {editable ? (
                          <span className="community-role-actions">
                            <span className="community-role-order-actions" data-no-reorder>
                              <button type="button" onClick={() => moveRole(role.id, -1)} disabled={roleIndex === 0 || roleReorder.isDragging} aria-label={`Move ${role.name} up`}>↑</button>
                              <button type="button" onClick={() => moveRole(role.id, 1)} disabled={roleIndex === roleReorder.items.length - 1 || roleReorder.isDragging} aria-label={`Move ${role.name} down`}>↓</button>
                            </span>
                            <button type="button" data-no-reorder onClick={() => onBeginRoleEdit(role)} aria-label={`Edit ${role.name}`}><EditIcon /></button>
                            <button type="button" className="community-role-delete" data-no-reorder onClick={() => onRemoveRole(role)} aria-label={`Delete ${role.name}`}><TrashIcon /></button>
                          </span>
                        ) : canRename ? (
                          <span className="community-role-actions">
                            <button type="button" data-no-reorder onClick={() => onBeginRoleEdit(role)} aria-label={`Rename ${role.name}`}><EditIcon /></button>
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {tab === 'members' ? (
            <div className="community-settings-section">
              <p>{canManageMembers ? 'Kick removes them, but they can rejoin with an invite. Ban blocks rejoining until you unban them. Owners stay protected.' : 'People in this server.'}</p>
              <input className="community-settings-search" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="Search members" aria-label="Search members" />
              <div className="community-member-list" aria-busy={settingsMembersLoading}>
                {members.map((member) => {
                  const canEdit = canManageMembers && member.permissions !== 'owner' && (isOwner || member.permissions !== 'moderator');
                  return (
                    <div className="community-member-row" key={member.id}>
                      <div className="community-member-identity">
                        <CommunityAvatar user={member} small />
                        <span>
                          <strong>{member.username}{Number(member.id) === Number(accountId) ? ' (you)' : ''}</strong>
                          <small style={{ color: member.roleColor }}>{member.roleName}{member.permissions === 'moderator' ? <b className="community-mod-badge" title="Server moderator">MOD</b> : null}{member.timeoutUntil && Date.parse(member.timeoutUntil) > Date.now() ? ' · Timed out' : ''}</small>
                        </span>
                      </div>
                      {canManageMembers ? (
                        <div className="community-member-actions">
                          <select value={member.roleId} onChange={(event) => { void changeMemberRoleFromSettings(member, event.target.value); }} disabled={!canEdit || memberRoleBusy} aria-label={`Role for ${member.username}`}>
                            {(server.roles || []).map((role) => <option key={role.id} value={role.id} disabled={role.permissions === 'owner'}>{role.name}</option>)}
                          </select>
                          {canEdit ? (
                            <>
                              <select value="" disabled={Boolean(memberModerationBusy)} onChange={(event) => { const value = event.target.value; if (value === '') return; void timeoutMemberFromSettings(member, Number(value)); }} aria-label={`Timeout ${member.username}`}>
                                {TIMEOUT_OPTIONS.map((item) => <option key={String(item.value)} value={item.value} disabled={item.value === ''}>{item.label}</option>)}
                              </select>
                              <button type="button" className="community-kick" onClick={() => moderateMemberFromSettings(member, 'kick')} disabled={Boolean(memberModerationBusy)}>
                                {memberModerationBusy === `${member.id}:kick` ? 'Working…' : 'Kick'}
                              </button>
                              <button type="button" className="community-ban" onClick={() => moderateMemberFromSettings(member, 'ban')} disabled={Boolean(memberModerationBusy)}>
                                {memberModerationBusy === `${member.id}:ban` ? 'Working…' : 'Ban'}
                              </button>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {settingsMembersLoading && !members.length ? <p>Loading members…</p> : null}
                {!settingsMembersLoading && !members.length ? <p>No members match that search.</p> : null}
              </div>
            </div>
          ) : null}

          {tab === 'bans' && canManageMembers ? (
            <div className="community-settings-section">
              <p>Banned people cannot join with an invite until you unban them.</p>
              <div className="community-member-list">
                {bans.length ? bans.map((ban) => (
                  <div className="community-member-row" key={ban.userId}>
                    <div className="community-member-identity">
                      <CommunityAvatar user={{ id: ban.userId, username: ban.username, avatarUrl: ban.avatarUrl }} small />
                      <span>
                        <strong>{ban.username}</strong>
                        <small>{ban.reason || 'No reason'}{ban.bannedBy ? ` · by ${ban.bannedBy}` : ''}{ban.createdAt ? ` · ${formatJoinedDate(ban.createdAt)}` : ''}</small>
                      </span>
                    </div>
                    <div className="community-member-actions">
                      <button type="button" className="community-kick" onClick={() => liftBan(ban.userId)} disabled={banBusy === String(ban.userId)}>
                        {banBusy === String(ban.userId) ? 'Working…' : 'Unban'}
                      </button>
                    </div>
                  </div>
                )) : <p>No bans.</p>}
              </div>
            </div>
          ) : null}

          {tab === 'audit' && canModerate ? (
            <div className="community-settings-section community-audit-log">
              <p>Server actions by owners and moderators, newest first.</p>
              {auditRows.length ? auditRows.map((entry) => {
                let details = {};
                try { details = JSON.parse(entry.detailsJson || '{}'); } catch { /* malformed legacy row */ }
                return <article className="community-audit-row" key={entry.id}>
                  <div><strong>{entry.actorName}</strong> <span>{String(entry.action).replaceAll('.', ' ').replaceAll('-', ' ')}</span>{entry.targetName ? <> · <b>{entry.targetName}</b></> : null}</div>
                  <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
                  {Object.keys(details).length ? <small>{Object.entries(details).map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}</small> : null}
                </article>;
              }) : auditBusy ? <p>Loading audit log…</p> : auditError ? <p role="alert">{auditError}</p> : <p>No server actions recorded yet.</p>}
              {auditError && auditRows.length ? <p role="alert">{auditError}</p> : null}
              {auditCursor ? <button type="button" className="community-audit-more" onClick={() => loadAuditPage(auditCursor, true)} disabled={auditBusy}>{auditBusy ? 'Loading…' : 'Load older entries'}</button> : null}
            </div>
          ) : null}

          {tab === 'danger' ? (
            <div className="community-settings-section community-danger-section">
              {isOwner ? (
                <div className="community-danger-card">
                  <strong>Delete {server.name}</strong>
                  <p>This removes channels, messages, and the photo for everyone. It cannot be undone.</p>
                  <button type="button" className="community-danger-action" onClick={onDelete}>Delete server</button>
                </div>
              ) : (
                <div className="community-danger-card">
                  <strong>Leave {server.name}</strong>
                  <p>You will need a new invite to come back.</p>
                  <button type="button" className="community-danger-action" onClick={onLeave}>Leave server</button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </section>
      {cropSource ? (
        <AvatarCropEditor
          title="Edit server photo"
          imageUrl={cropSource.url}
          saving={uploadingIcon}
          error={cropError}
          onCancel={closeCrop}
          onSave={saveIcon}
          onError={setCropError}
        />
      ) : null}
      {bannerOpen ? (
        <BannerEditor
          banner={server.banner}
          title="Edit invite splash"
          lead="This is the top of the invite card people get. Pick a color, a two-color fade, or a photo."
          invitePreview={invitePreviewServer}
          saveBanner={saveServerBanner}
          onClose={() => setBannerOpen(false)}
          onSaved={(next) => {
            onServerUpdated?.(next);
            onNotice?.('Invite splash saved.');
          }}
        />
      ) : null}
    </div>
  );
}
