import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiRequest } from '../../app/apiClient';
import { subscribeToDmEvents } from '../../app/dmApi';
import FlowBackground from './FlowBackground';
import LoopVideo from './LoopVideo';
import LoopPoll from './LoopPoll';
import CommentsDialog from './CommentsDialog';
import { loopRequest } from './loopRequest';
import { appendFlowPage } from './flowPlayback';

function FlowIcon({ name }) {
  const paths = {
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>,
    comment: <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5Z"/>,
    save: <path d="M19 21l-7-4-7 4V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1Z"/>,
    share: <><path d="M12 16V3m-5 5 5-5 5 5M5 13v7h14v-7"/></>,
    up: <path d="m6 15 6-6 6 6"/>, down: <path d="m6 9 6 6 6-6"/>,
  };
  return <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function FlowPost({ post, active, focused, onBackgroundChange, muted, onMutedChange, onOpenProfile, onComments, onRefresh, onToast }) {
  const [mediaIndex, setMediaIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const audio = useRef(null);
  const captionId = useId();
  const files = post.media || [];
  const file = files[mediaIndex];
  const visual = Boolean(file && /^(image|video)\//.test(file.mimeType));
  useLayoutEffect(() => {
    if (focused) onBackgroundChange(visual ? { url: file.url, mimeType: file.mimeType } : null);
  }, [focused, file?.url, file?.mimeType, visual, onBackgroundChange]);
  useEffect(() => { setFailed(false); }, [file?.url]);
  useEffect(() => {
    const element = audio.current;
    const pause = () => { if (!active || document.visibilityState !== 'visible') element?.pause(); };
    pause(); document.addEventListener('visibilitychange',pause);
    return () => { element?.pause(); document.removeEventListener('visibilitychange',pause); };
  }, [active,file?.url]);
  const action = async route => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await apiRequest(`/loop/posts/${post.id}/${route}`, { method:'POST', body:'{}' }); await onRefresh(post.id); }
    catch (failure) { onToast(failure.message); }
    finally { lock.current = false; setBusy(false); }
  };
  const share = async () => {
    const url = `${window.location.origin}/loop?post=${post.id}`;
    try {
      if (navigator.share && window.matchMedia('(pointer: coarse)').matches) await navigator.share({title:`Post by ${post.author.username}`,url});
      else { await navigator.clipboard.writeText(url); onToast('Share link copied.'); }
    } catch (failure) { if (failure.name !== 'AbortError') onToast(url); }
  };
  return <article className={`loop-flow-post${visual ? ' has-media' : ''}`} data-post-id={post.id} aria-label={`Post by ${post.author.username}`}>
    <div className="loop-flow-stage">
    <div className="loop-flow-media">
      {failed ? <div className="loop-flow-media-error" role="status"><p>This attachment could not load.</p><button type="button" onClick={() => { setAttempt(value=>value+1);setFailed(false); }}>Retry attachment</button></div>
        : file?.mimeType.startsWith('video/') ? <LoopVideo key={`${file.url}:${attempt}`} file={file} variant="flow" active={active} muted={muted} onMutedChange={onMutedChange} autoPlay loop canRetry={post.own} onError={() => setFailed(true)}/>
        : file?.mimeType.startsWith('image/') ? <img key={file.url} src={file.url} alt={file.name || 'Post attachment'} decoding="async" onError={() => setFailed(true)}/>
        : file?.mimeType.startsWith('audio/') ? <audio ref={audio} src={file.url} controls preload="metadata" onError={() => setFailed(true)}/>
        : file ? <a className="loop-flow-file" href={file.url} download={file.name}>Download {file.name || 'attachment'}</a> : null}
      {post.poll ? <LoopPoll postId={post.id} poll={post.poll}/> : null}
      {!file && !post.poll ? <p className="loop-flow-text-post">{post.content}</p> : null}
    </div>
    <div className={`loop-flow-caption${expanded ? ' is-expanded' : ''}`}>
      {files.length > 1 ? <div className="loop-flow-gallery" role="group" aria-label="Post attachments">{files.map((item,index) => <button type="button" key={item.id || item.url} aria-label={`Show attachment ${index+1}`} aria-pressed={mediaIndex===index} onClick={() => setMediaIndex(index)}>{index+1}</button>)}</div> : null}
      <button className="loop-flow-author" type="button" aria-label={`View ${post.author.username}'s profile`} onClick={() => onOpenProfile(post.author.id, post.author.username)}>
        <span className="loop-flow-avatar">{post.author.avatarUrl ? <img src={post.author.avatarUrl} alt="" loading="lazy"/> : <span>{post.author.username.slice(0,2).toUpperCase()}</span>}</span>
        <span className="loop-flow-author-details"><strong>@{post.author.username}</strong><small>Public{post.createdAt ? <> · <time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</time></> : null}</small></span>
      </button>
      {(file || post.poll) && post.content ? <><p id={captionId}>{post.content}</p>{post.content.length > 140 || post.content.includes('\n') ? <button className="loop-flow-caption-toggle" type="button" aria-expanded={expanded} aria-controls={captionId} onClick={() => setExpanded(value=>!value)}>{expanded ? 'Show less' : 'Read more'}</button> : null}</> : null}
      {post.tags?.length ? <small>{post.tags.map(tag=>'#'+tag).join(' ')}</small> : null}
    </div>
    <div className="loop-flow-actions" role="group" aria-label="Post actions">
      <button type="button" disabled={busy} aria-label={post.liked ? 'Unlike post' : 'Like post'} aria-pressed={Boolean(post.liked)} onClick={() => action('like')}><FlowIcon name="heart"/><span>{post.likes}</span></button>
      <button type="button" aria-label="Comments" aria-haspopup="dialog" onClick={onComments}><FlowIcon name="comment"/><span>{post.comments}</span></button>
      <button type="button" disabled={busy} aria-label={post.bookmarked ? 'Unsave post' : 'Save post'} aria-pressed={Boolean(post.bookmarked)} onClick={() => action('bookmark')}><FlowIcon name="save"/><span>Save</span></button>
      <button type="button" onClick={share} aria-label="Share post"><FlowIcon name="share"/><span>Share</span></button>
    </div>
    </div>
  </article>;
}

function FlowFeed({ muted, onMutedChange, onOpenProfile, onToast }) {
  const [posts,setPosts] = useState([]);
  const [active,setActive] = useState(0);
  const [height,setHeight] = useState(0);
  const [positionVersion,setPositionVersion] = useState(0);
  const [offset,setOffset] = useState(0);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [more,setMore] = useState(false);
  const [discussion,setDiscussion] = useState(null);
  const viewport = useRef(null);
  const [backgroundTarget, setBackgroundTarget] = useState(null);
  const [background, setBackground] = useState(null);
  useLayoutEffect(() => { setBackgroundTarget(viewport.current?.closest('.loop-app') || null); }, []);
  const current = useRef(0);
  const cursor = useRef(null);
  const round = useRef(0);
  const fetching = useRef(false);
  const alive = useRef(false);
  const controller = useRef(null);
  const requestVersion = useRef(0);
  const postIds = useRef(new Set());
  const postList = useRef(posts);
  const resizing = useRef(false);
  const navigationTarget = useRef(null);
  const navigationTimer = useRef(null);
  postIds.current = new Set(posts.map(post=>post.id));
  postList.current = posts;
  const finishMove = useCallback(() => {
    const element=viewport.current,index=navigationTarget.current;
    if(!element || index===null || resizing.current)return;
    clearTimeout(navigationTimer.current);
    navigationTarget.current=null;
    element.scrollTo({top:index*element.clientHeight,behavior:'instant'});
    current.current=index;setActive(index);
    element.style.removeProperty('scroll-snap-type');
  },[]);
  const move = useCallback(index => {
    const element=viewport.current;
    if(!element || resizing.current)return;
    navigationTarget.current=index;
    element.style.scrollSnapType='none';
    element.scrollTo({top:element.scrollTop,behavior:'instant'});
    element.scrollTo({top:index*element.clientHeight,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    clearTimeout(navigationTimer.current);
    navigationTimer.current=setTimeout(finishMove,1000);
  }, [finishMove]);
  const load = useCallback(async ({ force = false } = {}) => {
    if (fetching.current) return;
    fetching.current = true; setBusy(true); setError('');
    const requested = ++requestVersion.current;
    const request = new AbortController();
    controller.current = request;
    try {
      const continuing = Boolean(cursor.current);
      const last = postList.current.at(-1)?.id;
      const data = await loopRequest(`/loop/flow?feed=everyone&limit=12${continuing ? `&cursor=${encodeURIComponent(cursor.current)}` : last ? `&avoid=${last}` : ''}`, {signal:request.signal,force});
      if (!alive.current || request.signal.aborted || requested!==requestVersion.current) return;
      const nextRound=round.current+(continuing ? 0 : 1);
      const appended = appendFlowPage(postList.current,data.posts,nextRound,current.current);
      if (appended.deferred) { setMore(true); return; }
      round.current=nextRound;
      if (appended.removed) {
        clearTimeout(navigationTimer.current);navigationTarget.current=null;
        if(viewport.current){resizing.current=true;viewport.current.style.scrollSnapType='none';}
        current.current-=appended.removed;setActive(current.current);setOffset(value=>value+appended.removed);setPositionVersion(value=>value+1);
      }
      postList.current=appended.posts;setPosts(appended.posts);
      cursor.current = data.page?.nextCursor || null;
      setMore(Boolean(data.posts.length));
    } catch (failure) { if (alive.current && !request.signal.aborted && requested===requestVersion.current) setError(failure.message); }
    finally { if (requested===requestVersion.current) { fetching.current = false; if (alive.current) setBusy(false); } }
  }, []);
  const refresh = useCallback(async id => {
    try {
      const {post} = await loopRequest(`/loop/posts/${id}`, {force:true});
      if (alive.current) setPosts(items => items.map(item=>item.id===id ? { ...post, flowKey:item.flowKey } : item));
    } catch (failure) { if (alive.current) onToast(failure.message); }
  }, [onToast]);
  useEffect(() => {
    alive.current = true; load();
    const sub = subscribeToDmEvents((event,data) => {
      if (['loop-post-updated','loop-comment-created','loop-comment-deleted'].includes(event) && postIds.current.has(Number(data?.postId))) refresh(Number(data.postId));
      if (event === 'loop-post-deleted' && postIds.current.has(Number(data?.postId))) {
        const focusedId = postList.current[current.current]?.flowKey;
        const remaining = postList.current.filter(item=>item.id!==Number(data.postId));
        const focusedIndex = remaining.findIndex(item=>item.flowKey===focusedId);
        const index = Math.max(0,focusedIndex<0 ? Math.min(current.current,remaining.length-1) : focusedIndex);
        clearTimeout(navigationTimer.current);navigationTarget.current=null;
        if(viewport.current){resizing.current=true;viewport.current.style.scrollSnapType='none';}
        setPosts(remaining); current.current=index; setActive(index);setPositionVersion(value=>value+1);
        setDiscussion(value => value?.id===Number(data.postId) ? null : value);
      }
    });
    return () => { alive.current = false; requestVersion.current++; fetching.current=false; controller.current?.abort(); sub.close(); };
  }, [load,refresh]);
  useEffect(() => {
    const element = viewport.current;
    let frame, measuredHeight=0;
    const observer = new ResizeObserver(() => {
      if(measuredHeight===element.clientHeight)return;
      measuredHeight=element.clientHeight;
      clearTimeout(navigationTimer.current);navigationTarget.current=null;
      resizing.current=true;
      element.style.scrollSnapType='none';
      setHeight(measuredHeight);
    });
    observer.observe(element);
    const scroll = () => {
      if (frame || resizing.current) return;
      if(navigationTarget.current!==null) {
        clearTimeout(navigationTimer.current);
        navigationTimer.current=setTimeout(finishMove,180);
      }
      frame = requestAnimationFrame(() => { frame=null;if(resizing.current)return; const index=Math.max(0,Math.min(postList.current.length-1,Math.round(element.scrollTop / Math.max(1,element.clientHeight)))); current.current=index; setActive(index); });
    };
    element.addEventListener('scroll',scroll,{passive:true});
    element.addEventListener('scrollend',finishMove);
    const gesture=()=>{clearTimeout(navigationTimer.current);navigationTarget.current=null;if(!resizing.current)element.style.removeProperty('scroll-snap-type');};
    element.addEventListener('wheel',gesture,{passive:true});element.addEventListener('touchstart',gesture,{passive:true});
    return () => { observer.disconnect(); clearTimeout(navigationTimer.current);element.removeEventListener('scroll',scroll);element.removeEventListener('scrollend',finishMove);element.removeEventListener('wheel',gesture);element.removeEventListener('touchstart',gesture);cancelAnimationFrame(frame); };
  }, [finishMove]);
  useLayoutEffect(() => {
    const element=viewport.current;
    if(!height || !element)return;
    element.scrollTop=current.current*height;
    const frame=requestAnimationFrame(()=>{element.style.removeProperty('scroll-snap-type');resizing.current=false;});
    return()=>cancelAnimationFrame(frame);
  },[height,positionVersion]);
  useEffect(() => { if (more && !error && active >= posts.length-3) load(); }, [active,posts.length,more,error,load]);
  useEffect(() => { if (posts.length && active>=posts.length) { current.current=posts.length-1;setActive(posts.length-1);move(posts.length-1); } },[posts.length,active,move]);
  const start = Math.max(0,active-1), end = Math.min(posts.length,active+2);
  const keyDown = event => {
    if (event.target.closest('button,a,input,textarea,select,video,audio') || discussion) return;
    if (['ArrowDown','PageDown',' ','ArrowUp','PageUp'].includes(event.key)) {
      event.preventDefault();move(Math.max(0,Math.min(posts.length-1,active + (['ArrowUp','PageUp'].includes(event.key) ? -1 : 1))));
    }
  };
  return <section className="loop-flow" aria-label="Flow" style={{'--loop-flow-stage-width':`${Math.max(0,height-88)*3/4}px`}}>
    {backgroundTarget ? createPortal(<FlowBackground media={posts.length ? background : null}/>, backgroundTarget) : null}
    <div ref={viewport} className="loop-flow-viewport" tabIndex={0} aria-label="Flow posts. Swipe or use the up and down arrow keys." onKeyDown={keyDown}>
      <div aria-hidden="true" style={{height:start*height}}/>
      {height ? posts.slice(start,end).map((post,index) => <div key={post.flowKey} className="loop-flow-slide" style={{height}} aria-hidden={start+index!==active} inert={start+index!==active ? true : undefined}><FlowPost post={post} active={start+index===active && !discussion} focused={start+index===active} onBackgroundChange={setBackground} muted={muted} onMutedChange={onMutedChange} onRefresh={refresh} onOpenProfile={onOpenProfile} onToast={onToast} onComments={() => setDiscussion(post)}/></div>) : null}
      <div aria-hidden="true" style={{height:Math.max(0,posts.length-end)*height}}/>
      {!posts.length ? <div className={`loop-flow-empty${busy ? ' is-loading' : ''}`} role="status">{busy ? <><span className="loop-flow-loading-frame" aria-hidden="true"/><p>Loading Flow…</p></> : error ? <><h2>Flow couldn’t load.</h2><p>{error}</p><button type="button" onClick={() => load({force:true})}>Try again</button></> : <><h2>Nothing in Flow yet.</h2><p>Posts shared in Loop will appear here.</p></>}</div> : null}
    </div>
    {posts.length ? <div className="loop-flow-navigation"><button type="button" onClick={() => move(Math.max(0,active-1))} disabled={!active} aria-label="Previous post"><FlowIcon name="up"/></button><span role="status">Post {offset+active+1}</span><button type="button" onClick={() => move(Math.min(posts.length-1,active+1))} disabled={active>=posts.length-1} aria-label="Next post"><FlowIcon name="down"/></button></div> : null}
    {posts.length && (busy || error || (!more && active===posts.length-1)) ? <div className="loop-flow-status" role="status">{error ? <><span>{error}</span><button type="button" onClick={() => load({force:true})}>Retry loading posts</button></> : busy ? 'Loading more…' : 'No more posts available right now.'}</div> : null}
    {discussion ? <CommentsDialog post={posts.find(post=>post.id===discussion.id) || discussion} onClose={() => setDiscussion(null)} onCount={() => refresh(discussion.id)} onOpenProfile={onOpenProfile}/> : null}
  </section>;
}

function LoopFlow(props) {
  const [muted,setMuted] = useState(false);
  return <FlowFeed {...props} muted={muted} onMutedChange={setMuted}/>;
}

export default memo(LoopFlow);
