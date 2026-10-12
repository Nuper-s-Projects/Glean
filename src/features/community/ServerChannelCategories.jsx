import { useMemo, useState } from 'react';
import { ChannelGlyph } from './ServerChannelHeader';
import { formatUnreadCount } from '../../app/pwa';
import { LockIcon, SpeakerIcon, TrashIcon } from '../dm/icons';
import { VoiceOccupantRow, occupantsOf } from './VoiceBits';
import useHoldReorder from './useHoldReorder';
import './ServerCategories.css';

function ChannelGroup({ category, items, activeChannel, voiceLiveId, liveApps, voiceOccupancy, accountId, canManage, inspecting, onSelect, onRemove, onContextMenu, onReorder }) {
  const [collapsed, setCollapsed] = useState(false);
  const reorder = useHoldReorder({ items, enabled: canManage && !inspecting && items.length > 1, onReorder });
  return <section className="server-channel-category">
    <button type="button" className="server-category-heading" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
      <small aria-hidden="true">{collapsed ? '▸' : '▾'}</small><span>{category.name}</span><b>{items.length}</b>
    </button>
    {!collapsed ? <div className={`community-channel-list${reorder.isDragging ? ' is-reordering' : ''}`} data-reorder-list>
      {reorder.items.map((item) => <div key={item.id} className={`${item.voice ? 'community-voice-block' : 'community-channel-row'}${canManage && items.length > 1 ? ' is-reorderable' : ''}${String(reorder.draggingId) === String(item.id) ? ' is-dragging' : ''}`} {...reorder.bind(item.id)}>
        <div className={item.voice ? 'community-channel-row' : undefined} style={!item.voice ? { display: 'contents' } : undefined}>
          <button type="button" className={`community-channel${activeChannel?.id === item.id ? ' is-active' : ''}${item.unreadCount || item.mentionCount ? ' is-unread' : ''}${item.voice && Number(voiceLiveId) === Number(item.id) ? ' is-connected' : ''}`} aria-current={activeChannel?.id === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}>
            {item.voice ? <SpeakerIcon /> : <ChannelGlyph kind={item.kind} />}<span>{item.name}</span>
            {!item.voice && item.locked ? <LockIcon /> : null}
            {!item.voice && (item.mentionCount || item.unreadCount) ? <b className="channel-unread-count">{formatUnreadCount(item.mentionCount || item.unreadCount)}</b> : null}
            {item.voice && liveApps[String(item.id)] ? <b className="community-channel-app" title={`${liveApps[String(item.id)].appName} is live`}>{liveApps[String(item.id)].appName}</b> : null}
          </button>
          {canManage && (item.voice || item.name !== 'general') ? <button type="button" className="community-channel-delete" data-no-reorder aria-label={`Delete ${item.name} channel`} onClick={() => onRemove(item)}><TrashIcon /></button> : null}
        </div>
        {item.voice ? <div className="community-voice-occupants" data-no-reorder>{occupantsOf(voiceOccupancy, item.id).map((user) => <VoiceOccupantRow key={user.id} user={user} selfId={accountId} onContextMenu={(event, member) => onContextMenu(event, member, true)} />)}</div> : null}
      </div>)}
    </div> : null}
  </section>;
}

export default function ServerChannelCategories({ server, onReorder, ...props }) {
  const groups = useMemo(() => {
    const groupsById = new Map((server.categories || []).map((category) => [category.id, { ...category, items: [] }]));
    const ungrouped = { id: null, name: 'Uncategorized', items: [] };
    for (const channel of server.channels) (groupsById.get(channel.categoryId) || ungrouped).items.push(channel);
    return [...(ungrouped.items.length ? [ungrouped] : []), ...groupsById.values()];
  }, [server.channels, server.categories]);
  return groups.map((group) => <ChannelGroup key={group.id ?? 'none'} category={group} items={group.items} {...props} onReorder={(next) => {
    const ids = new Set(group.items.map((item) => item.id));
    let index = 0;
    onReorder(server.channels.map((item) => ids.has(item.id) ? next[index++] : item));
  }} />);
}
