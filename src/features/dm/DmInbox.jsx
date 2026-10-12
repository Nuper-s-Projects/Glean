import { memo, useDeferredValue, useMemo, useState } from 'react';
import { formatUnreadCount } from '../../app/pwa';
import { Avatar, PresenceWrap } from './DmPrimitives';
import DisplayName from './DisplayName';
import { MoreIcon } from './icons';
import { selectConversations, selectUnstartedFriends } from './conversationState';

function relativeTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function DmSkeleton({ transcript = false }) {
  return <div className={`dm-skeleton${transcript ? ' is-transcript' : ''}`} role="status" aria-label={transcript ? 'Loading messages' : 'Loading conversations'}>
    {Array.from({ length: transcript ? 5 : 6 }, (_, index) => <div className="dm-skeleton-row" key={index} aria-hidden="true"><i /><span><b /><b /></span></div>)}
  </div>;
}

const ConversationRow = memo(function ConversationRow({ conversation, selected, onSelect, onMenu }) {
  return <PresenceWrap user={conversation.user} className={`dm-inbox-row${selected ? ' is-selected' : ''}${conversation.unreadCount ? ' is-unread' : ''}`} onContextMenu={event => onMenu(event, conversation)}>
    <Avatar user={conversation.user} presence />
    <button type="button" className="dm-inbox-open" onClick={() => onSelect(conversation.id)} aria-current={selected ? 'page' : undefined}>
      <span className="dm-inbox-row-heading"><strong><DisplayName user={conversation.user} /></strong><time dateTime={conversation.lastMessageAt || undefined}>{relativeTime(conversation.lastMessageAt)}</time></span>
      <span className="dm-inbox-row-preview"><small>{conversation.lastMessage || 'Start a conversation'}</small>{conversation.unreadCount ? <b className="dm-unread-count" aria-label={`${conversation.unreadCount} unread messages`}>{formatUnreadCount(conversation.unreadCount)}</b> : null}</span>
    </button>
    <button className="dm-inbox-more" type="button" onClick={event => onMenu(event, conversation)} aria-label={`Options for ${conversation.user?.username}`} title="Conversation options"><MoreIcon /></button>
  </PresenceWrap>;
});

const FriendRow = memo(function FriendRow({ friend, onStart }) {
  const [opening, setOpening] = useState(false);
  const start = async () => {
    if (opening) return;
    setOpening(true);
    try { await onStart(friend.username); } finally { setOpening(false); }
  };
  return <PresenceWrap user={friend} className="dm-inbox-row dm-inbox-friend">
    <Avatar user={friend} presence />
    <button type="button" className="dm-inbox-open" onClick={start} disabled={opening} aria-label={`Message ${friend.username}`} aria-busy={opening}>
      <span className="dm-inbox-row-heading"><strong><DisplayName user={friend} /></strong></span>
      <span className="dm-inbox-row-preview"><small>{opening ? 'Opening…' : 'Friend · Start a chat'}</small></span>
    </button>
  </PresenceWrap>;
});

export default function DmInbox({ conversations, friends, selectedId, onSelect, onMenu, onStart, isLoading, onNewConversation }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(() => selectConversations(conversations, deferredQuery, filter), [conversations, deferredQuery, filter]);
  const availableFriends = useMemo(() => selectUnstartedFriends(friends, conversations, deferredQuery, filter), [friends, conversations, deferredQuery, filter]);
  const unread = conversations.filter(item => item.unreadCount).length;
  const pinned = visible.filter(item => item.pinned);
  const recent = visible.filter(item => !item.pinned);
  const renderRows = items => items.map(conversation => <ConversationRow key={conversation.id} conversation={conversation} selected={Number(conversation.id) === Number(selectedId)} onSelect={onSelect} onMenu={onMenu} />);
  return <div className="dm-inbox">
    <div className="dm-inbox-tools">
      <label className="dm-inbox-search"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><input type="search" aria-label="Search chats and friends" placeholder="Search chats and friends" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" /></label>
      <div className="dm-inbox-filters" aria-label="Conversation filters">{[['all', 'All'], ['unread', 'Unread'], ['pinned', 'Pinned']].map(([id, label]) => <button key={id} type="button" aria-label={label} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}{id === 'unread' && unread ? <span>{unread}</span> : null}</button>)}</div>
    </div>
    <div className="dm-inbox-list">
      {isLoading ? <DmSkeleton /> : visible.length || availableFriends.length ? <>
        {pinned.length ? <section aria-label="Pinned conversations"><h3>Pinned <span>{pinned.length}</span></h3>{renderRows(pinned)}</section> : null}
        {recent.length ? <section aria-label="Recent conversations"><h3>Recent <span>{recent.length}</span></h3>{renderRows(recent)}</section> : null}
        {availableFriends.length ? <section aria-label="Friends without a conversation"><h3>Start a chat <span>{availableFriends.length}</span></h3>{availableFriends.map(friend => <FriendRow key={friend.id} friend={friend} onStart={onStart} />)}</section> : null}
      </> : <div className="dm-inbox-empty"><strong>{query ? 'No chats or friends found' : filter === 'unread' ? 'All caught up' : filter === 'pinned' ? 'No pinned conversations' : 'Your inbox starts here'}</strong><p>{query ? 'Try a name or a message preview.' : filter === 'pinned' ? 'Open conversation options to pin a chat.' : 'Add a friend to start a private conversation.'}</p><button type="button" onClick={onNewConversation}>Add a friend</button></div>}
    </div>
  </div>;
}
