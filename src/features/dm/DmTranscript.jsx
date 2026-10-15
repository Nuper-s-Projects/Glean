import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Avatar, MessageAttachment } from './DmPrimitives';
import { formatDateDivider, formatMessageTime, isGroupedMessage, shouldShowDivider } from './formatters';
import { MessageBody } from './MessageBody';
import DisplayName from './DisplayName';
import CustomBadges from './CustomBadges';
import { MessageHoverActions, ReplyQuote } from './MessageActions';
import { DmSkeleton } from './DmInbox';
import { useChatAutoscroll } from './useChatAutoscroll';
import { CloseIcon, MoreIcon } from './icons';
import { messageMentionsUser } from './mentions';
import MessageEditor from './MessageEditor';
import { GroupAvatar } from './GroupDmDialog';
import { useMessageReport } from './MessageReports';

const MessageRow = memo(function MessageRow({ message, previous, account, peer, mentionUsers, blocked, openProfile, onReply, onEdit, onDelete, editing, editDraft, onEditDraft, onSubmitEdit, onCancelEdit, onRetry, onDiscard }) {
  const grouped = isGroupedMessage(previous, message);
  const isAuthor = Number(message.sender?.id) === Number(account.id);
  const reporting = useMessageReport(message, 'dm', isAuthor);
  const sender = isAuthor ? { ...message.sender, ...account } : { ...message.sender, ...(Number(peer?.id) === Number(message.sender?.id) ? peer : {}) };
  const persisted = Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0;
  return <div className="dm-transcript-entry">
    {shouldShowDivider(previous, message) ? <div className="dm-date-divider"><span>{formatDateDivider(message.createdAt)}</span></div> : null}
    <article onContextMenu={reporting.onContextMenu} className={`dm-message${isAuthor ? ' is-own' : ''}${message.status === 'failed' ? ' is-failed' : ''}${grouped ? ' is-grouped' : ''}${messageMentionsUser(message.body, account.username) ? ' is-mentioned' : ''}`} id={persisted ? `m-${message.id}` : undefined}>
      {grouped ? <span className="dm-avatar-spacer"><time title={new Date(message.createdAt).toLocaleString()}>{formatMessageTime(message.createdAt)}</time></span> : <Avatar user={sender} />}
      <div className="dm-message-body">
        {!grouped ? <div className="dm-message-meta"><div className="dm-message-author-line"><button type="button" className="dm-message-author" onClick={event => openProfile(sender, event.currentTarget)}><DisplayName user={sender} /></button><CustomBadges badges={sender.customBadges} inline /></div><time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{formatMessageTime(message.createdAt)}</time>{message.editedAt ? <small className="community-edited-label">edited</small> : null}</div> : null}
        <MessageHoverActions canReport={reporting.canReport} onReport={reporting.report} canReply={persisted && !blocked && !message.decryptionFailed} canEdit={persisted && isAuthor && !message.encrypted} canDelete={persisted && isAuthor} onReply={() => onReply(message)} onEdit={() => onEdit(message)} onDelete={() => onDelete(message)} />
        {persisted && (isAuthor || (!blocked && !message.decryptionFailed)) ? <details className="dm-message-options" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
          <summary aria-label="Message options" title="Message options"><MoreIcon /></summary>
          <div onClick={event => { event.currentTarget.closest('details').open = false; }}>
            {reporting.canReport ? <button type="button" onClick={reporting.report}>Report message</button> : null}
            {!blocked && !message.decryptionFailed ? <button type="button" onClick={() => onReply(message)}>Reply</button> : null}
            {isAuthor && !message.encrypted ? <button type="button" onClick={() => onEdit(message)}>Edit message</button> : null}
            {isAuthor ? <button type="button" className="is-danger" onClick={() => onDelete(message)}>Delete message</button> : null}
          </div>
        </details> : null}
        <ReplyQuote reply={message.replyTo} />
        {editing ? <MessageEditor key={message.id} message={message} draft={editDraft} onDraft={onEditDraft} onSubmit={onSubmitEdit} onCancel={onCancelEdit} /> : <>
          {message.body ? <MessageBody className="dm-message-text" body={message.body} users={mentionUsers} currentUsername={account.username} /> : null}
          {grouped && message.editedAt ? <small className="community-edited-label">edited</small> : null}
          {message.status === 'sending' ? <small className="dm-message-status" role="status">{message.sendLabel || 'Sending…'}</small> : message.status === 'failed' ? <div className="dm-send-failure" role="status"><span>Not sent</span><button type="button" onClick={() => onRetry(message.id)}>Retry</button><button type="button" onClick={() => onDiscard(message.id)}>Dismiss</button></div> : null}
        </>}
        {message.attachments?.length ? <div className="dm-message-attachments">{message.attachments.map(attachment => <MessageAttachment key={attachment.id} attachment={attachment} message={message} accountId={account.id} />)}</div> : null}
      </div>
    </article>
    {reporting.menu}
  </div>;
});

export default function DmTranscript({ conversation, account, messages, isLoading, error, onRetryHistory, hasMore, isLoadingOlder, onLoadOlder, searchOpen, onCloseSearch, mentionUsers, editingMessageId, ...actions }) {
  const scrollRef = useRef(null);
  const anchorRef = useRef(null);
  const olderLock = useRef(false);
  const [query, setQuery] = useState('');
  const [resultIndex, setResultIndex] = useState(0);
  const hasDecryptionErrors = useMemo(() => messages.some(message => message.decryptionFailed === true), [messages]);
  const results = useMemo(() => query.trim() ? messages.filter(message => !message.decryptionFailed && message.body?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [], [messages, query]);
  const { atBottom, hasNewMessages, jumpToBottom } = useChatAutoscroll(scrollRef, isLoading ? null : conversation.id, messages.at(-1)?.id ?? 0);
  const loadOlder = useCallback(async () => {
    const node = scrollRef.current;
    if (!node || olderLock.current || !hasMore || isLoadingOlder) return;
    olderLock.current = true;
    const viewportTop = node.getBoundingClientRect().top;
    const first = [...node.querySelectorAll('.dm-transcript-entry')].find(entry => entry.getBoundingClientRect().top >= viewportTop) || node.querySelector('.dm-transcript-entry');
    anchorRef.current = first ? { node: first, top: first.getBoundingClientRect().top, firstId: messages[0]?.id } : null;
    try { await onLoadOlder(); } finally { olderLock.current = false; }
  }, [hasMore, isLoadingOlder, onLoadOlder, messages]);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor?.node.isConnected && scrollRef.current && messages[0]?.id !== anchor.firstId) {
      scrollRef.current.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top;
      anchorRef.current = null;
    }
  }, [messages]);
  useEffect(() => { setResultIndex(0); }, [query]);
  useEffect(() => {
    if (!searchOpen || !results.length) return;
    const node = document.getElementById(`m-${results[Math.min(resultIndex, results.length - 1)].id}`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node?.classList.add('is-jump');
    const timer = window.setTimeout(() => node?.classList.remove('is-jump'), 1400);
    return () => window.clearTimeout(timer);
  }, [results, resultIndex, searchOpen]);
  return <div className="dm-transcript">
    {searchOpen ? <div className="dm-chat-search"><label><span>Find in loaded messages</span><input type="search" autoFocus value={query} onChange={event => setQuery(event.target.value)} aria-label="Find in conversation" placeholder="Search this conversation" onKeyDown={event => { if (event.key === 'Escape') onCloseSearch(); }} /></label><span className="dm-search-results" role="status">{query ? results.length ? `${Math.min(resultIndex + 1, results.length)} / ${results.length}` : 'No matches' : ''}</span><button type="button" disabled={!results.length} onClick={() => setResultIndex(value => (value - 1 + results.length) % results.length)} aria-label="Previous match">↑</button><button type="button" disabled={!results.length} onClick={() => setResultIndex(value => (value + 1) % results.length)} aria-label="Next match">↓</button><button type="button" onClick={onCloseSearch} aria-label="Close conversation search"><CloseIcon /></button></div> : null}
    {hasNewMessages ? <button className="dm-new-messages-banner" type="button" onClick={jumpToBottom}>New messages ↓</button> : null}
    {!isLoading && hasDecryptionErrors ? <aside className="dm-key-recovery-notice" role="status" aria-label="Direct message key recovery">
      <div><strong>Some messages need a DM key this browser can’t access.</strong><p>Open Settings → Security → Advanced recovery to restore your existing key. If it can’t be restored, that section explains what creating a new key means for old messages.</p></div>
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('glean-open-dm-recovery'))}>Open recovery settings</button>
    </aside> : null}
    <div className="dm-message-scroll" ref={scrollRef} onScroll={event => { if (event.currentTarget.scrollTop < 120 && !searchOpen) loadOlder(); }} aria-label="Conversation messages" aria-busy={isLoading}>
      {isLoading ? <DmSkeleton transcript /> : null}
      {!isLoading && error ? <div className="dm-history-error" role="alert"><strong>Conversation unavailable</strong><p>{error}</p><button type="button" onClick={onRetryHistory}>Try again</button></div> : null}
      {!isLoading && (!error || messages.length > 0) ? <>
        {hasMore ? <button className="dm-load-older" type="button" onClick={loadOlder} disabled={isLoadingOlder}>{isLoadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}</button> : <div className="dm-history-start">{conversation.kind === 'group' ? <GroupAvatar large /> : <Avatar user={conversation.user} large />}<h1><DisplayName user={conversation.user} /></h1><p>{conversation.kind === 'group' ? 'Your private group conversation. Messages and attachments are end-to-end encrypted.' : conversation.user.isBot ? 'Nura is Glean’s AI companion. Your messages and images are sent to Groq for responses, so this chat is not end-to-end encrypted. Images are supported; videos are not.' : messages.length ? 'The beginning of your conversation.' : 'Say hello. This is your private conversation.'}</p></div>}
        {messages.map((message, index) => <MessageRow key={message.id} message={message} previous={messages[index - 1]} account={account} peer={conversation.kind === 'group' ? conversation.members.find(member => Number(member.id) === Number(message.sender?.id)) : conversation.user} blocked={conversation.blocked} mentionUsers={mentionUsers} editing={Number(editingMessageId) === Number(message.id)} {...actions} />)}
        <div data-chat-end aria-hidden="true" />
      </> : null}
    </div>
    {!atBottom ? <button className="dm-jump-latest" type="button" onClick={jumpToBottom}>Latest messages ↓</button> : null}
  </div>;
}
