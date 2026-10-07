import { useEffect, useRef, useState } from 'react';
import { getAnalytics, getAnalyticsPeople } from '../../app/dmApi';
import { schoolBadgeStyle } from '../../app/laredoSchools';
import { formatEstablished } from './formatters';
import { ChartIcon, ChevronLeftIcon } from './icons';
import { Avatar } from './DmPrimitives';

const PEOPLE_PAGE_SIZE = 50;

function percent(count, total) {
  if (!total) return 0;
  return Math.max(count ? 6 : 0, Math.round((Number(count || 0) / total) * 100));
}

function StatCard({ label, value, hint }) {
  return (
    <article className="dm-analytics-stat">
      <small>{label}</small>
      <strong>{value}</strong>
      {hint ? <span>{hint}</span> : null}
    </article>
  );
}

function BarList({ title, items, total }) {
  if (!items?.length) return null;
  return (
    <section className="dm-analytics-section">
      <h2>{title}</h2>
      <div className="dm-analytics-bars">
        {items.map((item) => {
          const style = schoolBadgeStyle(item.hex) || undefined;
          return (
            <div className={`dm-analytics-bar${item.id === 'hidden' ? ' is-hidden' : ''}`} key={item.id} style={style}>
              <span>{item.label}</span>
              <i style={{ width: `${percent(item.count, total)}%` }} />
              <b>{item.count}</b>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function AnalyticsPanel({ onBack }) {
  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [people, setPeople] = useState([]);
  const [peopleCursor, setPeopleCursor] = useState(null);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [peopleError, setPeopleError] = useState('');
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const querySequence = useRef(0);
  const queryValue = useRef('');
  queryValue.current = peopleQuery.trim();

  useEffect(() => {
    let alive = true;
    setIsLoading(true);
    getAnalytics().then((payload) => {
      if (!alive) return;
      setAnalytics(payload.analytics || null);
      setError('');
    }).catch((caught) => {
      if (!alive) return;
      setError(caught.message || 'Could not load analytics.');
    }).finally(() => {
      if (alive) setIsLoading(false);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const sequence = ++querySequence.current;
    let alive = true;
    const timer = window.setTimeout(async () => {
      setIsLoadingPeople(true);
      setPeopleError('');
      try {
        const page = await getAnalyticsPeople({ query: peopleQuery.trim(), limit: PEOPLE_PAGE_SIZE });
        if (!alive || querySequence.current !== sequence) return;
        setPeople(page.people || []);
        setPeopleCursor(page.nextCursor ?? null);
      } catch (caught) {
        if (alive && querySequence.current === sequence) setPeopleError(caught.message || 'Could not load people.');
      } finally {
        if (alive && querySequence.current === sequence) setIsLoadingPeople(false);
      }
    }, peopleQuery.trim() ? 220 : 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [peopleQuery]);

  const loadMorePeople = async () => {
    if (peopleCursor == null || isLoadingMore) return;
    const requestedQuery = peopleQuery.trim();
    const sequence = querySequence.current;
    setIsLoadingMore(true);
    setPeopleError('');
    try {
      const page = await getAnalyticsPeople({ query: requestedQuery, cursor: peopleCursor, limit: PEOPLE_PAGE_SIZE });
      if (sequence !== querySequence.current || requestedQuery !== queryValue.current) return;
      setPeople((current) => [...current, ...(page.people || [])]);
      setPeopleCursor(page.nextCursor ?? null);
    } catch (caught) {
      if (sequence === querySequence.current && requestedQuery === queryValue.current) setPeopleError(caught.message || 'Could not load more people.');
    } finally {
      setIsLoadingMore(false);
    }
  };

  const members = Number(analytics?.members || 0);
  const maxJoin = Math.max(1, ...(analytics?.joins || []).map((item) => Number(item.count || 0)));

  return (
    <section className="dm-discover-page dm-analytics-page" aria-label="Community analytics">
      <header className="dm-discover-hero">
        <button className="glean-nav-back dm-back-button" type="button" onClick={onBack} aria-label="Back to chats"><ChevronLeftIcon /><span>Chats</span></button>
        <span className="dm-discover-hero-icon" aria-hidden="true"><ChartIcon /></span>
        <div className="dm-discover-hero-copy">
          <h1>Community analytics</h1>
          <p>Community trends and per-person school, grade, program, and join details.</p>
        </div>
        <span className="dm-discover-hero-count">{members || '—'}</span>
      </header>
      <div className="dm-discover-body">
        {isLoading ? (
          <p className="dm-empty-copy">Loading analytics…</p>
        ) : error ? (
          <p className="dm-empty-copy" role="alert">{error}</p>
        ) : (
          <>
            <div className="dm-analytics-stats">
              <StatCard label="Members" value={members} hint={analytics.oldestAt ? `Since ${formatEstablished(analytics.oldestAt)}` : ''} />
              <StatCard label="Joined this week" value={analytics.joinedThisWeek} />
              <StatCard label="Joined this month" value={analytics.joinedThisMonth} />
            </div>
            <BarList title="Grade" items={analytics.grades} total={members} />
            <BarList title="School" items={analytics.schools} total={members} />
            <BarList title="Programs" items={analytics.programs} total={members} />
            <section className="dm-analytics-section">
              <h2>Joins</h2>
              <div className="dm-analytics-joins" aria-label="Joins by month">
                {(analytics.joins || []).map((item) => (
                  <div className="dm-analytics-join" key={item.month}>
                    <i style={{ height: `${Math.round((Number(item.count || 0) / maxJoin) * 100)}%` }} />
                    <b>{item.count}</b>
                    <span>{item.label.replace(' 20', ' ')}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="dm-analytics-section dm-analytics-people-section">
              <div className="dm-analytics-people-heading">
                <div><h2>People</h2><p>Profile details for each Glean member</p></div>
                <label className="dm-analytics-people-search">
                  <span className="visually-hidden">Search people</span>
                  <input aria-label="Search people" value={peopleQuery} onChange={(event) => setPeopleQuery(event.target.value)} placeholder="Search usernames" />
                </label>
              </div>
              {peopleError ? <p className="dm-empty-copy" role="alert">{peopleError}</p> : null}
              {isLoadingPeople ? <p className="dm-empty-copy">Loading people…</p> : !people.length && !peopleError ? <p className="dm-empty-copy">No people match this search.</p> : (
                <div className="dm-analytics-people-list">
                  {people.map((person) => (
                    <article className="dm-analytics-person" key={person.id}>
                      <Avatar user={person} />
                      <div className="dm-analytics-person-copy">
                        <strong>{person.username}</strong>
                        <span>{[person.gradeLabel, person.schoolLabel, ...(person.programs || []).map((program) => program.label)].filter(Boolean).join(' · ') || 'No profile details shared'}</span>
                      </div>
                      <time dateTime={person.joinedAt}>{person.joinedAt ? formatEstablished(person.joinedAt) : 'Date unavailable'}</time>
                    </article>
                  ))}
                </div>
              )}
              {peopleCursor != null ? <button className="dm-small-action dm-analytics-load-more" type="button" onClick={loadMorePeople} disabled={isLoadingMore}>{isLoadingMore ? 'Loading…' : 'Load more people'}</button> : null}
            </section>
            <p className="dm-analytics-note">Hidden is people who skipped grade, school, or programs. Profiles still show those badges one-to-one.</p>
          </>
        )}
      </div>
    </section>
  );
}
