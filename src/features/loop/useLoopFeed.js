import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeToDmEvents } from '../../app/dmApi';
import { loopRequest } from './loopRequest';

export default function useLoopFeed({ enabled, feed, type, search, shape, onError }) {
  const [posts, setPosts] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState(search.trim());
  const version = useRef(0), paging = useRef(null), alive = useRef(false), items = useRef(posts), dirty = useRef(new Set());
  const needsResync = useRef(false), syncing = useRef(null);
  const replaceNext = useRef(true);
  items.current = posts;
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const load = useCallback(async (before = null, { force = false, replace = false } = {}) => {
    if (before && paging.current) return;
    if (replace) { version.current++; paging.current = null; }
    const requested = version.current;
    const token = {};
    if (before) paging.current = token;
    else setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '12', feed, type, ...(query ? { q: query } : {}), ...(before ? { before: String(before) } : {}) });
      const data = await loopRequest(`/loop/posts?${params}`, { force });
      if (!alive.current || requested !== version.current) return;
      const mapped = (data.posts || []).map(shape);
      setPosts(current => {
        if (replace) return mapped;
        const ids = new Set(mapped.map(post => post.id));
        return before ? [...current, ...mapped.filter(post => !current.some(item => item.id === post.id))]
          : [...mapped, ...current.filter(post => !ids.has(post.id))];
      });
      // Refreshing page one must not reset the reader's pagination cursor.
      if (before || replace || !items.current.length) setNextBefore(data.page?.hasMore ? data.page.nextBefore : null);
      if (!before) replaceNext.current = false;
      setError('');
    } catch (failure) {
      if (alive.current && requested === version.current) { setError(failure.message); onError(failure.message); }
    } finally {
      if (paging.current === token) paging.current = null;
      if (alive.current && requested === version.current) setLoading(false);
    }
  }, [feed, type, query, shape, onError]);
  const reconcile = useCallback(async () => {
    if (syncing.current || !items.current.length) return;
    const token = {}, requested = version.current;
    syncing.current = token;
    const ids = items.current.map(post => post.id);
    try {
      for (let start = 0; start < ids.length; start += 60) {
        const batch = ids.slice(start, start + 60);
        const data = await loopRequest(`/loop/posts?ids=${batch.join(',')}`, { force: true });
        if (!alive.current || requested !== version.current) return;
        const refreshed = new Map(data.posts.map(post => [post.id, shape(post)]));
        const checked = new Set(batch);
        setPosts(current => current.filter(post => !checked.has(post.id) || refreshed.has(post.id))
          .map(post => refreshed.get(post.id) || post));
      }
      needsResync.current = false;
    } catch (failure) { if (alive.current && requested === version.current) onError(failure.message); }
    finally { if (syncing.current === token) syncing.current = null; }
  }, [shape, onError]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; version.current++; };
  }, []);
  useEffect(() => {
    version.current++; replaceNext.current = true; paging.current = null; syncing.current = null; dirty.current.clear(); setPosts([]); setNextBefore(null);
  }, [load]);
  useEffect(() => {
    if (!enabled) return;
    load(null, { replace: replaceNext.current });
    if (needsResync.current) reconcile();
    const refresh = () => { if (document.visibilityState === 'visible') { load(null, { force: true }); reconcile(); } };
    window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [enabled, load, reconcile]);
  const refreshPost = useCallback(async (id, reset = false) => {
    if (reset === 'deleted') { setPosts(current => current.filter(item => item.id !== id)); return; }
    if (!id) return load(null, { force: true, replace: reset });
    const requested = version.current;
    try {
      const { post } = await loopRequest(`/loop/posts/${id}`, { force: true });
      if (alive.current && requested === version.current) setPosts(current => current.map(item => item.id === post.id ? shape(post) : item));
    } catch (failure) {
      if (!alive.current || requested !== version.current) return;
      if (failure.status === 404) setPosts(current => current.filter(item => item.id !== id));
      else onError(failure.message);
    }
  }, [load, shape, onError]);
  useEffect(() => {
    const sub = subscribeToDmEvents((event, data) => {
      const id = Number(data?.postId);
      if (event === 'connected') { needsResync.current = true; if (enabled) reconcile(); }
      if (event === 'loop-follow-updated' && feed === 'following') {
        replaceNext.current = true;
        if (enabled) load(null, { force: true, replace: true });
        return;
      }
      if (event === 'loop-post-deleted') { dirty.current.delete(id); setPosts(current => current.filter(post => post.id !== id)); }
      else if (['loop-post-updated', 'loop-comment-created', 'loop-comment-deleted'].includes(event) && items.current.some(post => post.id === id)) {
        if (enabled) refreshPost(id); else dirty.current.add(id);
      }
      else if (enabled && ['loop-post-created', 'connected'].includes(event)) load(null, { force: true });
    });
    return () => sub.close();
  }, [enabled, feed, load, refreshPost, reconcile]);
  useEffect(() => {
    if (!enabled) return;
    for (const id of dirty.current) refreshPost(id);
    dirty.current.clear();
  }, [enabled, refreshPost]);
  return { posts, setPosts, nextBefore, load, refreshPost, loading, error };
}
