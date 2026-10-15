import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import GleanButton from './GleanButton';
import './SurveyResults.css';

function Breakdown({ title, rows, total }) {
  return <section className="survey-results-breakdown"><h2>{title}</h2><ul>{rows.map(({ label, count }) => {
    const percent = total ? Math.round(count / total * 100) : 0;
    return <li key={label}><div><span>{label}</span><strong>{count} <small>({percent}%)</small></strong></div><div className="survey-results-track" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div></li>;
  })}</ul></section>;
}

export default function SurveyResults() {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const requestRef = useRef(null);
  const load = async (cursor = null) => {
    if (requestRef.current) return;
    const controller = new AbortController(); requestRef.current = controller;
    setBusy(true); setError('');
    try {
      const next = await apiRequest(`/account/survey/results${cursor ? `?before=${cursor}` : ''}`, { signal: controller.signal });
      if (!controller.signal.aborted) setData(previous => ({ ...next, responses: cursor ? [...previous.responses, ...next.responses] : next.responses }));
    } catch (cause) { if (!controller.signal.aborted) setError(cause.message || 'Could not load survey results.'); }
    finally { if (!controller.signal.aborted) { requestRef.current = null; setBusy(false); } }
  };
  useEffect(() => { load(); return () => { requestRef.current?.abort(); requestRef.current = null; }; }, []);
  return <div className="survey-results" aria-busy={busy}>
    <div className="survey-results-toolbar"><div><strong>{data ? data.total.toLocaleString() : '…'}</strong><span>Total responses</span></div><GleanButton type="button" variant="quiet" onClick={() => load()} disabled={busy}>{busy ? 'Loading…' : 'Refresh results'}</GleanButton></div>
    {error ? <p role="alert">{error}</p> : null}
    {!data && busy ? <div className="survey-results-skeleton" role="status">Loading survey results…</div> : null}
    {data ? <>
      {data.total === 0 ? <p>No responses yet. Results will appear when people submit the survey.</p> : null}
      <div className="survey-results-grid"><Breakdown title="How people feel" rows={data.sentiments} total={data.total} /><Breakdown title="What people want improved" rows={data.improvements} total={data.total} /></div>
      <section className="survey-results-answers"><h2>Individual responses</h2><p>Ordered by account. Each response includes concerns and any Other answer.</p>
        {data.responses.map(row => <article key={row.userId}><header><strong>{row.username}</strong><time dateTime={row.submittedAt}>{new Date(row.submittedAt).toLocaleString()}</time></header><dl><div><dt>Feeling</dt><dd>{row.sentiment}</dd></div><div><dt>Improvement</dt><dd>{row.improvement}</dd></div><div><dt>Concern</dt><dd>{row.concern || 'No concern provided.'}</dd></div>{row.other ? <div><dt>Other</dt><dd>{row.other}</dd></div> : null}</dl></article>)}
        {data.nextCursor ? <GleanButton type="button" onClick={() => load(data.nextCursor)} disabled={busy}>{busy ? 'Loading…' : 'Load more responses'}</GleanButton> : null}
      </section>
    </> : null}
  </div>;
}
