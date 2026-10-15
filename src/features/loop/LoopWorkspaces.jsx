import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import VerifiedMark from '../../components/VerifiedMark';
import { subscribeToDmEvents } from '../../app/dmApi';
import { loopRequest } from './loopRequest';

const VideoDownloadDialog = lazy(() => import('../../components/VideoDownloadDialog'));

function UserAvatar({ user }) {
  return user?.avatarUrl ? <img className="loop-avatar is-small" src={user.avatarUrl} alt="" loading="lazy" /> : <span className="loop-avatar is-small">{(user?.username || '?').slice(0, 2).toUpperCase()}</span>;
}

function SearchField({ value, onChange, label }) {
  return <label className="loop-workspace-search"><span aria-hidden="true">⌕</span><input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={label} aria-label={label} maxLength={80} /></label>;
}

function Status({ loading, error, empty, onRetry }) {
  if (loading) return <div className="loop-workspace-status" role="status"><span className="loop-loading-dot" />Loading…</div>;
  if (error) return <div className="loop-workspace-status" role="alert"><p>{error}</p><button type="button" className="loop-secondary-button" onClick={onRetry}>Try again</button></div>;
  return <div className="loop-workspace-status">{empty}</div>;
}

function usePeopleSearch(query, enabled = true) {
  const [state, setState] = useState({ users: [], loading: true, error: '' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    const timer = setTimeout(async () => {
      try {
        const data = await loopRequest(`/loop/users?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ users: data.users || [], loading: false, error: '' });
      } catch (error) {
        if (!controller.signal.aborted) setState({ users: [], loading: false, error: error.message });
      }
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, enabled, retry]);
  return { ...state, retry: () => setRetry((value) => value + 1) };
}

function ExploreSkeleton({ kind }) {
  return <div className={`loop-explore-skeleton is-${kind}`} role="status" aria-label={`Loading ${kind}`}>
    <span className="sr-only">Loading {kind}…</span>
    {Array.from({ length: kind === 'people' ? 6 : 3 }, (_, index) => <div className="loop-explore-skeleton-row" key={index} aria-hidden="true"><i /><span><b /><b /></span></div>)}
  </div>;
}

export function Explore({ onOpenProfile, renderPost }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('people');
  const [tag, setTag] = useState('');
  const [tags, setTags] = useState([]);
  const [tagsError, setTagsError] = useState('');
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsRevision, setTagsRevision] = useState(0);
  const [posts, setPosts] = useState({ items: [], loading: true, error: '', before: null });
  const [revision, setRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRequest = useRef(null);
  const searchInput = useRef(null);
  const people = usePeopleSearch(query, tab === 'people');
  useEffect(() => {
    const controller = new AbortController();
    setTagsLoading(true);
    setTagsError('');
    loopRequest('/loop/trending', { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setTags(data.tags || []); })
      .catch((error) => { if (!controller.signal.aborted) setTagsError(error.message || 'Could not load topics.'); })
      .finally(() => { if (!controller.signal.aborted) setTagsLoading(false); });
    return () => controller.abort();
  }, [tagsRevision]);
  useEffect(() => {
    pageRequest.current?.abort();
    pageRequest.current = null;
    setLoadingMore(false);
    if (tab !== 'posts') return;
    const controller = new AbortController();
    setPosts({ items: [], loading: true, error: '', before: null });
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query.trim(), tag, limit: '12' });
        const data = await loopRequest(`/loop/posts?${params}`, { signal: controller.signal });
        if (!controller.signal.aborted) setPosts({ items: data.posts || [], loading: false, error: '', before: data.page?.nextBefore || null });
      } catch (error) {
        if (!controller.signal.aborted) setPosts({ items: [], loading: false, error: error.message, before: null });
      }
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); pageRequest.current?.abort(); };
  }, [query, tag, tab, revision]);
  const loadMore = async () => {
    if (!posts.before || pageRequest.current) return;
    const controller = new AbortController();
    pageRequest.current = controller;
    setLoadingMore(true);
    try {
      const data = await loopRequest(`/loop/posts?${new URLSearchParams({ q: query.trim(), tag, before: String(posts.before), limit: '12' })}`, { signal: controller.signal });
      if (!controller.signal.aborted) setPosts((current) => ({ ...current, items: [...current.items, ...(data.posts || []).filter((post) => !current.items.some((item) => item.id === post.id))], before: data.page?.nextBefore || null, error: '' }));
    } catch (error) { if (!controller.signal.aborted) setPosts((current) => ({ ...current, error: error.message })); }
    finally { if (pageRequest.current === controller) { pageRequest.current = null; setLoadingMore(false); } }
  };
  const selectTab = (next) => { setTab(next); if (next === 'people') setTag(''); };
  const clearSearch = () => { setQuery(''); searchInput.current?.focus(); };
  const loading = tab === 'people' ? people.loading : posts.loading;
  const error = tab === 'people' ? people.error : posts.error;
  const shown = tab === 'people' ? people.users.length : posts.items.length;
  return <section className="loop-workspace loop-discovery">
    <div className="loop-workspace-intro"><h2>Find your people. Follow your interests.</h2><p>Search Glean members or see what people are posting.</p></div>
    <div className="loop-discovery-tools">
      <div className="loop-workspace-tabs" role="tablist" aria-label="Explore results">
        {[['people', 'People'], ['posts', 'Posts']].map(([key, label]) => <button id={`loop-${key}-tab`} role="tab" aria-selected={tab === key} aria-controls="loop-results" type="button" key={key} onClick={() => selectTab(key)} onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'people' : event.key === 'End' ? 'posts' : key === 'people' ? 'posts' : 'people';
          selectTab(next); document.getElementById(`loop-${next}-tab`)?.focus();
        }} tabIndex={tab === key ? 0 : -1}>{label}</button>)}
      </div>
      <div className="loop-discovery-search loop-workspace-search">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input ref={searchInput} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === 'people' ? 'Search people' : 'Search posts'} aria-label={tab === 'people' ? 'Search people' : 'Search posts'} maxLength={80} autoComplete="off" />
        {query ? <button className="loop-discovery-clear" type="button" onClick={clearSearch} aria-label="Clear search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button> : null}
      </div>
    </div>
    <div className="loop-discovery-layout">
      <div className="loop-discovery-results">
        <div className="loop-discovery-results-heading">
          <div><h3>{query.trim() ? 'Search results' : tab === 'people' ? 'People to discover' : tag ? `Posts in #${tag}` : 'Latest posts'}</h3><p role="status">{loading ? 'Finding matches…' : error && !shown ? 'Results unavailable' : `${shown} ${tab === 'people' ? shown === 1 ? 'person' : 'people' : shown === 1 ? 'post' : 'posts'} shown`}</p></div>
          {query || tag ? <button type="button" className="loop-secondary-button" onClick={() => { setQuery(''); setTag(''); }}>Clear filters</button> : null}
        </div>
        {tag && tab === 'posts' ? <button className="loop-active-topic" type="button" onClick={() => setTag('')} aria-label={`Clear topic ${tag}`}>#{tag} <span aria-hidden="true">×</span></button> : null}
        <div id="loop-results" role="tabpanel" aria-labelledby={`loop-${tab}-tab`} aria-busy={loading}>
          {loading ? <ExploreSkeleton kind={tab} /> : tab === 'people' ? people.error || !people.users.length ? <Status error={people.error} onRetry={people.retry} empty={query ? 'No people found. Try another name.' : 'No people to show yet.'} /> : <div className="loop-people-grid">
            {people.users.map((person) => <button className="loop-person-card" type="button" key={person.id} aria-label={`View ${person.username}'s profile`} onClick={() => onOpenProfile(person.id, person.username)}><UserAvatar user={person} /><span className="loop-person-details"><strong>{person.username}{person.verified ? <VerifiedMark /> : null}</strong><small>{person.bio || 'Glean member'}</small><span className="loop-follow-label">View profile <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></span></span></button>)}
          </div> : !posts.items.length ? <Status error={posts.error} onRetry={() => setRevision((value) => value + 1)} empty="No posts found. Try another topic or search." /> : <div className="loop-explore-posts">
            {posts.items.map((post) => renderPost(post, () => setRevision((value) => value + 1)))}
            {posts.error ? <div className="loop-discovery-page-error" role="alert"><p>{posts.error}</p>{posts.before ? <button type="button" className="loop-secondary-button" disabled={loadingMore} onClick={loadMore}>Retry loading more posts</button> : null}</div> : null}
            {posts.before && !posts.error ? <button type="button" className="loop-discovery-more loop-secondary-button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading…' : 'Load more posts'}</button> : null}
          </div>}
        </div>
      </div>
      <aside className="loop-topic-panel" aria-labelledby="loop-trending-title">
        <h3 id="loop-trending-title">Trending topics</h3><p className="loop-muted">Pick a topic to explore its posts.</p>
        <div className="loop-topic-list" aria-busy={tagsLoading}>{tags.map((item, index) => <button type="button" key={item.tag} aria-pressed={tag === item.tag && tab === 'posts'} onClick={() => { setTag(item.tag); setQuery(''); setTab('posts'); }}><span className="loop-topic-rank">{index + 1}</span><span><strong>#{item.tag}</strong><small>{item.count} {item.count === 1 ? 'post' : 'posts'}</small></span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>)}</div>
        {tagsError ? <div role="alert"><p className="loop-muted">{tagsError}</p><button type="button" className="loop-secondary-button" onClick={() => setTagsRevision((value) => value + 1)}>Try topics again</button></div> : !tags.length ? <p className="loop-muted" role={tagsLoading ? 'status' : undefined}>{tagsLoading ? 'Finding topics…' : 'Topics appear as people add tags to posts.'}</p> : null}
      </aside>
    </div>
  </section>;
}

function Conversation({ conversation, onBack, onSent }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [before, setBefore] = useState(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const history = useRef(null);
  const alive = useRef(true);
  const fetchSequence = useRef(0);
  const bottom = useRef(true);
  const prepend = useRef(null);
  const sendLock = useRef(false);
  const initialized = useRef(false);
  const load = useCallback(async () => {
    const sequence = ++fetchSequence.current;
    try {
      const data = await apiRequest(`/loop/conversations/${conversation.id}/messages`);
      if (!alive.current || sequence !== fetchSequence.current) return;
      setMessages((current) => {
        const ids = new Set((data.messages || []).map((message) => message.id));
        const first = data.messages?.[0]?.id;
        return [...current.filter((message) => first && message.id < first && !ids.has(message.id)), ...(data.messages || [])];
      });
      if (!initialized.current) { setBefore(data.page?.nextBefore || null); initialized.current = true; }
      setError('');
    } catch (failure) { if (alive.current && sequence === fetchSequence.current) setError(failure.message); }
    finally { if (alive.current && sequence === fetchSequence.current) setLoading(false); }
  }, [conversation.id]);
  useEffect(() => {
    alive.current = true;
    load();
    const sub = subscribeToDmEvents((event, payload) => { if (event === 'loop-message-created' && Number(payload.conversationId) === Number(conversation.id)) load(); });
    return () => { alive.current = false; sub.close(); };
  }, [load, conversation.id]);
  useLayoutEffect(() => {
    const node = history.current;
    if (!node) return;
    if (prepend.current) { node.scrollTop += node.scrollHeight - prepend.current.height; prepend.current = null; }
    else if (bottom.current) node.scrollTop = node.scrollHeight;
  }, [messages]);
  const older = async () => {
    if (!before || olderBusy) return;
    setOlderBusy(true);
    try {
      const data = await apiRequest(`/loop/conversations/${conversation.id}/messages?before=${before}`);
      if (!alive.current) return;
      prepend.current = { height: history.current?.scrollHeight || 0 };
      setMessages((current) => [...(data.messages || []).filter((message) => !current.some((item) => item.id === message.id)), ...current]);
      setBefore(data.page?.nextBefore || null);
      setError('');
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setOlderBusy(false); }
  };
  const send = async (event) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    setError('');
    try {
      const data = await apiRequest(`/loop/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
      if (!alive.current) return;
      bottom.current = true;
      setMessages((current) => current.some((item) => item.id === data.id) ? current : [...current, { id: data.id, content, own: true, createdAt: new Date().toISOString() }]);
      setDraft('');
      onSent();
      await load();
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { sendLock.current = false; if (alive.current) setSending(false); }
  };
  return <div className="loop-conversation-panel"><header className="loop-conversation-head"><button type="button" className="loop-inbox-back loop-icon-button" onClick={onBack} aria-label="Back to conversations">←</button><UserAvatar user={conversation.user} /><div><strong>{conversation.user.username}{conversation.user.verified ? <VerifiedMark /> : null}</strong><small>Loop conversation</small></div></header>
    <div className="loop-message-history" ref={history} onScroll={() => { const node = history.current; bottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90; }}>
      {loading ? <Status loading /> : <>{before ? <button type="button" className="loop-older-button" disabled={olderBusy} onClick={older}>{olderBusy ? 'Loading…' : 'Load earlier messages'}</button> : null}{!messages.length && !error ? <Status empty={`Say hello to ${conversation.user.username}.`} /> : null}{messages.map((message) => <div key={message.id} className={`loop-bubble ${message.own ? 'is-mine' : ''}`}><p>{message.deleted ? 'Message deleted' : message.content}</p>{message.createdAt ? <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time> : null}</div>)}</>}
    </div>{error ? <div className="loop-inline-error" role="alert">{error}<button type="button" onClick={load}>Retry loading</button></div> : null}
    <form className="loop-message-form" onSubmit={send}><textarea rows={2} value={draft} disabled={sending} maxLength={4000} onChange={(event) => setDraft(event.target.value)} placeholder={`Message ${conversation.user.username}`} aria-label={`Message ${conversation.user.username}`} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } }} /><button type="submit" disabled={sending || !draft.trim()} aria-label={sending ? 'Sending message' : 'Send message'}>{sending ? '…' : '↑'}</button><small>Enter to send · Shift + Enter for a new line</small></form>
  </div>;
}

export function Messages({ initialConversationId, onToast }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [newMessage, setNewMessage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);
  const sequence = useRef(0);
  const openedInitial = useRef(null);
  const people = usePeopleSearch(query, newMessage);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try { const data = await apiRequest('/loop/conversations'); if (alive.current && current === sequence.current) { setConversations(data.conversations || []); setError(''); } }
    catch (failure) { if (alive.current && current === sequence.current) setError(failure.message); }
    finally { if (alive.current && current === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; load(); const sub = subscribeToDmEvents((event) => { if (event === 'loop-message-created') load(); }); return () => { alive.current = false; sub.close(); }; }, [load]);
  useEffect(() => { if (initialConversationId && openedInitial.current !== initialConversationId) { const item = conversations.find((conversation) => Number(conversation.id) === Number(initialConversationId)); if (item) { setSelected(item); openedInitial.current = initialConversationId; } } }, [initialConversationId, conversations]);
  const start = async (person) => {
    if (starting) return;
    setStarting(true);
    try { const data = await apiRequest('/loop/conversations', { method: 'POST', body: JSON.stringify({ userId: person.id }) }); if (!alive.current) return; setSelected({ id: data.id, user: person }); setNewMessage(false); setQuery(''); load(); }
    catch (failure) { if (alive.current) onToast(failure.message); }
    finally { if (alive.current) setStarting(false); }
  };
  const filtered = conversations.filter((conversation) => conversation.user.username.toLowerCase().includes(query.toLowerCase()));
  return <section className="loop-workspace loop-inbox"><div className="loop-workspace-intro loop-inbox-intro"><div><span className="loop-kicker">Loop inbox</span><h2>A place for your conversations.</h2><p>Find a member, say hello, and keep the conversation going.</p></div><button className="loop-primary-button" type="button" onClick={() => { setNewMessage(!newMessage); setQuery(''); setSelected(null); }}>{newMessage ? 'Your inbox' : '+ New message'}</button></div>
    <div className={`loop-message-layout ${selected ? 'has-selection' : ''}`}><aside className="loop-conversation-list"><div className="loop-inbox-list-heading"><strong>{newMessage ? 'Choose a person' : 'Conversations'}</strong><small>{newMessage ? 'Search Glean members' : `${conversations.length} conversations`}</small></div><SearchField value={query} onChange={setQuery} label={newMessage ? 'Search people to message' : 'Search conversations'} /><div className="loop-inbox-list-scroll">
    {newMessage ? people.loading || people.error || !people.users.length ? <Status loading={people.loading} error={people.error} onRetry={people.retry} empty="No people found." /> : people.users.map((person) => <button className="loop-conversation" type="button" key={person.id} disabled={starting} onClick={() => start(person)}><UserAvatar user={person} /><span><strong>{person.username}{person.verified ? <VerifiedMark /> : null}</strong><small>Start a conversation</small></span></button>) : loading || error || !filtered.length ? <Status loading={loading} error={error} onRetry={load} empty={query ? 'No matching conversations.' : 'Your inbox is empty. Choose New message to start.'} /> : filtered.map((conversation) => <button type="button" className={`loop-conversation ${selected?.id === conversation.id ? 'is-selected' : ''}`} aria-pressed={selected?.id === conversation.id} key={conversation.id} onClick={() => setSelected(conversation)}><UserAvatar user={conversation.user} /><span><strong>{conversation.user.username}{conversation.user.verified ? <VerifiedMark /> : null}</strong><small>{conversation.preview || 'Say hello'}</small></span></button>)}
    </div></aside>{selected ? <Conversation key={selected.id} conversation={selected} onBack={() => setSelected(null)} onSent={load} /> : <div className="loop-inbox-welcome"><span aria-hidden="true">↗</span><h3>{newMessage ? 'Start something new' : 'Your conversations live here'}</h3><p>{newMessage ? 'Choose a person from the list to open a conversation.' : 'Pick a conversation or start one with another Glean member.'}</p></div>}</div>
  </section>;
}

function AttachmentPreview({ file, onRemove, disabled }) {
  const [url, setUrl] = useState(undefined);
  useEffect(() => { if (file.downloadId) { setUrl(file.previewUrl); return; } const value = URL.createObjectURL(file); setUrl(value); return () => URL.revokeObjectURL(value); }, [file]);
  return <div className="loop-create-attachment">{file.type.startsWith('image/') ? <img src={url} alt={file.name} /> : file.type.startsWith('video/') ? <video src={url} controls preload="metadata" /> : <audio src={url} controls preload="metadata" />}<div><span>{file.name}</span><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></div><button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove ${file.name}`}>×</button></div>;
}

function CreateToolIcon({ kind }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'download' ? <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /> : kind === 'media' ? <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 6-6 4 4 3-3 5 5" /></> : <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M8 16v-4m4 4V8m4 8v-6" /></>}</svg>;
}

export function CreateModal({ account, origin, returnFocus, onClose, onCreated, toast }) {
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [files, setFiles] = useState([]);
  const [showVideoDownload, setShowVideoDownload] = useState(false);
  const downloadTrigger = useRef(null);
  const downloadOpen = useRef(false);
  downloadOpen.current = showVideoDownload;
  const [autoCaptions, setAutoCaptions] = useState(false);
  const [captionAvailable, setCaptionAvailable] = useState(null);
  const hasVideo = files.some(file => file.type.startsWith('video/'));
  useEffect(() => {
    if (!hasVideo) { setAutoCaptions(false); return; }
    const controller = new AbortController();
    setCaptionAvailable(null);
    apiRequest('/loop/captions/config', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setCaptionAvailable(data.available); }).catch(() => { if (!controller.signal.aborted) setCaptionAvailable(false); });
    return () => controller.abort();
  }, [hasVideo]);
  const [pollEnabled, setPollEnabled] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const errorBox = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef(null);
  const layer = useRef(null);
  const openingAnimation = useRef(null);
  const returnPreview = useRef(null);
  const closing = useRef(false);
  const input = useRef(null);
  const lock = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => { if (error) errorBox.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (lock.current || closing.current) return;
    closing.current = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !dialog.current?.animate) { onCloseRef.current(); return; }
    const node = dialog.current;
    const currentStyle = getComputedStyle(node);
    const start = { opacity: currentStyle.opacity, transform: currentStyle.transform };
    openingAnimation.current?.cancel();
    const composer = returnFocus?.closest?.('.loop-composer');
    const source = composer?.getBoundingClientRect() || origin;
    const target = node.getBoundingClientRect();
    const morphBack = source && source.width > 0 && source.height > 0 && target.width > 0 && target.height > 0;
    const duration = morphBack ? 420 : 160;
    const composerStyle = composer ? getComputedStyle(composer) : null;
    const scaleX = morphBack ? source.width / target.width : 1;
    const scaleY = morphBack ? source.height / target.height : 1;
    const end = morphBack ? {
      opacity: composer ? 0 : .8,
      transform: `translate(${source.left + source.width / 2 - (target.left + target.width / 2)}px, ${source.top + source.height / 2 - (target.top + target.height / 2)}px) scale(${scaleX}, ${scaleY})`,
      borderRadius: `${(parseFloat(composerStyle?.borderTopLeftRadius) || 20) / scaleX}px / ${(parseFloat(composerStyle?.borderTopLeftRadius) || 20) / scaleY}px`,
      backgroundColor: composerStyle?.backgroundColor || currentStyle.backgroundColor,
      boxShadow: 'none',
    } : { opacity: 0, transform: 'translateY(8px) scale(.98)' };
    if (morphBack) for (const child of node.children) {
      child.animate([{ opacity: getComputedStyle(child).opacity }, { opacity: 0, offset: .35 }, { opacity: 0 }], { duration, fill: 'forwards' });
    }
    if (morphBack && composer) {
      const preview = composer.cloneNode(true);
      preview.classList.remove('is-expanding');
      preview.classList.add('loop-composer-return-preview');
      preview.setAttribute('aria-hidden', 'true');
      preview.inert = true;
      Object.assign(preview.style, { position: 'fixed', top: `${source.top}px`, left: `${source.left}px`, width: `${source.width}px`, height: `${source.height}px`, margin: '0', visibility: 'visible', pointerEvents: 'none', zIndex: '2' });
      layer.current.append(preview);
      returnPreview.current = preview;
      preview.animate([{ opacity: 0 }, { opacity: 0, offset: .45 }, { opacity: 1 }], { duration, easing: 'ease-out', fill: 'forwards' });
    }
    const animation = node.animate([start, end], { duration, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' });
    const backdrop = getComputedStyle(layer.current);
    layer.current.animate([{ backgroundColor: backdrop.backgroundColor, backdropFilter: backdrop.backdropFilter }, { backgroundColor: 'rgba(1,8,15,0)', backdropFilter: 'blur(0px)' }], { duration, fill: 'forwards' });
    animation.finished.then(() => onCloseRef.current()).catch(() => {});
  }, [origin, returnFocus]);
  useEffect(() => () => { returnPreview.current?.remove(); }, []);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!origin || !node?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const target = node.getBoundingClientRect();
    const dx = origin.left + origin.width / 2 - (target.left + target.width / 2);
    const dy = origin.top + origin.height / 2 - (target.top + target.height / 2);
    const animation = node.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${origin.width / target.width}, ${origin.height / target.height})`, opacity: .8 },
      { transform: 'none', opacity: 1 },
    ], { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    openingAnimation.current = animation;
    return () => animation.cancel();
  }, [origin]);
  useEffect(() => {
    const previous = returnFocus || document.activeElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current.querySelector('textarea')?.focus({ preventScroll: true });
    const keyboard = (event) => {
      if (downloadOpen.current) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((node) => node.getClientRects().length);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); document.body.style.overflow = oldOverflow; previous?.focus({ preventScroll: true }); };
  }, [close, returnFocus]);
  const addFiles = (event) => {
    const videoTypes = { mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/mp4', ogv: 'video/ogg', '3gp': 'video/3gpp' };
    const added = [...event.target.files].map(file => {
      const type = videoTypes[file.name.split('.').at(-1).toLowerCase()];
      return (!file.type || file.type === 'application/octet-stream') && type ? new File([file],file.name,{type,lastModified:file.lastModified}) : file;
    });
    event.target.value = '';
    const next = [...files, ...added.filter((file) => !files.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified))];
    if (next.length > 10) { setError('Choose up to 10 images. Remove a file to add another.'); return; }
    if (next.length > 1 && next.some((file) => !file.type.startsWith('image/'))) { setError('Use up to 10 images, or one video or audio file per post.'); return; }
    setFiles(next); setError('');
  };
  const addDownloadedVideo = (file) => {
    if (busy || lock.current || closing.current) throw new Error('The post is being published or closed.');
    if (files.length) throw new Error('Remove the current attachments first. A post can have up to 10 images, or one video or audio file.');
    setFiles([file]); setError('');
  };
  const submit = async (event) => {
    event.preventDefault();
    if ((!content.trim() && !files.length && !pollEnabled) || lock.current || closing.current) return;
    if (pollEnabled && (!pollQuestion.trim() || pollOptions.some(option => !option.trim()) || new Set(pollOptions.map(option => option.trim().toLowerCase())).size !== pollOptions.length)) { setError('Add a question and at least two different, nonempty choices.'); return; }
    lock.current = true; setBusy(true); setError('');
    const form = new FormData(); form.append('content', content); form.append('tags', tags); files.forEach((file) => { if (file.downloadId) form.append('videoDownloadId',file.downloadId); else form.append('files', file); });
    if (hasVideo && autoCaptions) form.append('autoCaptions', 'true');
    if (pollEnabled) form.append('poll', JSON.stringify({ question: pollQuestion.trim(), options: pollOptions.map(option => option.trim()) }));
    try { await apiRequest('/loop/posts', { method: 'POST', body: form, timeoutMs: 180000 }); onCreated(); toast('Your post was published.'); lock.current = false; close(); }
    catch (failure) { setError(failure.message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="loop-modal-layer loop-composer-modal-layer" ref={layer} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className={`loop-modal loop-create-dialog loop-composer-dialog ${origin ? 'is-morphing' : ''}`} role="dialog" aria-modal={showVideoDownload ? undefined : true} aria-hidden={showVideoDownload || undefined} inert={showVideoDownload || undefined} aria-labelledby="loop-create-title" aria-describedby="loop-create-description" ref={dialog}>
      <header className="loop-modal-head">
        <UserAvatar user={account} />
        <div><h2 id="loop-create-title">Create a post</h2><p id="loop-create-description"><span>{account?.username || 'You'}</span><span>· Public post</span></p></div>
        <button className="loop-icon-button" type="button" disabled={busy} onClick={close} aria-label="Close create post">×</button>
      </header>
      <form onSubmit={submit}>
        <div className="loop-create-body">
          <div className="loop-create-writing">
            <div className="loop-create-writing-label"><label className="loop-field-label" htmlFor="loop-create-content">Your post</label><span aria-live="polite">{content.length.toLocaleString()} / 2,000</span></div>
            <textarea id="loop-create-content" value={content} onChange={(event) => { setContent(event.target.value); setError(''); }} disabled={busy} placeholder="Share something with Glean Loop…" maxLength={2000} />
          </div>
          <div className="loop-create-tools" role="group" aria-label="Add content">
            <button className="loop-create-tool" type="button" disabled={busy} onClick={() => input.current.click()}><CreateToolIcon kind="media" />Add media</button>
            <button className={`loop-create-tool${pollEnabled ? ' is-selected' : ''}`} type="button" disabled={busy} aria-expanded={pollEnabled} aria-controls="loop-poll-editor" onClick={() => { setPollEnabled(value => !value); setError(''); }}><CreateToolIcon kind="poll" />{pollEnabled ? 'Remove poll' : '+ Add poll'}</button>
            <button className="loop-create-tool" type="button" disabled={busy} aria-label="Download a video" aria-haspopup="dialog" aria-expanded={showVideoDownload} ref={downloadTrigger} onClick={() => setShowVideoDownload(true)}><CreateToolIcon kind="download" />Download video</button>
          </div>
          <input ref={input} className="loop-file-input-hidden" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/*,.mov,.mkv,.avi,.m4v,.ogv,.3gp,audio/mpeg,audio/mp4,audio/ogg" onChange={addFiles} tabIndex={-1} aria-label="Choose post media" />
          {files.length ? <div className="loop-create-media-section"><div className="loop-create-section-heading"><strong>Attachments</strong><span>{files.length} / 10</span></div><div className="loop-create-previews">{files.map((file, index) => <AttachmentPreview key={`${file.name}-${file.size}-${file.lastModified}`} file={file} disabled={busy} onRemove={() => { setFiles((current) => current.filter((_, position) => position !== index)); setError(''); }} />)}</div></div> : <p className="loop-create-media-hint">Add photos, GIFs, video, or audio.</p>}
          {files[0]?.downloadId ? <p className="loop-create-media-hint">Publish before {new Date(files[0].expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}; prepared videos expire.</p> : null}
          {hasVideo ? <div className="loop-auto-captions"><label><input type="checkbox" checked={autoCaptions} disabled={busy || captionAvailable !== true} onChange={event => setAutoCaptions(event.target.checked)} />Generate automatic captions (CC)</label><p>{captionAvailable === null ? 'Checking caption availability…' : captionAvailable === false ? 'Auto captions are temporarily unavailable. You can still publish your video.' : 'Optional. Sends this video’s audio to Groq for transcription. Captions appear after publishing and may contain mistakes. Videos up to 30 minutes; 10 requests per day.'}</p></div> : null}
          {pollEnabled ? <fieldset id="loop-poll-editor" className="loop-poll-editor" disabled={busy}>
            <legend>Poll</legend>
            <label className="loop-field-label" htmlFor="loop-poll-question">Poll question</label>
            <input id="loop-poll-question" value={pollQuestion} onChange={event => { setPollQuestion(event.target.value); setError(''); }} maxLength={200} placeholder="Ask your community…" />
            <div className="loop-poll-editor-choices">{pollOptions.map((option, index) => <div className="loop-poll-editor-option" key={index}>
              <span className="loop-poll-option-number" aria-hidden="true">{index + 1}</span>
              <input aria-label={`Choice ${index + 1}`} value={option} placeholder={`Choice ${index + 1}`} maxLength={100} onChange={event => { setPollOptions(current => current.map((value, position) => position === index ? event.target.value : value)); setError(''); }} />
              <button className="loop-icon-button" type="button" disabled={pollOptions.length <= 2} aria-label={`Remove choice ${index + 1}`} onClick={() => { setPollOptions(current => current.filter((_, position) => position !== index)); setError(''); }}>×</button>
            </div>)}</div>
            <div className="loop-poll-editor-footer"><button className="loop-secondary-button" type="button" disabled={pollOptions.length >= 6} onClick={() => { setPollOptions(current => [...current, '']); setError(''); }}>Add choice</button><span>{pollOptions.length} / 6 choices</span></div>
            <p className="loop-create-media-hint">One vote per person. Votes can be changed.</p>
          </fieldset> : null}
          <div className="loop-create-topics">
            <label className="loop-field-label" htmlFor="loop-create-tags">Topics <span>optional</span></label>
            <input id="loop-create-tags" value={tags} disabled={busy} onChange={(event) => { setTags(event.target.value); setError(''); }} placeholder="e.g. art music coding" maxLength={240} />
            <p className="loop-create-media-hint">Separate topics with spaces so people can find your post.</p>
          </div>
          {error ? <div className="loop-inline-error" role="alert" ref={errorBox}>{error}</div> : null}
        </div>
        <footer className="loop-modal-actions">
          <span role="status">{busy ? 'Publishing your post…' : files.length || pollEnabled ? [files.length ? `${files.length} attachment${files.length === 1 ? '' : 's'}` : '', pollEnabled ? 'Poll included' : ''].filter(Boolean).join(' · ') : 'Visible to everyone on Loop'}</span>
          <div><button className="loop-secondary-button" type="button" disabled={busy} onClick={close}>Cancel</button><button className="loop-primary-button" type="submit" disabled={busy || (!content.trim() && !files.length && !pollEnabled)}>{busy ? 'Publishing…' : 'Publish post ↗'}</button></div>
        </footer>
      </form>
    </section>
    {showVideoDownload ? <Suspense fallback={null}><VideoDownloadDialog returnFocus={downloadTrigger.current} onAddAsMedia={addDownloadedVideo} onClose={() => setShowVideoDownload(false)} /></Suspense> : null}
  </div>;
}
