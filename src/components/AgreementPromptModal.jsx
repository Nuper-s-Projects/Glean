import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../app/apiClient';
import { AGREEMENT_WAIT_SECONDS, CONDUCT_VERSION, TERMS_SECTIONS, TERMS_VERSION } from '../app/agreements';

const CONDUCT_PDF = '/documents/uisd-student-code-of-conduct-2026-27.pdf#page=13&view=FitH';

export default function AgreementPromptModal({ account, onAccepted, onSignOut }) {
  const dialogRef = useRef(null);
  const promptStartedAt = useRef(0);
  const [activeDocument, setActiveDocument] = useState('terms');
  const [termsChecked, setTermsChecked] = useState(false);
  const [conductChecked, setConductChecked] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(AGREEMENT_WAIT_SECONDS);
  const [promptReady, setPromptReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [promptAttempt, setPromptAttempt] = useState(0);
  const [conductText, setConductText] = useState('');
  const [conductLoadError, setConductLoadError] = useState('');

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], iframe, [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPromptReady(false);
    setError('');
    setSecondsLeft(AGREEMENT_WAIT_SECONDS);
    apiRequest('/account/agreements')
      .then(() => {
        if (!cancelled) {
          promptStartedAt.current = Date.now();
          setPromptReady(true);
        }
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError.message || 'Could not load the agreement. Try again.');
      });
    return () => { cancelled = true; };
  }, [account?.id, promptAttempt]);

  useEffect(() => {
    let cancelled = false;
    fetch('/documents/uisd-student-code-of-conduct-2026-27.txt')
      .then((response) => {
        if (!response.ok) throw new Error('The text copy could not be loaded. Open the original PDF instead.');
        return response.text();
      })
      .then((text) => { if (!cancelled) setConductText(text.replace(/\f/g, '\n\n────────────────────────\n\n')); })
      .catch((loadError) => { if (!cancelled) setConductLoadError(loadError.message || 'The text copy could not be loaded.'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!promptReady || secondsLeft <= 0) return undefined;
    const start = promptStartedAt.current;
    const update = () => {
      const nextSeconds = Math.max(0, Math.ceil((start + AGREEMENT_WAIT_SECONDS * 1000 - Date.now()) / 1000));
      setSecondsLeft((current) => current === nextSeconds ? current : nextSeconds);
    };
    const interval = window.setInterval(() => {
      update();
    }, 200);
    update();
    return () => window.clearInterval(interval);
  }, [promptReady, secondsLeft > 0]);

  const accept = async () => {
    if (!termsChecked || !conductChecked || !promptReady || secondsLeft > 0 || saving) return;
    setSaving(true);
    setError('');
    try {
      const { account: updatedAccount } = await apiRequest('/account/agreements', {
        method: 'POST',
        body: JSON.stringify({
          termsVersion: TERMS_VERSION,
          conductVersion: CONDUCT_VERSION,
          termsAccepted: true,
          conductAccepted: true,
        }),
      });
      onAccepted(updatedAccount);
    } catch (requestError) {
      setError(requestError.message || 'Could not save your agreement. Try again.');
      if (requestError.status === 425) setPromptAttempt((attempt) => attempt + 1);
    } finally {
      setSaving(false);
    }
  };

  const acceptDisabled = !promptReady || secondsLeft > 0 || !termsChecked || !conductChecked || saving;

  return (
    <div className="agreement-backdrop" role="presentation">
      <section className="agreement-modal" role="dialog" aria-modal="true" aria-labelledby="agreement-title" aria-describedby="agreement-description" tabIndex={-1} ref={dialogRef}>
        <header className="agreement-header">
          <div>
            <p className="agreement-kicker">REQUIRED BEFORE CONTINUING</p>
            <h1 id="agreement-title">Review Glean’s terms</h1>
            <p id="agreement-description">Please review Glean’s Terms of Service and the UISD Student Code of Conduct.</p>
          </div>
          <img src="/glean-mark.svg" alt="Glean" />
        </header>

        <div className="agreement-tabs" role="tablist" aria-label="Agreement documents">
          <button id="agreement-tab-terms" type="button" role="tab" aria-selected={activeDocument === 'terms'} aria-controls="agreement-panel-terms" onClick={() => setActiveDocument('terms')}>Glean Terms of Service</button>
          <button id="agreement-tab-conduct" type="button" role="tab" aria-selected={activeDocument === 'conduct'} aria-controls="agreement-panel-conduct" onClick={() => setActiveDocument('conduct')}>UISD Student Code of Conduct</button>
        </div>

        {activeDocument === 'terms' ? (
          <div className="agreement-document" id="agreement-panel-terms" role="tabpanel" aria-labelledby="agreement-tab-terms" tabIndex={0}>
            <p className="agreement-document-title">Glean Terms of Service <span>v2</span></p>
            {TERMS_SECTIONS.map((section) => (
              <section className="agreement-term-section" key={section.title}>
                <h2>{section.title}</h2>
                {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              </section>
            ))}
          </div>
        ) : (
          <div className="agreement-document agreement-conduct-document" id="agreement-panel-conduct" role="tabpanel" aria-labelledby="agreement-tab-conduct" tabIndex={0}>
            <div className="agreement-document-title">UISD Student Code of Conduct <span>2026–2027</span></div>
            <p className="agreement-draft-date">Readable text from the Student Code of Conduct pages in the provided PDF. The original PDF includes other handbook sections.</p>
            <div className="agreement-code-text" tabIndex={0} aria-label="UISD Student Code of Conduct text" aria-busy={!conductText && !conductLoadError}>
              {conductText ? <pre>{conductText}</pre> : conductLoadError ? <p role="alert">{conductLoadError}</p> : <p>Loading the Student Code of Conduct…</p>}
            </div>
            <a className="agreement-open-pdf" href={CONDUCT_PDF} target="_blank" rel="noopener noreferrer">Open the document in a new tab</a>
          </div>
        )}

        <div className="agreement-acknowledgements">
          <label><input type="checkbox" checked={termsChecked} onChange={(event) => setTermsChecked(event.target.checked)} /> <span>I agree to Glean’s Terms of Service and will follow its safety and conduct rules.</span></label>
          <label><input type="checkbox" checked={conductChecked} onChange={(event) => setConductChecked(event.target.checked)} /> <span>I have reviewed the UISD Student Code of Conduct and agree to follow it when it applies to me.</span></label>
        </div>

        {error ? <p className="agreement-error" role="alert">{error}</p> : null}
        <footer className="agreement-footer">
          <button className="glean-btn is-quiet" type="button" disabled={saving} onClick={onSignOut}>Sign out</button>
          <div className="agreement-footer-actions">
            <span className="agreement-wait" role="status">{!promptReady ? 'Loading documents…' : secondsLeft > 0 ? `Please wait ${secondsLeft} seconds before continuing.` : 'You can continue when both boxes are checked.'}</span>
            <button className="glean-btn" type="button" disabled={acceptDisabled} onClick={accept}>{saving ? 'Saving…' : 'Accept and continue'}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
