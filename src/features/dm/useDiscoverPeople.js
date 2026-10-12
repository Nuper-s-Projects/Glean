import { useCallback, useEffect, useRef, useState } from 'react';
import { getPeople } from '../../app/dmApi';
import { mergePeoplePages } from './discoverPeopleState';

const PAGE_SIZE = 50;
const EMPTY_COUNTS = { all: 0, add: 0, pending: 0, friends: 0 };

export function useDiscoverPeople({ enabled, query, filter, attributeFilters, revision }) {
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
  const snapshotRef = useRef({ key: null, people: [] });
  const key = JSON.stringify({ query: query.trim().slice(0, 80), filter, attributes: [...attributeFilters].sort() });
  const applyMetadata = useCallback(result => {
    setTotal(Number(result.total || 0));
    setCounts(result.counts || EMPTY_COUNTS);
    setAttributeCounts(result.attributeCounts || { magnet: 0, 'laredo-college': 0 });
    setHasMore(result.nextCursor != null);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const options = JSON.parse(key);
    const scope = { key, options, controller, cursor: null, loading: true };
    scopeRef.current = scope;
    const previous = snapshotRef.current;
    const target = previous.key === key ? Math.max(PAGE_SIZE, previous.people.length) : PAGE_SIZE;
    const refreshing = previous.key === key && previous.people.length > 0;
    const active = () => scopeRef.current === scope && !controller.signal.aborted;
    setIsLoading(!refreshing);
    setIsLoadingMore(refreshing);
    setError('');
    if (previous.key !== key) { setPeople([]); setTotal(0); setHasMore(false); }
    const timer = window.setTimeout(async () => {
      let rows = [], cursor = 0, result;
      try {
        do {
          result = await getPeople({ ...options, cursor, limit: PAGE_SIZE, signal: controller.signal });
          if (!active()) return;
          rows = mergePeoplePages(rows, result.people || []);
          if (result.nextCursor != null && Number(result.nextCursor) <= cursor) throw new Error('The people directory returned an invalid page. Try again.');
          cursor = result.nextCursor ?? null;
        } while (cursor !== null && rows.length < target);
        scope.cursor = cursor;
        snapshotRef.current = { key, people: rows };
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
  }, [enabled, key, revision, reload, applyMetadata]);

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
      const rows = mergePeoplePages(snapshotRef.current.people, result.people || []);
      snapshotRef.current = { key: scope.key, people: rows };
      setPeople(rows);
      applyMetadata(result);
    } catch (failure) {
      if (active()) setError(failure.message || 'Could not load more people.');
    } finally {
      if (active()) { scope.loading = false; setIsLoadingMore(false); }
    }
  }, [applyMetadata]);

  return { people, total, counts, attributeCounts, hasMore, isLoading, isLoadingMore, error, loadMore, retry: () => setReload(current => current + 1) };
}
