import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { ReportIcon, ReportMessagePreview } from './ReportPrimitives';
import './MessageReports.css';

function RestrictAccount({ report, onRestricted, onBusyChange }) {
  const [amount, setAmount] = useState(1);
  const [unit, setUnit] = useState(86400);
  const [reason, setReason] = useState(report.reason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const confirmationRef = useRef(null);
  const lock = useRef(false);
  useEffect(() => { if (confirmation) confirmationRef.current?.focus(); }, [confirmation]);
  const submit = event => {
    event.preventDefault();
    const durationSeconds = Number(amount) * Number(unit);
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 315360000) { setError('Choose a duration between one minute and ten years.'); return; }
    if (lock.current || !reason.trim()) return;
    setError('');
    setConfirmation({ durationSeconds, reason: reason.trim(), until: new Date(Math.max(Date.now() + durationSeconds * 1000, Date.parse(report.restrictedUntil) || 0)).toISOString() });
  };
  const apply = async () => {
    if (lock.current || !confirmation) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      const result = await apiRequest(`/moderation/reports/${report.id}/restrict`, { method: 'POST', body: JSON.stringify({ durationSeconds: confirmation.durationSeconds, reason: confirmation.reason }) });
      onRestricted(report.targetId, result.restrictedUntil);
      setConfirmation(null);
    } catch (failure) { setError(failure.message); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  };
  return <details className="report-restrict-disclosure">
    <summary><ReportIcon /><span>{report.restrictedUntil ? 'Update restriction' : 'Restrict account'}</span><ReportIcon type="arrow" /></summary>
    <form className="report-restrict-form" onSubmit={submit} aria-busy={busy}>
    {confirmation ? <section className="report-restriction-confirm report-wide" aria-label="Confirm account restriction" tabIndex={-1} ref={confirmationRef}>
      <h4>Restrict {report.targetUsername}?</h4><p>This applies across Glean, not just one server.</p><dl><div><dt>Until</dt><dd>{new Date(confirmation.until).toLocaleString()}</dd></div><div><dt>Reason</dt><dd>{confirmation.reason}</dd></div></dl>
      <p>They can still read messages, but cannot post or join calls. The restriction expires automatically.</p>
      <div className="report-confirm-actions"><button className="report-secondary" type="button" disabled={busy} onClick={() => { setConfirmation(null); setError(''); }}>Cancel</button><button className="report-danger" type="button" disabled={busy} onClick={apply}>{busy ? 'Restricting…' : 'Confirm restriction'}</button></div>
    </section> : <>
    <label>Duration<input type="number" min="1" max="5256000" step="1" required value={amount} onChange={event => setAmount(event.target.value)} disabled={busy} /></label>
    <label>Unit<select aria-label="Unit" value={unit} onChange={event => setUnit(Number(event.target.value))} disabled={busy}><option value={60}>Minutes</option><option value={3600}>Hours</option><option value={86400}>Days</option><option value={604800}>Weeks</option></select></label>
    <label className="report-wide">Restriction reason<input value={reason} onChange={event => setReason(event.target.value)} required maxLength={1000} disabled={busy} /></label>
    <p className="report-wide report-form-hint">Choose a duration in minutes, hours, days, or weeks. Existing restrictions will not be shortened.</p>
    <button className="report-wide report-danger" type="submit" disabled={busy || !reason.trim()}>Review restriction<ReportIcon type="arrow" /></button>
    </>}
    {error ? <p className="report-wide report-error" role="alert">{error}</p> : null}
    </form>
  </details>;
}

function ReportCard({ report, onRestricted, onDismissed }) {
  const [dismissing, setDismissing] = useState(false);
  const [restricting, setRestricting] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const dismiss = async () => {
    if (lock.current || restricting) return;
    lock.current = true; setDismissing(true); setError('');
    try {
      await apiRequest(`/moderation/reports/${report.id}/dismiss`, { method: 'POST', body: '{}' });
      onDismissed(report.id);
    } catch (failure) { setError(failure.message); }
    finally { lock.current = false; setDismissing(false); }
  };
  const reporterProvided = report.evidenceKind.startsWith('reporter-');
  return <article className="report-review-card" aria-label={`Report ${report.id} against ${report.targetUsername}`}>
    <header className="report-card-header"><div><strong className="report-card-reason">{report.reason}</strong><p><span>Report #{report.id}</span><span>·</span><time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time></p></div><span className="report-source">{report.source === 'channel' ? 'Server' : 'DM / group'}</span></header>
    <ReportMessagePreview name={report.targetUsername} body={report.evidence} source={report.source} />
    <p className="report-evidence-note">{reporterProvided ? 'Text shared by the reporter. Not independently verified.' : 'Message text recorded by Glean.'}</p>
    {report.details ? <div className="report-additional-context"><span>Additional details</span><p>{report.details}</p></div> : null}
    <div className="report-card-meta"><span>Reported by <strong>{report.reporterUsername}</strong></span><span>Message #{report.messageId}</span></div>
    {report.restrictedUntil ? <p className="report-active-restriction" role="status"><ReportIcon /><span>Restricted until {new Date(report.restrictedUntil).toLocaleString()}. Restrictions expire automatically.</span></p> : null}
    <fieldset className="report-card-actions" disabled={dismissing} aria-busy={dismissing}>
      <legend className="report-sr-only">Review actions</legend>
      <RestrictAccount report={report} onRestricted={onRestricted} onBusyChange={setRestricting} />
      <div className="report-dismiss-action"><p>Dismiss from the queue. Evidence is kept and account restrictions stay unchanged.</p><button className="report-secondary" type="button" disabled={restricting || dismissing} onClick={dismiss}><ReportIcon type="check" />{dismissing ? 'Dismissing…' : 'Dismiss report'}</button></div>
    </fieldset>
    {error ? <p className="report-error" role="alert">{error}</p> : null}
  </article>;
}

export default function ReportsQueue() {
  const [reports, setReports] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const noticeRef = useRef(null);
  const controllerRef = useRef(null);
  const lastCursor = useRef(null);
  const load = useCallback(async before => {
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    lastCursor.current = before;
    setBusy(true); setError('');
    try {
      const result = await apiRequest(`/moderation/reports${before ? `?before=${before}` : ''}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setReports(current => {
        if (!before) return result.reports;
        const ids = new Set(current.map(item => item.id));
        return [...current, ...result.reports.filter(item => !ids.has(item.id))];
      });
      setCursor(result.nextCursor); setLoaded(true);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.message);
        if (failure.status === 403) { setReports([]); setCursor(null); }
      }
    }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, []);
  useEffect(() => { void load(); return () => controllerRef.current?.abort(); }, [load]);
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);
  const restricted = (targetId, until) => setReports(current => current.map(item => item.targetId === targetId ? { ...item, restrictedUntil: until } : item));
  const dismissed = id => {
    controllerRef.current?.abort();
    setBusy(false);
    setReports(current => current.filter(item => item.id !== id));
    setNotice(`Report #${id} dismissed. Account restrictions were not changed.`);
  };
  return <section className="glean-reports" aria-label="Global message reports">
    <header className="report-queue-header"><div><h2>All Glean reports</h2><p>Every server, DM, and group. Anyone on Glean can be reported, regardless of server membership.</p></div><button className="report-secondary" type="button" disabled={busy} onClick={() => load()}><ReportIcon type="refresh" />Refresh</button></header>
    {notice ? <p className="report-active-restriction" role="status" tabIndex={-1} ref={noticeRef}><ReportIcon type="check" />{notice}</p> : null}
    {loaded && reports.length ? <p className="report-queue-count">Showing {reports.length.toLocaleString()} {reports.length === 1 ? 'report' : 'reports'}{cursor ? ' · More available' : ''} · Newest first</p> : null}
    {busy ? <div className="report-loading" role="status"><span className="report-loading-line" /><span className="report-loading-line" /><span>Loading reports…</span></div> : null}
    {error ? <div className="report-error report-queue-error" role="alert"><p>{error}</p><button className="report-secondary" type="button" onClick={() => load(lastCursor.current)}>Retry</button></div> : null}
    {loaded && !reports.length && !error && !busy ? <div className="report-empty"><ReportIcon type="check" /><h3>No active reports</h3><p>{cursor ? 'More reports are available below.' : 'New reports appear here when someone submits a message for review.'}</p></div> : null}
    {reports.map(report => <ReportCard key={report.id} report={report} onRestricted={restricted} onDismissed={dismissed} />)}
    {cursor ? <button className="report-secondary report-load-more" type="button" disabled={busy} onClick={() => load(cursor)}>Show more reports<ReportIcon type="arrow" /></button> : null}
  </section>;
}
