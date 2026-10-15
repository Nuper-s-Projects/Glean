import { useCallback, useEffect, useRef, useState } from 'react';
import { getPeople } from '../../app/dmApi';
import { mergePeoplePages } from './discoverPeopleState';

const PAGE_SIZE = 50;
const EMPTY_COUNTS = { all: 0, add: 0, pending: 0, friends: 0 };

export function useDiscoverPeople({ enabled, query, filter, attributeFilters, revision, accountId }) {
  const [people, setPeople] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [attributeCounts, setAttributeCounts] = useState({ magnet: 0, 'laredo-college': 0 });
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const scopeRef = useRef(null);
  const pageCacheRef = useRef(new Map());
  const cacheRevisionRef = useRef(revision);
  const reloadRef = useRef(reload);
  const key = JSON.stringify({ query: query.trim().slice(0, 80), filter, attributes: [...attributeFilters].sort() });
  const cacheKey = `${Number(accountId) || 0}:${key}`;
  const applyMetadata = useCallback(result => {
    setTotal(Number(result.total || 0));
    setCounts(result.counts || EMPTY_COUNTS);
    setAttributeCounts(result.attributeCounts || { magnet: 0, 'laredo-college': 0 });
    setHasMore(result.nextCursor != null);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    if (cacheRevisionRef.current !== revision) {
      pageCacheRef.current.clear();
      cacheRevisionRef.current = revision;
    }
    const controller = new AbortController();
    const options = JSON.parse(key);
    const scope = { key: cacheKey, options, controller, cursor: null, loading: true };
    scopeRef.current = scope;
    const forceReload = reloadRef.current !== reload;
    reloadRef.current = reload;
    const cached = forceReload ? null : pageCacheRef.current.get(cacheKey);
    const refreshing = Boolean(cached && Date.now() - cached.updatedAt < 30_000);
    if (refreshing) {
      scope.cursor = cached.cursor;
      scope.loading = false;
      setPeople(cached.people);
      setTotal(cached.total);
      setCounts(cached.counts);
      setAttributeCounts(cached.attributeCounts);
      setHasMore(cached.cursor !== null);
    }
    const active = () => scopeRef.current === scope && !controller.signal.aborted;
    setIsLoading(!refreshing);
    setIsLoadingMore(false);
    setError('');
    if (!refreshing) { setPeople([]); setTotal(0); setHasMore(false); }
    const timer = window.setTimeout(async () => {
      if (refreshing) return;
      let rows = [], cursor = 0, result;
      try {
        result = await getPeople({ ...options, cursor, limit: PAGE_SIZE, signal: controller.signal });
        if (!active()) return;
        rows = mergePeoplePages(rows, result.people || []);
        if (result.nextCursor != null && Number(result.nextCursor) <= cursor) throw new Error('The people directory returned an invalid page. Try again.');
        cursor = result.nextCursor ?? null;
        scope.cursor = cursor;
        pageCacheRef.current.set(cacheKey, {
          people: rows,
          total: Number(result.total || 0),
          counts: result.counts || EMPTY_COUNTS,
          attributeCounts: result.attributeCounts || { magnet: 0, 'laredo-college': 0 },
          cursor,
          updatedAt: Date.now(),
        });
        while (pageCacheRef.current.size > 12) pageCacheRef.current.delete(pageCacheRef.current.keys().next().value);
        setPeople(rows);
        applyMetadata(result);
      } catch (failure) {
        if (active()) setError(failure.message || 'Could not load people.');
      } finally {
        if (active()) { scope.loading = false; setIsLoading(false); setIsLoadingMore(false); }
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [enabled, key, cacheKey, revision, reload, applyMetadata]);

  const loadMore = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope || scope.loading || scope.cursor === null) return;
    scope.loading = true;
    setIsLoadingMore(true);
    setError('');
    const active = () => scopeRef.current === scope && !scope.controller.signal.aborted;
    try {
      const result = await getPeople({ ...scope.options, cursor: scope.cursor, limit: PAGE_SIZE, signal: scope.controller.signal });
      if (!active()) return;
      if (result.nextCursor != null && Number(result.nextCursor) <= scope.cursor) throw new Error('The people directory returned an invalid page. Try again.');
      scope.cursor = result.nextCursor ?? null;
      const cached = pageCacheRef.current.get(scope.key);
      const rows = mergePeoplePages(cached?.people || [], result.people || []);
      pageCacheRef.current.set(scope.key, {
        people: rows,
        total: Number(result.total || 0),
        counts: result.counts || EMPTY_COUNTS,
        attributeCounts: result.attributeCounts || { magnet: 0, 'laredo-college': 0 },
        cursor: scope.cursor,
        updatedAt: Date.now(),
      });
      setPeople(rows);
      applyMetadata(result);
    } catch (failure) {
      if (active()) setError(failure.message || 'Could not load more people.');
    } finally {
      if (active()) { scope.loading = false; setIsLoadingMore(false); }
    }
  }, [applyMetadata]);

  const retry = useCallback(() => {
    pageCacheRef.current.delete(cacheKey);
    setReload(current => current + 1);
  }, [cacheKey]);
  return { people, total, counts, attributeCounts, hasMore, isLoading, isLoadingMore, error, loadMore, retry };
}
