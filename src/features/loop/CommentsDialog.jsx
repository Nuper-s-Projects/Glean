import { useEffect, useId, useRef } from 'react';
import LoopComments from './LoopComments';
import CommentIcon from './CommentIcon';

export default function CommentsDialog({ post, onClose, onCount, onOpenProfile, focusCommentId }) {
  const dialog = useRef(null);
  const title = useId();
  useEffect(() => {
    const previous = document.activeElement, element = dialog.current;
    element.showModal();
    const viewport = window.visualViewport;
    const resize = () => {
      const height=viewport?.height || window.innerHeight;
      element.style.setProperty('--comments-viewport-height', `${height}px`);
      element.style.setProperty('--comments-keyboard-offset', `${Math.max(0,window.innerHeight-(viewport?.height || window.innerHeight)-(viewport?.offsetTop || 0))}px`);
      element.dataset.compact=String(height<500);
      element.dataset.short=String(height<360);
    };
    resize(); viewport?.addEventListener('resize',resize); viewport?.addEventListener('scroll',resize);
    window.addEventListener('resize',resize);
    return () => {
      viewport?.removeEventListener('resize',resize); viewport?.removeEventListener('scroll',resize); window.removeEventListener('resize',resize);
      if (element.open) element.close();
      if (previous?.isConnected) previous.focus({preventScroll:true});
    };
  }, []);
  const profile = (id, username) => { onClose(); onOpenProfile?.(id,username); };
  const keyboard = event => {
    if (event.key!=='Tab') return;
    const controls=[...dialog.current.querySelectorAll('button:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(element=>element.getClientRects().length);
    const first=controls[0], last=controls.at(-1);
    if (event.shiftKey && document.activeElement===first) {event.preventDefault();last?.focus();}
    else if (!event.shiftKey && document.activeElement===last) {event.preventDefault();first?.focus();}
  };
  return <dialog ref={dialog} className="loop-comments-dialog" aria-labelledby={title} onKeyDown={keyboard} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget){const box=event.currentTarget.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)onClose();}}}>
    <div className="loop-comments-viewer">
      <header className="loop-comments-heading"><h2 id={title}>Comments <span>{Number(post.comments || 0).toLocaleString()}</span></h2><button type="button" aria-label="Close comments" autoFocus onClick={onClose}><CommentIcon name="close"/></button></header>
      <div className="loop-comments-post-context"><button className="loop-comment-avatar" type="button" aria-label={`View ${post.author.username}'s profile`} onClick={()=>profile(post.author.id,post.author.username)}>{post.author.avatarUrl ? <img src={post.author.avatarUrl} alt="" decoding="async"/> : <span>{post.author.username.slice(0,2).toUpperCase()}</span>}</button><div><strong>{post.author.username}</strong><p>{post.content || post.poll?.question || post.media?.[0]?.name || 'Post attachment'}</p></div></div>
      <LoopComments key={post.id} postId={post.id} onCount={onCount} onOpenProfile={profile} focusCommentId={focusCommentId}/>
    </div>
  </dialog>;
}
