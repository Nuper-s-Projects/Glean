import { useEffect, useRef } from 'react';

const LINKS = [
  'https://d19xjrwazytmgq.cloudfront.net',
  'https://d3in7o70h83wqu.cloudfront.net',
  'https://ds3t4i7g3s6wn.cloudfront.net',
];

export default function BackupLinksModal({ onDismiss }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onDismiss();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll('button, a[href]')];
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [onDismiss]);

  return <div className="grade-modal-backdrop backup-links-backdrop">
    <section className="grade-modal backup-links-modal" role="dialog" aria-modal="true" aria-labelledby="backup-links-title" aria-describedby="backup-links-description" tabIndex={-1} ref={dialogRef}>
      <div className="grade-modal-head">
        <span className="grade-modal-step">Keep these links somewhere safe</span>
        <h2 id="backup-links-title">Glean backup links</h2>
        <p id="backup-links-description">If Glean’s main link is blocked or unavailable, try one of these backup links. Please screenshot this screen now so you can still find them later.</p>
      </div>
      <div className="backup-links-list">
        {LINKS.map((link, index) => <a key={link} href={link} target="_blank" rel="noreferrer"><span>Backup {index + 1}</span><code>{link}</code></a>)}
      </div>
      <div className="grade-modal-actions"><button className="primary-button" type="button" onClick={onDismiss}>Got it</button></div>
    </section>
  </div>;
}
