import { EditIcon, ReplyIcon, TrashIcon } from './icons';

export function jumpToMessage(id) {
  const node = document.getElementById(`m-${id}`);
  if (!node) return;
  node.scrollIntoView({ behavior: document.documentElement.classList.contains('glean-reduce-motion') ? 'auto' : 'smooth', block: 'center' });
  node.classList.add('is-jump');
  window.setTimeout(() => node.classList.remove('is-jump'), 1200);
}

export function ReplyQuote({ reply }) {
  if (!reply) return null;
  return (
    <button type="button" className="dm-reply-quote" onClick={() => jumpToMessage(reply.id)}>
      <span className="dm-reply-quote-author">↪ {reply.deleted ? 'Original message' : `@${reply.username || 'Unknown'}`}</span>
      <span className="dm-reply-quote-content">{reply.deleted ? 'Original message was deleted.' : (reply.body || 'Attachment')}</span>
      {reply.attachments?.length ? <span className="dm-reply-quote-attachment">{reply.attachments.length} attachment{reply.attachments.length === 1 ? '' : 's'}</span> : null}
    </button>
  );
}

export function MessageHoverActions({ canReply, canEdit, canDelete, canReact, onReply, onEdit, onDelete, onReact }) {
  if (!canReply && !canEdit && !canDelete && !canReact) return null;
  return (
    <div className="community-message-actions">
      {canReact ? <button type="button" className="community-message-react" onClick={onReact} aria-label="Add reaction" title="Add reaction">☺</button> : null}
      {canReply ? <button type="button" onClick={onReply} aria-label="Reply" title="Reply"><ReplyIcon /></button> : null}
      {canEdit ? <button type="button" className="community-message-edit" onClick={onEdit} aria-label="Edit message" title="Edit message"><EditIcon /></button> : null}
      {canDelete ? <button type="button" className="community-message-delete" onClick={onDelete} aria-label="Delete message" title="Delete message"><TrashIcon /></button> : null}
    </div>
  );
}
