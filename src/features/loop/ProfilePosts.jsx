import { useEffect, useRef, useState } from 'react';
import { loopRequest as apiRequest } from './loopRequest';

export default function ProfilePosts({ id, username, renderPost }) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [type, setType] = useState('all');
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ posts: [], tags: [], before: null, loading: true, error: '' });
  const [loadingMore, setLoadingMore] = useState(false);
  const paging = useRef(null);
  const params = (before) => new URLSearchParams({ author: String(id), q: query.trim(), tag, type, limit: '12', ...(before ? { before: String(before) } : {}) });
  useEffect(() => {
    const controller = new AbortController();
    paging.current?.abort(); paging.current = null;
    setLoadingMore(false);
    setState(current => ({ ...current, posts: [], before: null, loading: true, error: '' }));
    const timer = setTimeout(async () => {
      try {
        const data = await apiRequest(`/loop/posts?${params()}`, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ posts: data.posts || [], tags: data.tags || [], before: data.page?.nextBefore || null, loading: false, error: '' });
      } catch (error) {
        if (!controller.signal.aborted) setState(current => ({ ...current, loading: false, error: error.message }));
      }
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); paging.current?.abort(); };
  }, [id, query, tag, type, revision]);
  const loadMore = async () => {
    if (!state.before || paging.current) return;
    const controller = new AbortController(); paging.current = controller; setLoadingMore(true);
    try {
      const data = await apiRequest(`/loop/posts?${params(state.before)}`, { signal: controller.signal });
      if (!controller.signal.aborted) setState(current => ({ ...current, posts: [...current.posts, ...(data.posts || []).filter(post => !current.posts.some(item => item.id === post.id))], before: data.page?.nextBefore || null, error: '' }));
    } catch (error) { if (!controller.signal.aborted) setState(current => ({ ...current, error: error.message })); }
    finally { if (paging.current === controller) { paging.current = null; setLoadingMore(false); } }
  };
  const filtered = Boolean(query || tag || type !== 'all');
  return <section className="loop-profile-posts" aria-label={`${username}'s posts`}>
    <div className="loop-view-heading"><h2>Posts</h2></div>
    <div className="loop-profile-post-filters">
      <label className="loop-workspace-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search profile posts" placeholder={`Search ${username}'s posts`} maxLength={80} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>Tag<select aria-label="Filter profile posts by tag" value={tag} onChange={event => setTag(event.target.value)}><option value="">All tags</option>{state.tags.map(item => <option key={item.tag} value={item.tag}>#{item.tag} ({item.count})</option>)}</select></label>
      <label>Post type<select aria-label="Filter profile posts by type" value={type} onChange={event => setType(event.target.value)}>{[['all', 'All posts'], ['text', 'Text'], ['photo', 'Pictures'], ['gif', 'GIFs'], ['video', 'Videos'], ['audio', 'Audio'], ['poll', 'Polls']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {filtered ? <button className="loop-secondary-button" type="button" onClick={() => { setQuery(''); setTag(''); setType('all'); }}>Clear filters</button> : null}
    </div>
    <div className="loop-feed" aria-busy={state.loading}>
      {state.loading ? <div className="loop-workspace-status" role="status"><span className="loop-loading-dot" />Loading posts…</div> : state.posts.length ? state.posts.map(post => renderPost(post, () => setRevision(value => value + 1))) : !state.error ? <div className="loop-empty-state">{filtered ? 'No posts match these filters.' : `${username} hasn’t posted yet.`}</div> : null}
      {state.error ? <div className="loop-workspace-status" role="alert"><p>{state.error}</p><button className="loop-secondary-button" type="button" onClick={() => state.posts.length ? loadMore() : setRevision(value => value + 1)}>Try again</button></div> : null}
      {!state.loading && state.before ? <button className="loop-secondary-button" type="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading…' : 'Load more posts'}</button> : null}
    </div>
  </section>;
}
