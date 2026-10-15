import { useEffect, useRef } from 'react';

export default function LoopIntroductionModal({ onOpenLoop, onDismiss }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onDismiss();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll('button')];
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

  return <div className="loop-intro-backdrop">
    <section className="loop-intro-modal" role="dialog" aria-modal="true" aria-labelledby="loop-intro-title" aria-describedby="loop-intro-description" tabIndex={-1} ref={dialogRef}>
      <img className="loop-intro-logo" src="/glean-mark.svg" alt="" />
      <p className="loop-intro-kicker">INTRODUCING</p>
      <h2 id="loop-intro-title">Glean Loop</h2>
      <p id="loop-intro-description" className="loop-intro-description">Like TikTok and Instagram, all here on Glean. Share posts, discover people, and watch Flow. Check in daily, create and join conversations, and earn Aura rewards on the leaderboard.</p>
      <div className="loop-intro-actions">
        <button className="loop-intro-dismiss" type="button" onClick={onDismiss}>Dismiss</button>
        <button className="loop-intro-open" type="button" onClick={onOpenLoop}>Open Loop</button>
      </div>
    </section>
  </div>;
}
