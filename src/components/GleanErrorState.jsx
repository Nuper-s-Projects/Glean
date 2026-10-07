import { useState } from 'react';
import { API_PREFIX } from '../app/apiClient';

function cleanClientText(value, max = 5000) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

export default function GleanErrorState({ title = 'Something went wrong', description = 'Glean hit an unexpected problem.', error = '', fullPage = false, onDismiss }) {
  const [reportState, setReportState] = useState('idle');
  const report = async () => {
    if (reportState === 'sending' || reportState === 'sent') return;
    setReportState('sending');
    try {
      const response = await fetch(`${API_PREFIX}/error-reports`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: fullPage ? 'route' : 'runtime',
          route: window.location.pathname,
          title: cleanClientText(title, 160),
          message: cleanClientText(error || description),
        }),
      });
      if (!response.ok) throw new Error('Report failed.');
      setReportState('sent');
    } catch {
      setReportState('failed');
    }
  };

  const content = (
    <section className="glean-error-card" role="alertdialog" aria-modal={!fullPage} aria-labelledby="glean-error-title">
      <img className="glean-error-logo" src="/glean-mark.svg" alt="Glean logo" />
      <p className="glean-error-kicker">GLEAN</p>
      <h1 id="glean-error-title">{title}</h1>
      <p className="glean-error-description">{description}</p>
      {error ? <details className="glean-error-details"><summary>Technical details</summary><pre>{error}</pre></details> : null}
      <div className="glean-error-actions">
        <button type="button" onClick={report} disabled={reportState === 'sending' || reportState === 'sent'}>
          {reportState === 'sending' ? 'Sending…' : reportState === 'sent' ? 'Reported' : 'Report this problem'}
        </button>
        {onDismiss ? <button type="button" className="is-quiet" onClick={onDismiss}>Dismiss</button> : null}
      </div>
      {reportState === 'failed' ? <p className="glean-error-report-note" role="status">Could not send the report. Please try again.</p> : null}
      {reportState === 'sent' ? <p className="glean-error-report-note" role="status">Thanks. The report was saved for review.</p> : null}
    </section>
  );

  return fullPage ? <main className="glean-error-page">{content}</main> : <div className="glean-error-backdrop">{content}</div>;
}
