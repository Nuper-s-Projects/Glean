import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../app/apiClient';
import { FEEDBACK_SENTIMENTS, FEEDBACK_IMPROVEMENTS, FEEDBACK_CONCERN_LIMIT, FEEDBACK_OTHER_LIMIT } from '../app/feedbackSurvey';
import './FeedbackSurveyModal.css';

export default function FeedbackSurveyModal({ onCompleted, onLater }) {
  const dialog = useRef(null), submitting = useRef(false);
  const [clear, setClear] = useState(false);
  const [sentiment, setSentiment] = useState(''), [concern, setConcern] = useState('');
  const [improvement, setImprovement] = useState(''), [other, setOther] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    // Wait for onboarding, announcements, settings, and other dialogs to finish.
    const check = () => setClear(![...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(node => !node.classList.contains('glean-survey-modal')));
    const observer = new MutationObserver(check); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal'] }); check();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!clear) return;
    const previous = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog.current?.focus();
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [clear]);
  const submit = async event => {
    event.preventDefault();
    if (submitting.current || !sentiment || !improvement || (improvement === 'Other' && !other.trim())) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = await apiRequest('/account/survey', { method: 'POST', body: JSON.stringify({ sentiment, concern, improvement, other: improvement === 'Other' ? other : '' }) });
      onCompleted(result.account);
    } catch (failure) { setError(failure.message || 'Your answers could not be saved. Please try again.'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const keyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!submitting.current) onLater(); }
    if (event.key !== 'Tab') return;
    const nodes = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)')].filter(node => node.getClientRects().length);
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  if (!clear) return null;
  return <div className="glean-survey-backdrop" onKeyDown={keyDown}>
    <section className="glean-survey-modal" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="glean-survey-title" aria-describedby="glean-survey-description" tabIndex={-1} ref={dialog}>
      <header><img src="/glean-mark.svg" alt="" /><div><p>GLEAN FEEDBACK</p><h2 id="glean-survey-title">Survey</h2></div></header>
      <p id="glean-survey-description">3 quick questions. Your answers are saved with your Glean account. Please don’t include passwords or sensitive information.</p>
      <form onSubmit={submit}>
        <div className="glean-survey-body">
          <fieldset disabled={busy}><legend>1. How do you feel about using Glean?</legend><div className="glean-survey-options">{FEEDBACK_SENTIMENTS.map(option => <label key={option} className={sentiment === option ? 'is-selected' : ''}><input type="radio" name="sentiment" value={option} checked={sentiment === option} onChange={() => setSentiment(option)} required /><span>{option}</span></label>)}</div></fieldset>
          <fieldset disabled={busy}><legend><label htmlFor="glean-survey-concern">2. If you had an concern about Glean, what would it be?</label></legend><textarea id="glean-survey-concern" value={concern} onChange={event => setConcern(event.target.value)} maxLength={FEEDBACK_CONCERN_LIMIT} rows={3} placeholder="Share a concern, if you have one…" /><small>Optional · {concern.length.toLocaleString()}/{FEEDBACK_CONCERN_LIMIT.toLocaleString()}</small></fieldset>
          <fieldset disabled={busy}><legend>3. What would you most like to see improved in Glean?</legend><div className="glean-survey-options glean-survey-improvements">{FEEDBACK_IMPROVEMENTS.map(option => <label key={option} className={improvement === option ? 'is-selected' : ''}><input type="radio" name="improvement" value={option} checked={improvement === option} onChange={() => setImprovement(option)} required /><span>{option === 'Other' ? 'Other (text box)' : option}</span></label>)}</div>{improvement === 'Other' ? <label className="glean-survey-other">What else would you like improved?<textarea value={other} onChange={event => setOther(event.target.value)} maxLength={FEEDBACK_OTHER_LIMIT} rows={2} required placeholder="Tell us what you have in mind…" /><small>{other.length}/{FEEDBACK_OTHER_LIMIT}</small></label> : null}</fieldset>
          {error ? <p className="glean-survey-error" role="alert">{error}</p> : null}
        </div>
        <footer><button type="button" disabled={busy} onClick={onLater}>Not now</button><button type="submit" disabled={busy || !sentiment || !improvement || (improvement === 'Other' && !other.trim())}>{busy ? 'Saving…' : 'Submit feedback'}</button></footer>
      </form>
    </section>
  </div>;
}
