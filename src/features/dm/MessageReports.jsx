import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiRequest } from '../../app/apiClient';
import { REPORT_REASONS } from '../../app/reportReasons';
import { subscribeToDmEvents } from '../../app/dmApi';
import { CloseIcon } from './icons';
import { ReportIcon, ReportMessagePreview } from './ReportPrimitives';
import './MessageReports.css';

const ReportContext = createContext(null);
const REASON_DETAILS = ['Targeted insults or repeated unwanted contact', 'Attacks based on identity or background', 'Unwanted sexual messages or behavior', 'Faces, personal details, or private content', 'Threats of harm or violent content', 'Repeated messages, scams, or unwanted promotion', 'Something else moderators should review'];

function ReportDialog({ target, onClose }) {
  const dialog = useRef(null);
  const lock = useRef(false);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [block, setBlock] = useState(false);
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [step, setStep] = useState(0);
  const heading = useRef(null);
  const scroll = useRef(null);
  const encrypted = Boolean(target.message.encrypted);
  const senderName = target.message.author?.username || target.message.sender?.username;
  useEffect(() => {
    const previous = document.activeElement;
    const node = dialog.current;
    node.showModal();
    return () => { node.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { heading.current?.focus(); scroll.current?.scrollTo(0, 0); }, [step, sent]);
  const submit = async event => {
    event.preventDefault();
    if (!reason || (encrypted && step === 1 && !share)) return;
    if (step === 0) { setStep(1); return; }
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError('');
    try {
      await apiRequest('/message-reports', { method: 'POST', body: JSON.stringify({
        source: target.source, messageId: Number(target.message.id), reason, details,
        blockSender: block, ...(encrypted ? { shareMessage: share, messageText: String(target.message.body || '') } : {}),
      }) });
      setSent(true);
    } catch (failure) { setError(failure.message); }
    finally { lock.current = false; setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="glean-report-dialog" aria-labelledby="report-title" aria-describedby="report-description" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form className="report-dialog-form" onSubmit={submit} aria-busy={busy}>
      <header className="report-dialog-header"><span className={`report-heading-icon${sent ? ' is-success' : ''}`}><ReportIcon type={sent ? 'check' : 'shield'} /></span><div><h2 id="report-title" ref={heading} tabIndex={-1}>{sent ? 'Report submitted' : step === 0 ? 'Report message' : 'Review report'}</h2><p id="report-description">{sent ? 'Thank you for helping keep Glean safe.' : step === 0 ? 'Choose the reason that fits best.' : 'Add context before sending to moderators.'}</p></div><button className="report-icon-button" type="button" aria-label="Close report" disabled={busy} onClick={onClose}><CloseIcon /></button></header>
      {!sent ? <div className="report-step-progress" aria-label={`Step ${step + 1} of 2`}><span className="is-complete" /><span className={step === 1 ? 'is-complete' : ''} /></div> : null}
      <div className="report-dialog-scroll" ref={scroll}>
        {sent ? <div className="report-success"><span className="report-success-mark"><ReportIcon type="check" /></span><h3>Your report is with the team</h3><p>Official Glean moderators can review the selected message, even if the sender is not in the Glean server.</p><div className="report-submitted-reason"><span>Reason</span><strong>{reason}</strong></div>{block ? <p className="report-block-confirmation"><ReportIcon type="check" />The sender is also blocked.</p> : null}</div> : <>
          <ReportMessagePreview name={senderName} body={target.message.body} source={target.source} />
          {step === 0 ? <fieldset className="report-reasons"><legend>Why are you reporting this?</legend>{REPORT_REASONS.map((value, index) => <label className={`report-reason-option${reason === value ? ' is-selected' : ''}`} key={value}><input type="radio" name="report-reason" value={value} checked={reason === value} onChange={() => setReason(value)} /><span><strong>{value}</strong><small>{REASON_DETAILS[index]}</small></span></label>)}</fieldset> : <>
            <div className="report-selected-reason"><div><small>Reason</small><strong>{reason}</strong></div><button className="report-text-button" type="button" disabled={busy} onClick={() => setStep(0)}>Change</button></div>
            <label className="report-field">Additional details (optional)<textarea aria-label="Additional details (optional)" value={details} maxLength={2000} rows={3} placeholder="Tell us what happened…" onChange={event => setDetails(event.target.value)} disabled={busy} /><span className="report-field-caption"><span>Describe any image or file here.</span><span>{details.length.toLocaleString()}/2,000</span></span></label>
            {encrypted ? <label className="report-check report-consent"><input type="checkbox" required checked={share} onChange={event => setShare(event.target.checked)} disabled={busy} /><span><strong>Share this selected message’s decrypted text with Glean moderators</strong><small>The rest of this conversation stays private.</small></span></label> : null}
            <label className="report-check"><input type="checkbox" checked={block} onChange={event => setBlock(event.target.checked)} disabled={busy} /><span><strong>Block sender too</strong><small>You can also block them when submitting this report.</small></span></label>
          </>}
          <p className="report-privacy-note"><ReportIcon />Only this message’s text is shared with official Glean moderators. Attachments and unrelated messages are not included.</p>
          {error ? <p className="report-error" role="alert">{error}</p> : null}
        </>}
      </div>
      <footer className="report-dialog-footer">{sent ? <button className="report-primary" type="button" onClick={onClose}>Done</button> : <><button className="report-secondary" type="button" disabled={busy} onClick={step === 0 ? onClose : () => setStep(0)}>{step === 0 ? 'Cancel' : 'Back'}</button><span className="report-step-label">{step + 1} of 2</span><button className="report-primary" type="submit" disabled={busy || !reason || (step === 1 && encrypted && !share)}>{busy ? 'Submitting…' : step === 0 ? 'Continue' : 'Submit report'}{!busy ? <ReportIcon type={step === 0 ? 'arrow' : 'flag'} /> : null}</button></>}</footer>
    </form>
  </dialog>, document.body);
}

export function MessageReportsProvider({ account, children }) {
  const [target, setTarget] = useState(null);
  const [restriction, setRestriction] = useState(account?.restriction || null);
  const open = useCallback(value => setTarget(value), []);
  const context = useMemo(() => ({ open }), [open]);
  useEffect(() => {
    setTarget(null); setRestriction(account?.restriction || null);
    if (!account?.id) return undefined;
    const controller = new AbortController();
    apiRequest('/account/restriction', { signal: controller.signal }).then(payload => setRestriction(payload.restriction)).catch(() => {});
    const subscription = subscribeToDmEvents((event, payload) => { if (event === 'account-restricted') setRestriction(payload); });
    return () => { controller.abort(); subscription.close(); };
  }, [account?.id, account?.restriction]);
  useEffect(() => {
    if (!restriction) return undefined;
    let timer;
    const checkExpiry = () => {
      const remaining = Date.parse(restriction.until) - Date.now();
      if (remaining <= 0) setRestriction(null);
      else timer = setTimeout(checkExpiry, Math.min(remaining, 3600000));
    };
    checkExpiry();
    return () => clearTimeout(timer);
  }, [restriction]);
  return <ReportContext.Provider value={context}>{restriction ? <aside className="glean-restriction-banner" role="status">Your account is restricted until {new Date(restriction.until).toLocaleString()}. You can read messages but cannot post or join calls. {restriction.reason}</aside> : null}{children}{target ? <ReportDialog target={target} onClose={() => setTarget(null)} /> : null}</ReportContext.Provider>;
}

export function useMessageReport(message, source, own = false) {
  const context = useContext(ReportContext);
  const [position, setPosition] = useState(null);
  const menuRef = useRef(null);
  const canReport = Boolean(context && !own && Number(message.id) > 0 && !message.decryptionFailed);
  const report = () => { setPosition(null); context?.open({ message, source }); };
  useEffect(() => {
    if (!position) return undefined;
    menuRef.current?.querySelector('button')?.focus();
    const dismiss = event => { if (!menuRef.current?.contains(event.target)) setPosition(null); };
    const close = event => { if (event.key === 'Escape') setPosition(null); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', close); window.removeEventListener('scroll', dismiss, true); };
  }, [position]);
  return {
    canReport, report,
    onContextMenu: event => {
      if (!canReport || event.defaultPrevented || event.target.closest('a,textarea,input,video,audio')) return;
      event.preventDefault(); event.stopPropagation();
      setPosition({ left: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)), top: Math.max(8, Math.min(event.clientY, window.innerHeight - 65)) });
    },
    menu: position ? createPortal(<div ref={menuRef} className="glean-report-menu" role="menu" style={position}><button role="menuitem" type="button" onClick={report}><ReportIcon type="flag" />Report message</button></div>, document.body) : null,
  };
}
