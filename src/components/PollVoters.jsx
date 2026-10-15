import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../app/apiClient';

export default function PollVoters({ endpoint, options }) {
  const [open, setOpen] = useState(false);
  const [option, setOption] = useState(0);
  const [voters, setVoters] = useState([]);
  const [next, setNext] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const load = useCallback(async (after = 0) => {
    const request = ++version.current;
    setBusy(true); setError('');
    try {
      const result = await apiRequest(`${endpoint}?option=${option}&after=${after}`);
      if (request !== version.current) return;
      setVoters(previous => after ? [...previous, ...result.voters] : result.voters);
      setNext(result.next);
    } catch (failure) { if (request === version.current) setError(failure.message); }
    finally { if (request === version.current) setBusy(false); }
  }, [endpoint, option]);
  useEffect(() => {
    setVoters([]); setNext(null);
    if (open && endpoint) load();
    return () => { version.current++; };
  }, [open, load, endpoint]);
  if (!endpoint) return null;
  return <div style={{ marginTop: 8 }}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide voters' : 'View voters'}</button>
    {open ? <section aria-label="Poll voters" style={{ padding: 12, border: '1px solid currentColor', borderRadius: 12, marginTop: 8 }}>
      <label>Option <select value={option} onChange={event => setOption(Number(event.target.value))} style={{ maxWidth: '100%' }}>{options.map(item => <option key={item.index} value={item.index}>{item.text}</option>)}</select></label>
      <ul style={{ listStyle: 'none', padding: 0, maxHeight: 240, overflowY: 'auto' }}>{voters.map(person => <li key={person.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', overflowWrap: 'anywhere' }}>{person.avatarUrl ? <img src={person.avatarUrl} alt="" width="28" height="28" loading="lazy" style={{ borderRadius: '50%', objectFit: 'cover' }} /> : null}{person.username}</li>)}</ul>
      {!busy && !error && !voters.length ? <p>No votes for this option yet.</p> : null}
      {busy ? <p role="status">Loading voters…</p> : null}
      {error ? <p role="alert">{error} <button type="button" onClick={() => load()}>Retry</button></p> : null}
      {next && !error ? <button type="button" disabled={busy} onClick={() => load(next)}>Show more</button> : null}
      {!error ? <button type="button" disabled={busy} onClick={() => load()}>Refresh voters</button> : null}
    </section> : null}
  </div>;
}
