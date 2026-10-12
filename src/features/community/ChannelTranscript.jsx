import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { CommunityAvatar } from './CommunityAvatar';
import { MessageAttachment } from '../dm/DmPrimitives';
import { formatDateDivider, formatMessageTime, isGroupedMessage, shouldShowDivider } from '../dm/formatters';
import { MessageBody } from '../dm/MessageBody';
import { messageMentionsUser } from '../dm/mentions';
import { MessageHoverActions, ReplyQuote } from '../dm/MessageActions';
import DisplayName from '../dm/DisplayName';
import CustomBadges from '../dm/CustomBadges';
import ChannelPoll from './ChannelPoll';
import EmojiPicker from '../dm/EmojiPicker';
import { MoreIcon } from '../dm/icons';

function messageId(value) {
  return Number(value?.id ?? value);
}

const MESSAGE_CALLBACKS = ['onOpenAuthor', 'onModerationContextMenu', 'onReply', 'onEdit', 'onDelete', 'onEditDraft', 'onSubmitEdit', 'onCancelEdit', 'onToggleReaction', 'onOpenReactions', 'onVotePoll', 'onClosePoll'];

const ChannelMessageRow = memo(function ChannelMessageRow({
  message,
  previous,
  accountId,
  accountUsername,
  mentionUsers,
  canModerate,
  inspecting,
  canPost = true,
  isEditing,
  editDraft,
  reactionPickerId,
  onOpenAuthor,
  onModerationContextMenu,
  onReply,
  onEdit,
  onDelete,
  onEditDraft,
  onSubmitEdit,
  onCancelEdit,
  onToggleReaction,
  onOpenReactions,
  onVotePoll,
  onClosePoll,
}) {
  const isAuthor = Number(message.author?.id) === Number(accountId);
  const canEdit = isAuthor;
  const canDelete = isAuthor || canModerate;
  const grouped = isGroupedMessage(previous, message);
  const id = messageId(message);
  const saved = Number.isFinite(id) && id > 0;
  const hasActions = saved && ((!inspecting && canPost) || (canEdit && canPost) || canDelete);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsButton = useRef(null);
  const act = (callback) => { setActionsOpen(false); callback(); };
  const pickerRef = useRef(null);
  const [pickerPlacement, setPickerPlacement] = useState('below');
  const pickerOpen = Number(reactionPickerId) === id;

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const updatePickerPlacement = () => {
      const picker = pickerRef.current?.querySelector('.dm-emoji-picker');
      if (!picker) return;
      const bounds = picker.getBoundingClientRect();
      const shouldOpenAbove = bounds.bottom > window.innerHeight - 12 && bounds.top > 12;
      setPickerPlacement(shouldOpenAbove ? 'above' : 'below');
    };
    updatePickerPlacement();
    window.addEventListener('resize', updatePickerPlacement);
    return () => {
      window.removeEventListener('resize', updatePickerPlacement);
    };
  }, [pickerOpen]);
  return (
    <div className="community-message-row">
      {shouldShowDivider(previous, message) ? <div className="community-date-divider"><span>{formatDateDivider(message.createdAt)}</span></div> : null}
      <article className={`community-message${grouped ? ' is-grouped' : ''}${actionsOpen ? ' has-open-actions' : ''}${messageMentionsUser(message.body, accountUsername) ? ' is-mentioned' : ''}`} id={Number.isFinite(id) ? `m-${id}` : undefined} onKeyDown={(event) => {
        if (event.key === 'Escape' && actionsOpen) { event.stopPropagation(); setActionsOpen(false); actionsButton.current?.focus(); }
      }}>
        {grouped ? <span className="community-avatar-spacer"><time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time></span> : <CommunityAvatar user={message.author} onContextMenu={(event) => onModerationContextMenu?.(event, message.author)} />}
        <div className="community-message-body">
          {hasActions ? <button ref={actionsButton} type="button" className="community-message-tools-toggle" aria-label="Message actions" aria-expanded={actionsOpen} aria-controls={`server-message-actions-${id}`} onClick={() => setActionsOpen(value => !value)}><MoreIcon /></button> : null}
          {grouped ? null : (
            <div className="community-message-meta">
              <div className="dm-message-author-line">
                <button type="button" className="dm-message-author" onClick={(event) => onOpenAuthor(message.author, event.currentTarget)}><DisplayName user={message.author} /></button>
                <CustomBadges badges={message.author.customBadges} inline />
                {message.author.isBot ? <span className="community-bot-badge">BOT</span> : null}
              </div>
              <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
              {message.editedAt ? <small className="community-edited-label">edited</small> : null}
            </div>
          )}
          {isEditing ? (
            <form className="community-edit-form" onSubmit={(event) => onSubmitEdit(event, message)}>
              <textarea value={editDraft} onChange={(event) => onEditDraft(event.target.value)} maxLength="4000" autoFocus aria-label="Edit message" />
              <div><button type="submit" disabled={!editDraft.trim() && !message.attachments?.length}>Save</button><button type="button" onClick={onCancelEdit}>Cancel</button></div>
            </form>
          ) : (
            <>
              <ReplyQuote reply={message.replyTo} />
              {message.body ? <MessageBody className="community-message-text" body={message.body} users={mentionUsers} currentUsername={accountUsername} /> : null}
              {message.poll ? (
                <ChannelPoll
                  poll={message.poll}
                  canClose={(isAuthor || canModerate) && !inspecting}
                  disabled={inspecting}
                  onVote={(optionIndex) => onVotePoll?.(message, optionIndex)}
                  onClose={() => onClosePoll?.(message)}
                />
              ) : null}
              {grouped && message.editedAt ? <small className="community-edited-label">edited</small> : null}
            </>
          )}
          {isEditing ? null : message.attachments?.length ? <div className="dm-message-attachments">{message.attachments.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} message={message} accountId={accountId} />)}</div> : null}
          {isEditing ? null : (
            <div className="community-reactions" aria-label="Message reactions" onPointerDown={(event) => event.stopPropagation()}>
              {(message.reactions || []).map((reaction) => <button className={`community-reaction${reaction.reacted ? ' is-reacted' : ''}`} type="button" key={reaction.emoji} onClick={() => onToggleReaction(message, reaction.emoji)} aria-label={`${reaction.emoji} reaction, ${reaction.count}`} title={`${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`}>{reaction.emoji} <span>{reaction.count}</span></button>)}
              {pickerOpen ? <span ref={pickerRef} className={`community-reaction-picker${pickerPlacement === 'above' ? ' is-above' : ''}`}><EmojiPicker onPick={(emoji) => { onToggleReaction(message, emoji); onOpenReactions(null); }} /></span> : null}
            </div>
          )}
          {message.status === 'sending' ? <small className="community-message-pending" role="status">Sending…</small> : null}
          <div id={`server-message-actions-${id}`} className="community-message-tools">
            <MessageHoverActions
              canReply={!inspecting && canPost && saved}
              canReact={!inspecting && canPost && saved}
              canEdit={canEdit && canPost && saved}
              canDelete={canDelete && saved}
              onReply={() => act(() => onReply(message))}
              onReact={() => act(() => onOpenReactions(pickerOpen ? null : id))}
              onEdit={() => act(() => onEdit(message))}
              onDelete={() => act(() => onDelete(message))}
            />
          </div>
        </div>
      </article>
    </div>
  );
});

function ChannelTranscript({
  messages,
  isLoading,
  loadError = '',
  onRetry,
  hasMore,
  isLoadingOlder,
  onLoadOlder,
  activeServer,
  channel,
  account,
  mentionUsers,
  canModerate,
  inspecting,
  canPost = true,
  editingMessageId,
  editDraft,
  reactionPickerId,
  onOpenAuthor,
  onModerationContextMenu,
  onReply,
  onEdit,
  onDelete,
  onEditDraft,
  onSubmitEdit,
  onCancelEdit,
  onToggleReaction,
  onOpenReactions,
  onVotePoll,
  onClosePoll,
}) {
  const handlersRef = useRef(null);
  handlersRef.current = { onOpenAuthor, onModerationContextMenu, onReply, onEdit, onDelete, onEditDraft, onSubmitEdit, onCancelEdit, onToggleReaction, onOpenReactions, onVotePoll, onClosePoll };
  const stableHandlers = useMemo(() => Object.fromEntries(MESSAGE_CALLBACKS.map((name) => [name, (...args) => handlersRef.current[name]?.(...args)])), []);
  if (isLoading) {
    return <div role="status" aria-label="Loading messages">{Array.from({ length: 6 }, (_, index) => <div key={index} className="community-message-skeleton" aria-hidden="true"><i /><span><b /><b /></span></div>)}</div>;
  }
  if (loadError) {
    return <div className="dm-history-error" role="alert"><p>{loadError}</p><button type="button" onClick={onRetry}>Try again</button></div>;
  }
  if (!messages.length) {
    return (
      <div className="dm-welcome">
        <h1>{activeServer ? `Welcome to #${channel?.name || 'general'}` : 'Your servers'}</h1>
        <p>{activeServer ? (channel?.kind === 'rules' ? 'Server rules. Only moderators can post here.' : channel?.kind === 'announcement' ? 'Announcements. Only moderators can post here.' : channel?.locked ? 'This channel is locked.' : 'This is the beginning of this channel.') : 'Create or join a server to start chatting.'}</p>
      </div>
    );
  }
  return (
    <>
      {hasMore ? (
        <button className="dm-load-older" type="button" onClick={onLoadOlder} disabled={isLoadingOlder}>
          {isLoadingOlder ? 'Loading…' : 'Load older messages'}
        </button>
      ) : (
        <div className="dm-welcome community-history-start">
          <h1>#{channel?.name || 'general'}</h1>
          <p>This is the beginning of this channel.</p>
        </div>
      )}
      {messages.map((message, index) => (
        <ChannelMessageRow
          key={message.id}
          message={message}
          previous={messages[index - 1]}
          accountId={account?.id}
          accountUsername={account?.username}
          mentionUsers={mentionUsers}
          canModerate={canModerate}
          inspecting={inspecting}
          canPost={canPost}
          isEditing={Number(editingMessageId) === messageId(message)}
          editDraft={Number(editingMessageId) === messageId(message) ? editDraft : ''}
          reactionPickerId={Number(reactionPickerId) === messageId(message) ? reactionPickerId : null}
          {...stableHandlers}
        />
      ))}
      <div data-chat-end aria-hidden="true" />
    </>
  );
}

export default memo(ChannelTranscript);
