import { useEffect, useRef } from 'react';
import VerifiedMark from '../../components/VerifiedMark';

function AuraAvatar({ user }) {
  return user?.avatarUrl
    ? <img className="loop-aura-avatar" src={user.avatarUrl} alt="" loading="lazy" />
    : <span className="loop-aura-avatar is-fallback" aria-hidden="true">{(user?.username || '?').slice(0, 1).toUpperCase()}</span>;
}

export function LoopAuraTrigger({ summary, onClick }) {
  return <button className="loop-aura-trigger" type="button" onClick={onClick} aria-label={`Aura leaderboard. You have ${summary?.balance || 0} Aura.`}>
    <span aria-hidden="true">✦</span><strong>{Number(summary?.balance || 0).toLocaleString()}</strong><small>Aura</small>
  </button>;
}

export function LoopAuraPanel({ summary, onOpen }) {
  return <section className="loop-aura-panel" aria-labelledby="loop-aura-title">
    <header><div><span className="loop-aura-sparkle" aria-hidden="true">✦</span><h2 id="loop-aura-title">Aura</h2></div><button type="button" onClick={onOpen}>Leaderboard</button></header>
    <div className="loop-aura-total"><strong>{Number(summary?.balance || 0).toLocaleString()}</strong><span>Aura</span></div>
    <p className="loop-aura-streak">🔥 {Number(summary?.streakDays || 0)} day streak</p>
    <ol className="loop-aura-top-list" aria-label="Top Aura earners">
      {(summary?.leaderboard || []).slice(0, 5).map((person, index) => <li key={person.id}>
        <span className="loop-aura-place">{index + 1}</span><AuraAvatar user={person} />
        <span className="loop-aura-person"><strong>{person.username}{person.verified ? <VerifiedMark /> : null}</strong><small>{Number(person.streakDays || 0)} day streak</small></span>
        <b>{Number(person.balance).toLocaleString()}</b>
      </li>)}
      {!summary?.leaderboard?.length ? <li className="loop-aura-empty">Earn Aura to appear here.</li> : null}
    </ol>
    {summary?.rank ? <p className="loop-aura-rank">Your rank <strong>#{summary.rank}</strong></p> : null}
  </section>;
}

export function LoopAuraDialog({ summary, checkIn, mode, onClose, onOpenLeaderboard, onDisableReminder, reminderSaving, reminderError }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll('button')];
      if (!items.length) return;
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [onClose]);

  const claimed = mode === 'claim';
  const top = summary?.leaderboard || [];
  return <div className="loop-aura-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="loop-aura-dialog" role="dialog" aria-modal="true" aria-labelledby="loop-aura-dialog-title" tabIndex={-1} ref={dialogRef}>
      <button className="loop-aura-close" type="button" onClick={onClose} aria-label="Close">×</button>
      <span className="loop-aura-dialog-mark" aria-hidden="true">✦</span>
      {claimed ? <>
        <p className="loop-aura-kicker">DAILY REWARD</p>
        <h2 id="loop-aura-dialog-title">{checkIn?.claimed ? 'You earned Aura!' : 'Your Loop streak is alive!'}</h2>
        <p className="loop-aura-dialog-copy">{checkIn?.claimed ? 'Thanks for stopping by Glean Loop today.' : 'You already collected today’s visit reward.'}</p>
        <div className="loop-aura-reward-number">+{Number(checkIn?.aura || 0)} <span>Aura today</span></div>
        <div className="loop-aura-streak-card"><span>🔥</span><div><strong>{Number(checkIn?.streakDays || summary?.streakDays || 0)} day streak</strong><small>{checkIn?.streakBonus ? `That includes a +${checkIn.streakBonus} streak bonus.` : 'Visit again tomorrow to keep it going.'}</small></div></div>
        <div className="loop-aura-dialog-actions"><button className="loop-aura-secondary" type="button" onClick={onClose}>Keep exploring</button><button className="loop-aura-primary" type="button" onClick={onOpenLeaderboard}>View leaderboard</button></div>
        <button className="loop-aura-never-show" type="button" onClick={onDisableReminder} disabled={reminderSaving}>{reminderSaving ? 'Saving…' : 'Do not show again'}</button>
        {reminderError ? <p className="loop-aura-reminder-error" role="alert">{reminderError}</p> : null}
      </> : <>
        <p className="loop-aura-kicker">AURA LEADERBOARD</p>
        <h2 id="loop-aura-dialog-title">The Loop leaderboard</h2>
        <p className="loop-aura-dialog-copy">Earn Aura by checking in, posting, commenting, getting likes, and bringing people into your community.</p>
        <div className="loop-aura-dialog-you"><span>Your Aura</span><strong>{Number(summary?.balance || 0).toLocaleString()}</strong><small>Rank #{summary?.rank || '—'} · 🔥 {Number(summary?.streakDays || 0)} day streak</small></div>
        <ol className="loop-aura-leaderboard">
          {top.map((person, index) => <li key={person.id} className={person.id === summary?.userId ? 'is-you' : ''}>
            <span className="loop-aura-place">{index + 1}</span><AuraAvatar user={person} />
            <span className="loop-aura-person"><strong>{person.username}{person.verified ? <VerifiedMark /> : null}</strong><small>{Number(person.streakDays || 0)} day streak</small></span>
            <b>{Number(person.balance).toLocaleString()} <small>Aura</small></b>
          </li>)}
          {!top.length ? <li className="loop-aura-empty">No Aura earned yet. You can be first!</li> : null}
        </ol>
      </>}
    </section>
  </div>;
}
