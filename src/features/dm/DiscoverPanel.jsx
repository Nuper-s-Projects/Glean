import { useEffect, useRef, useState } from 'react';
import { getPublicServers } from '../../app/dmApi';
import { Avatar } from './DmPrimitives';
import DisplayName from './DisplayName';
import { ChevronLeftIcon } from './icons';

export const DISCOVER_FILTERS = [
  { id: 'all', label: 'All people', short: 'All' },
  { id: 'add', label: 'To add', short: 'To add' },
  { id: 'pending', label: 'Requests', short: 'Requests' },
  { id: 'friends', label: 'Friends', short: 'Friends' },
];

export const DISCOVER_ATTRIBUTE_FILTERS = [
  { id: 'magnet', label: 'Magnet' },
  { id: 'laredo-college', label: 'Laredo College' },
];

function relationMeta(person) {
  if (person.relation === 'friend') return { chip: 'Friends', tone: 'friend' };
  if (person.relation === 'outgoing') return { chip: 'Pending', tone: 'pending' };
  if (person.relation === 'incoming') return { chip: 'Incoming', tone: 'incoming' };
  return { chip: 'New', tone: 'new' };
}

function PersonCard({ person, onAdd, onAccept, onDecline, onCancel, onMessage }) {
  const { chip, tone } = relationMeta(person);
  const bio = String(person.bio || '').trim();
  return (
    <article className="dm-discover-card">
      <Avatar user={person} />
      <div className="dm-discover-card-copy">
        <div className="dm-discover-card-head">
          <strong><DisplayName user={person} /></strong>
          {person.relation !== 'none' ? <span className={`dm-discover-chip is-${tone}`}>{chip}</span> : null}
        </div>
        {bio ? <small>{bio}</small> : null}
      </div>
      <div className="dm-discover-card-actions">
        {person.relation === 'friend' ? (
          <button className="dm-small-action is-quiet" type="button" onClick={() => onMessage(person.username)}>Message</button>
        ) : person.relation === 'outgoing' ? (
          <button className="dm-small-action is-quiet" type="button" onClick={() => person.requestId && onCancel(person.requestId)}>Cancel</button>
        ) : person.relation === 'incoming' ? (
          <>
            <button className="dm-small-action" type="button" onClick={() => person.requestId && onAccept(person.requestId)}>Accept</button>
            <button className="dm-small-action is-quiet" type="button" onClick={() => person.requestId && onDecline(person.requestId)}>Decline</button>
          </>
        ) : (
          <button className="dm-small-action" type="button" onClick={() => onAdd(person.username)}>Add</button>
        )}
      </div>
    </article>
  );
}

function PublicServerCard({ server, busy, onJoin }) {
  return (
    <article className="dm-discover-card dm-discover-server-card">
      <span className="community-server-icon dm-discover-server-icon" aria-hidden="true">
        {server.iconUrl ? <img src={server.iconUrl} alt="" loading="lazy" decoding="async" /> : String(server.name || '?').slice(0, 1).toUpperCase()}
      </span>
      <div className="dm-discover-card-copy">
        <div className="dm-discover-card-head"><strong>{server.name}</strong></div>
        <p>{server.description || 'A public Glean server.'}</p>
        <small>{server.memberCount} member{server.memberCount === 1 ? '' : 's'}</small>
      </div>
      <div className="dm-discover-card-actions">
        <button className={`dm-small-action${server.isMember ? ' is-quiet' : ''}`} type="button" disabled={busy} onClick={() => onJoin(server)}>
          {busy ? 'Opening…' : server.isMember ? 'Open' : 'Join'}
        </button>
      </div>
    </article>
  );
}

export default function DiscoverPanel({
  people,
  total,
  counts,
  attributeCounts,
  hasMorePeople,
  isLoadingMorePeople,
  peopleError,
  onLoadMorePeople,
  onRetryPeople,
  query,
  onQuery,
  filter,
  onFilter,
  attributeFilters = [],
  onAttributeFilterToggle,
  isLoading,
  onAdd,
  onAccept,
  onDecline,
  onCancel,
  onMessage,
  onJoinPublic,
  onBack,
}) {
  const [section, setSection] = useState('people');
  const [publicServers, setPublicServers] = useState([]);
  const [publicCursor, setPublicCursor] = useState(null);
  const [publicLoading, setPublicLoading] = useState(false);
  const [publicLoadingMore, setPublicLoadingMore] = useState(false);
  const [publicError, setPublicError] = useState('');
  const [publicReload, setPublicReload] = useState(0);
  const [joiningId, setJoiningId] = useState(null);
  const publicRequestRef = useRef(0);
  const bodyRef = useRef(null);
  const peopleEndRef = useRef(null);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [query, filter, attributeFilters, section]);
  useEffect(() => {
    if (section !== 'people' || !hasMorePeople || isLoading || isLoadingMorePeople || peopleError || !peopleEndRef.current) return undefined;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onLoadMorePeople();
    }, { root: bodyRef.current, rootMargin: '300px' });
    observer.observe(peopleEndRef.current);
    return () => observer.disconnect();
  }, [section, hasMorePeople, isLoading, isLoadingMorePeople, peopleError, onLoadMorePeople, people.length]);
  const cardProps = { onAdd, onAccept, onDecline, onCancel, onMessage };
  const resultTitle = filter === 'add' ? 'People you can add' : filter === 'pending' ? 'Requests' : filter === 'friends' ? 'Friends' : 'People';

  useEffect(() => {
    if (section !== 'servers') return undefined;
    let cancelled = false;
    const requestId = ++publicRequestRef.current;
    const timer = window.setTimeout(async () => {
      setPublicLoading(true);
      setPublicError('');
      try {
        const result = await getPublicServers({ query: query.trim(), cursor: 0 });
        if (cancelled || requestId !== publicRequestRef.current) return;
        setPublicServers(Array.isArray(result.servers) ? result.servers : []);
        setPublicCursor(result.nextCursor ?? null);
      } catch (error) {
        if (!cancelled && requestId === publicRequestRef.current) setPublicError(error.message || 'Could not load public servers.');
      } finally {
        if (!cancelled && requestId === publicRequestRef.current) setPublicLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (requestId === publicRequestRef.current) publicRequestRef.current += 1;
    };
  }, [section, query, publicReload]);

  const loadMorePublicServers = async () => {
    if (publicCursor === null || publicLoadingMore) return;
    const requestId = publicRequestRef.current;
    const requestedQuery = query.trim();
    setPublicLoadingMore(true);
    setPublicError('');
    try {
      const result = await getPublicServers({ query: requestedQuery, cursor: publicCursor });
      if (requestId !== publicRequestRef.current) return;
      setPublicServers((current) => [...current, ...(Array.isArray(result.servers) ? result.servers : [])]);
      setPublicCursor(result.nextCursor ?? null);
    } catch (error) {
      if (requestId === publicRequestRef.current) setPublicError(error.message || 'Could not load more public servers.');
    } finally {
      if (requestId === publicRequestRef.current) setPublicLoadingMore(false);
    }
  };

  const joinPublicServer = async (server) => {
    if (joiningId !== null) return;
    setJoiningId(Number(server.id));
    setPublicError('');
    try {
      await onJoinPublic?.(server.id);
      setPublicServers((current) => current.map((item) => Number(item.id) === Number(server.id) ? { ...item, isMember: true } : item));
    } catch (error) {
      setPublicError(error.message || 'Could not join this server.');
    } finally {
      setJoiningId(null);
    }
  };

  return (
    <section className="dm-discover-page" aria-label="Discover people and public servers">
      <header className="dm-discover-hero">
        <button className="glean-nav-back dm-back-button" type="button" onClick={onBack} aria-label="Back to chats"><ChevronLeftIcon /><span>Chats</span></button>
        <div className="dm-discover-hero-copy">
          <span className="dm-discover-eyebrow">{section === 'people' ? 'PEOPLE' : 'PUBLIC SERVERS'}</span>
          <h1>Discover</h1>
        </div>
      </header>
      <div className="dm-discover-mode-tabs" role="tablist" aria-label="Discover category">
        <button type="button" role="tab" aria-selected={section === 'people'} className={section === 'people' ? 'is-active' : ''} onClick={() => setSection('people')}>People</button>
        <button type="button" role="tab" aria-selected={section === 'servers'} className={section === 'servers' ? 'is-active' : ''} onClick={() => setSection('servers')}>Servers</button>
      </div>
      <div className="dm-discover-toolbar">
        <input
          className="dm-discover-search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={section === 'people' ? 'Search by name or bio' : 'Search public servers'}
          aria-label={section === 'people' ? 'Search people' : 'Search public servers'}
        />
        {section === 'people' ? <>
        <div className="dm-discover-chips" role="group" aria-label="Filter people">
          {DISCOVER_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              className={filter === item.id ? 'is-active' : ''}
              onClick={() => onFilter(item.id)}
            >
              {item.short}
              <b>{counts[item.id]}</b>
            </button>
          ))}
        </div>
        <details className="dm-discover-attribute-filters">
          <summary>School &amp; program{attributeFilters.length ? <b>{attributeFilters.length} selected</b> : null}</summary>
          <div className="dm-discover-chips" role="group" aria-label="Filter by school or program">
            {DISCOVER_ATTRIBUTE_FILTERS.map((item) => {
              const selected = attributeFilters.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selected}
                  className={selected ? 'is-active' : ''}
                  onClick={() => onAttributeFilterToggle?.(item.id)}
                >
                  {item.label}
                  <b>{attributeCounts[item.id]}</b>
                </button>
              );
            })}
          </div>
        </details>
        </> : null}
      </div>
      <div className="dm-discover-body" ref={bodyRef}>
        {section === 'servers' ? (
          publicLoading ? <p className="dm-empty-copy">Loading public servers…</p> : publicError && !publicServers.length ? (
            <div className="dm-discover-empty"><h2>Couldn’t load servers</h2><p>{publicError}</p><button className="dm-small-action" type="button" onClick={() => setPublicReload((value) => value + 1)}>Try again</button></div>
          ) : publicServers.length ? (
            <section className="dm-discover-section">
              <h2>Public servers<span>{publicServers.length}{publicCursor !== null ? '+' : ''}</span></h2>
              <div className="dm-discover-grid">
                {publicServers.map((server) => <PublicServerCard key={server.id} server={server} busy={joiningId === Number(server.id)} onJoin={joinPublicServer} />)}
              </div>
              {publicError ? <p className="dm-empty-copy" role="status">{publicError}</p> : null}
              {publicCursor !== null ? <button className="dm-small-action dm-discover-load-more" type="button" disabled={publicLoadingMore} onClick={loadMorePublicServers}>{publicLoadingMore ? 'Loading…' : 'Show more servers'}</button> : null}
            </section>
          ) : (
            <div className="dm-discover-empty"><h2>{query.trim() ? 'No public servers found' : 'No public servers yet'}</h2><p>{query.trim() ? 'Try another search.' : 'Server owners can make their servers public in server settings.'}</p></div>
          )
        ) : isLoading ? (
          <p className="dm-empty-copy">Loading people…</p>
        ) : peopleError && !people.length ? (
          <div className="dm-discover-empty" role="alert"><h2>Couldn’t load people</h2><p>{peopleError}</p><button className="dm-small-action" type="button" onClick={onRetryPeople}>Try again</button></div>
        ) : !people.length ? (
          <div className="dm-discover-empty">
            <h2>{query.trim() || filter !== 'all' || attributeFilters.length || counts.all ? 'No matches' : 'Nobody else yet'}</h2>
            <p>{query.trim() || filter !== 'all' || attributeFilters.length || counts.all ? 'Try another search or filter.' : 'When others join Glean, they’ll appear here.'}</p>
          </div>
        ) : (
          <section className="dm-discover-section">
            <h2>{resultTitle}<span>{total}</span></h2>
            <div className="dm-discover-grid">
              {people.map((person) => <PersonCard key={person.id} person={person} {...cardProps} />)}
            </div>
          </section>
        )}
        {section === 'people' && !isLoading && people.length > 0 && peopleError ? <p className="dm-empty-copy" role="alert">{peopleError}<button className="dm-small-action" type="button" onClick={onRetryPeople}>Try again</button></p> : null}
        {section === 'people' && !isLoading && hasMorePeople ? (
          <div ref={peopleEndRef} className="dm-discover-people-end"><button className="dm-small-action dm-discover-load-more" type="button" disabled={isLoadingMorePeople} onClick={onLoadMorePeople}>
            {isLoadingMorePeople ? 'Loading…' : `Show more people (${Math.max(0, total - people.length)} remaining)`}
          </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
