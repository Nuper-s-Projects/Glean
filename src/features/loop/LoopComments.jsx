import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { subscribeToDmEvents } from '../../app/dmApi';
import CommentIcon from './CommentIcon';

function CommentText({ text }) {
  return text.split(/(@[^\s@]{1,32})/gu).map((part,index) => part.startsWith('@') ? <span className="loop-mention" key={index}>{part}</span> : part);
}

function relativeTime(value) {
  const elapsed=Math.max(0,Date.now()-Date.parse(value));
  if (!Number.isFinite(elapsed) || elapsed<60000) return 'Just now';
  if (elapsed<3600000) return `${Math.floor(elapsed/60000)}m ago`;
  if (elapsed<86400000) return `${Math.floor(elapsed/3600000)}h ago`;
  if (elapsed<604800000) return `${Math.floor(elapsed/86400000)}d ago`;
  return new Date(value).toLocaleDateString();
}

const ThreadList = memo(function ThreadList({ postId, parentId = null, onReply, onCount, onOpenProfile, onWrite, focusPath, sent, depth = 0 }) {
  const [items,setItems]=useState([]), [next,setNext]=useState(null), [error,setError]=useState(''), [busy,setBusy]=useState(false);
  const itemsRef=useRef(items), alive=useRef(false), loading=useRef(false), requests=useRef(new Set()), handled=useRef(new Set()), deleted=useRef(new Set()), retry=useRef(null);
  itemsRef.current=items;
  const focus=focusPath[depth] || null;
  const read=useCallback(async (after,signal,focused=focus) => {
    const params=new URLSearchParams();
    if (parentId) params.set('parent',parentId);
    if (after) params.set('after',after); else if (focused) params.set('focus',focused);
    return apiRequest(`/loop/posts/${postId}/comments?${params}`,{signal});
  },[postId,parentId,focus]);
  const load=useCallback(async (after=null,refresh=false) => {
    if (loading.current) return;
    const controller=new AbortController(); requests.current.add(controller); loading.current=true;
    setBusy(true);setError('');
    try {
      let data=await read(after,controller.signal), rows=data.comments;
      // Reconnecting must not collapse the pages someone has already opened.
      const last=refresh ? itemsRef.current.at(-1)?.id : null;
      while (last && data.page?.nextAfter && rows.at(-1)?.id<last) {
        data=await read(data.page.nextAfter,controller.signal); rows=[...rows,...data.comments];
      }
      if (controller.signal.aborted || !alive.current) return;
      rows=rows.map(item=>deleted.current.has(item.id) ? {...item,deleted:true,content:''} : item);
      setItems(current=>after || !refresh ? [...new Map([...current,...rows].map(item=>[item.id,item])).values()].sort((a,b)=>a.id-b.id) : rows);
      setNext(data.page?.nextAfter || null);
    } catch(failure) {
      if (!controller.signal.aborted && alive.current) { setError(failure.message);retry.current=()=>load(after,refresh); }
    } finally {
      requests.current.delete(controller);
      if (!controller.signal.aborted && alive.current) { loading.current=false;setBusy(false); }
    }
  },[read]);
  const created=useCallback(async data => {
    if (handled.current.has(data.commentId)) return;
    handled.current.add(data.commentId);
    if (handled.current.size>128) handled.current.delete(handled.current.values().next().value);
    const direct=(data.parentId || null)===parentId;
    const id=direct ? data.commentId : data.parentId;
    if (!direct && !itemsRef.current.some(item=>item.id===id)) return;
    const controller=new AbortController();requests.current.add(controller);
    try {
      const dataPage=await read(null,controller.signal,id);
      const found=dataPage.comments.find(comment=>comment.id===id);
      const item=found && deleted.current.has(found.id) ? {...found,deleted:true,content:''} : found;
      if (item && alive.current && !controller.signal.aborted) setItems(current=>[...new Map([...current,item].map(comment=>[comment.id,comment])).values()].sort((a,b)=>a.id-b.id));
    } catch(failure) {
      if (alive.current && !controller.signal.aborted) {setError(failure.message);retry.current=()=>{handled.current.delete(data.commentId);created(data);};}
    } finally { requests.current.delete(controller); }
  },[parentId,read]);
  const removed=useCallback(id=>{deleted.current.add(id);setItems(current=>current.map(item=>item.id===id ? {...item,deleted:true,content:''} : item));},[]);
  useEffect(()=>{
    alive.current=true; loading.current=false; load();
    const subscription=subscribeToDmEvents((event,data)=>{
      if (event==='connected' && itemsRef.current.length) load(null,true);
      if (Number(data?.postId)!==postId) return;
      if (event==='loop-comment-created') created(data);
      if (event==='loop-comment-deleted') removed(Number(data.commentId));
    });
    return ()=>{alive.current=false;subscription.close();for(const request of requests.current)request.abort();requests.current.clear();handled.current.clear();};
  },[postId,load,created,removed]);
  useEffect(()=>{if(sent)created({commentId:sent.id,parentId:sent.parentId});},[sent,created]);
  return <div className="loop-comment-list" aria-busy={busy}>
    {items.map(item=><Comment key={item.id} {...{item,postId,onReply,onCount,onOpenProfile,onWrite,focusPath,sent,depth}} onRemoved={removed}/>)}
    {!items.length && !busy && !error ? parentId ? <p className="loop-muted">No replies yet.</p> : <div className="loop-comment-empty"><CommentIcon name="comment" size={32}/><h3>No comments yet</h3><p>Be the first to join the conversation.</p><button type="button" onClick={onWrite}>Write a comment</button></div> : null}
    {busy ? <div className="loop-comment-skeleton" role="status" aria-label="Loading comments"><span/><div><i/><i/></div></div> : null}
    {error ? <div className="loop-comment-load-error" role="alert"><p>{error}</p><button type="button" onClick={()=>{setError('');retry.current?.();}}>Try again</button></div> : null}
    {next ? <button className="loop-thread-more" type="button" disabled={busy} onClick={()=>load(next)}>{busy ? 'Loading…' : `Load more ${parentId ? 'replies' : 'comments'}`}<CommentIcon name="down" size={16}/></button> : null}
  </div>;
});

const Comment = memo(function Comment({ item,postId,onReply,onCount,onOpenProfile,onWrite,focusPath,sent,depth,onRemoved }) {
  const [expanded,setExpanded]=useState(focusPath[depth]===item.id && focusPath.length>depth+1);
  const [confirming,setConfirming]=useState(false), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const node=useRef(null), alive=useRef(true), lock=useRef(false), thread=useId();
  const selected=focusPath.at(-1)===item.id, recent=sent?.id===item.id;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(selected || recent)node.current?.scrollIntoView({block:selected ? 'center' : 'nearest',behavior:'auto'});},[selected,recent]);
  useEffect(()=>{if(sent?.parentId===item.id)setExpanded(true);},[sent,item.id]);
  const remove=async()=>{
    if (lock.current) return;
    lock.current=true;setBusy(true);setError('');
    try {await apiRequest(`/loop/comments/${item.id}`,{method:'DELETE'});if(alive.current){setConfirming(false);onRemoved(item.id);onCount?.();}}
    catch(failure){if(alive.current)setError(failure.message);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  return <div className={`loop-thread${selected || recent ? ' is-highlighted' : ''}`} ref={node}>
    <div className="loop-comment">
      <button className="loop-comment-avatar" type="button" aria-label={`View ${item.author.username}'s profile`} onClick={()=>onOpenProfile?.(item.author.id,item.author.username)}>{item.author.avatarUrl ? <img src={item.author.avatarUrl} alt="" loading="lazy" decoding="async"/> : <span>{item.author.username.slice(0,2).toUpperCase()}</span>}</button>
      <div className="loop-comment-content"><div className="loop-comment-byline"><button type="button" onClick={()=>onOpenProfile?.(item.author.id,item.author.username)}>{item.author.username}</button><time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</time></div>
        <p>{item.deleted ? <em>Comment deleted</em> : <CommentText text={item.content}/>}</p>
        <div className="loop-comment-controls">
          {!item.deleted ? <button type="button" onClick={()=>onReply(item)}>Reply</button> : null}
          {item.replyCount ? <button type="button" aria-expanded={expanded} aria-controls={thread} onClick={()=>setExpanded(value=>!value)}><CommentIcon name="down" size={14}/>{expanded ? 'Hide replies' : `View ${item.replyCount} ${item.replyCount===1 ? 'reply' : 'replies'}`}</button> : null}
          {item.own && !item.deleted ? <button type="button" disabled={busy} onClick={()=>setConfirming(value=>!value)}>Delete</button> : null}
        </div>
        {confirming && !item.deleted ? <div className="loop-comment-delete-confirm" role="group" aria-label="Confirm comment deletion"><span>Delete this comment? Replies will stay.</span><div><button type="button" disabled={busy} onClick={()=>setConfirming(false)}>Cancel</button><button type="button" disabled={busy} onClick={remove}>{busy ? 'Deleting…' : 'Delete comment'}</button></div></div> : null}
        {error ? <p className="loop-inline-error" role="alert">{error}</p> : null}
      </div>
    </div>
    {expanded ? <div id={thread} className={depth<3 ? 'loop-thread-children' : 'loop-thread-children is-deep'}><ThreadList {...{postId,onReply,onCount,onOpenProfile,onWrite,focusPath,sent}} parentId={item.id} depth={depth+1}/></div> : null}
  </div>;
});

export default function LoopComments({ postId,onCount,onOpenProfile,focusCommentId }) {
  const [draft,setDraft]=useState(''), [reply,setReply]=useState(null), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const [suggestions,setSuggestions]=useState([]), [path,setPath]=useState([]), [sent,setSent]=useState(null), [caret,setCaret]=useState(0), [selected,setSelected]=useState(-1), [dismissed,setDismissed]=useState(false);
  const input=useRef(null), lock=useRef(false), alive=useRef(true);
  const suggestionId=useId();
  const mention=draft.slice(0,caret).match(/(?:^|\s)@([^\s@]*)$/u)?.[1];
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useLayoutEffect(()=>{const element=input.current;if(element){element.style.height='auto';element.style.height=`${Math.min(128,Math.max(48,element.scrollHeight))}px`;}},[draft]);
  useEffect(()=>{
    setSelected(-1);setSuggestions([]);
    if (mention===undefined || dismissed) return;
    const controller=new AbortController();
    const timer=setTimeout(()=>apiRequest(`/loop/users?q=${encodeURIComponent(mention)}`,{signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setSuggestions(data.users.slice(0,5));}).catch(()=>{if(!controller.signal.aborted)setSuggestions([]);}),180);
    return()=>{controller.abort();clearTimeout(timer);};
  },[mention,dismissed]);
  useEffect(()=>{
    const controller=new AbortController();
    if (!focusCommentId) {setPath([]);return;}
    apiRequest(`/loop/comments/${focusCommentId}/thread`,{signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setPath([...data.ancestors,data.commentId]);}).catch(failure=>{if(!controller.signal.aborted)setError(failure.message);});
    return()=>controller.abort();
  },[focusCommentId]);
  const focusInput=useCallback(()=>input.current?.focus({preventScroll:true}),[]);
  const selectReply=useCallback(item=>{setReply(item);focusInput();},[focusInput]);
  const send=async event=>{
    event.preventDefault();if(lock.current || !draft.trim())return;
    lock.current=true;setBusy(true);setError('');
    try {
      const data=await apiRequest(`/loop/posts/${postId}/comments`,{method:'POST',body:JSON.stringify({content:draft.trim(),parentId:reply?.id || null})});
      if (!alive.current) return;
      setSent({id:data.id,parentId:data.parentId});setDraft('');setCaret(0);setReply(null);setSuggestions([]);onCount?.();
    } catch(failure){if(alive.current)setError(failure.message);}
    finally{lock.current=false;if(alive.current){setBusy(false);requestAnimationFrame(focusInput);}}
  };
  const chooseMention=user=>{
    const start=draft.slice(0,caret).lastIndexOf('@');
    if(start<0)return;
    const replacement=`@${user.username} `, value=draft.slice(0,start)+replacement+draft.slice(caret);
    if(value.length>1000){setError('That mention would make your comment too long.');return;}
    setDraft(value);setCaret(start+replacement.length);setSuggestions([]);setDismissed(true);
    requestAnimationFrame(()=>{focusInput();input.current?.setSelectionRange(start+replacement.length,start+replacement.length);});
  };
  const addMention=()=>{
    const start=input.current?.selectionStart ?? draft.length, end=input.current?.selectionEnd ?? start;
    const prefix=start && !/\s/u.test(draft[start-1]) ? ' @' : '@';
    const value=draft.slice(0,start)+prefix+draft.slice(end);
    if(value.length>1000)return;
    setDraft(value);setCaret(start+prefix.length);setDismissed(false);
    requestAnimationFrame(()=>{focusInput();input.current?.setSelectionRange(start+prefix.length,start+prefix.length);});
  };
  const keyDown=event=>{
    if(event.nativeEvent.isComposing)return;
    if(suggestions.length && ['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setSelected(value=>value<0 ? (event.key==='ArrowDown' ? 0 : suggestions.length-1) : (value+(event.key==='ArrowDown' ? 1 : -1)+suggestions.length)%suggestions.length);return;}
    if(suggestions.length && event.key==='Escape'){event.preventDefault();event.stopPropagation();setDismissed(true);return;}
    if(suggestions.length && selected>=0 && event.key==='Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey){event.preventDefault();chooseMention(suggestions[selected]);return;}
    if(event.key==='Enter' && !event.shiftKey && (event.ctrlKey || event.metaKey || window.matchMedia('(min-width:701px) and (pointer:fine)').matches))send(event);
  };
  return <section className="loop-comments" aria-label="Post discussion">
    <div className="loop-comments-scroll" tabIndex={0} aria-label="Comments and replies">
      {path.length ? <button className="loop-thread-more" type="button" onClick={()=>setPath([])}>Show all comments</button> : null}
      <ThreadList key={`${postId}:${path.join(',')}`} {...{postId,onCount,onOpenProfile,sent}} onWrite={focusInput} focusPath={path} onReply={selectReply}/>
    </div>
    <div className="loop-comment-composer">
      {reply ? <div className="loop-reply-target"><div><span>Replying to <strong>{reply.author.username}</strong></span><p>{reply.content}</p></div><button type="button" disabled={busy} onClick={()=>{setReply(null);focusInput();}} aria-label="Cancel reply"><CommentIcon name="close"/></button></div> : null}
      {suggestions.length ? <div id={suggestionId} className="loop-mention-suggestions" role="listbox" aria-label="Mention suggestions">{suggestions.map((user,index)=><button type="button" role="option" aria-label={`@${user.username}`} aria-selected={selected===index} id={`${suggestionId}-${index}`} key={user.id} onMouseDown={event=>event.preventDefault()} onClick={()=>chooseMention(user)}>{user.avatarUrl ? <img src={user.avatarUrl} alt=""/> : <span>{user.username.slice(0,2).toUpperCase()}</span>}<strong>@{user.username}</strong></button>)}</div> : null}
      <form className="loop-comment-form" onSubmit={send}>
        <textarea ref={input} aria-label={reply ? `Reply to ${reply.author.username}` : 'Write a comment'} role="combobox" aria-autocomplete="list" aria-expanded={Boolean(suggestions.length)} aria-controls={suggestions.length ? suggestionId : undefined} aria-activedescendant={suggestions.length && selected>=0 ? `${suggestionId}-${selected}` : undefined} value={draft} maxLength={1000} rows={1} placeholder={reply ? 'Write a reply…' : 'Write a comment…'} onChange={event=>{setDraft(event.target.value);setCaret(event.target.selectionStart);setDismissed(false);}} onSelect={event=>setCaret(event.target.selectionStart)} onKeyDown={keyDown} disabled={busy}/>
        <button type="submit" aria-label={reply ? 'Send reply' : 'Send comment'} disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send'}<CommentIcon name="send" size={18}/></button>
      </form>
      <div className="loop-comment-composer-tools"><button type="button" disabled={busy || draft.length>=1000} onClick={addMention}>@ <span>Mention</span></button><small className="loop-comment-keyboard-hint">Enter to send · Shift + Enter for a new line</small><small>{draft.length}/1000</small></div>
      {error ? <p className="loop-inline-error" role="alert">{error}</p> : null}
    </div>
  </section>;
}
