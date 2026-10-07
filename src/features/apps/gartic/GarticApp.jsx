import { useEffect, useMemo, useRef, useState } from 'react';
import { submitGarticPage } from '../../../app/dmApi';
import { CommunityAvatar } from '../../community/CommunityAvatar';
import DisplayName from '../../dm/DisplayName';
import GleanButton from '../../dm/GleanButton';
import { GARTIC_MODES, GARTIC_TIMERS } from '../catalog';
import DrawPad, { DrawingPreview } from './DrawPad';

function useCountdown(deadline) {
  const [left, setLeft] = useState(() => (deadline ? Math.max(0, deadline - Date.now()) : 0));
  useEffect(() => {
    if (!deadline) {
      setLeft(0);
      return undefined;
    }
    setLeft(Math.max(0, deadline - Date.now()));
    const timer = window.setInterval(() => setLeft(Math.max(0, deadline - Date.now())), 250);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return Math.ceil(left / 1000);
}

function Lobby({ state, session, isHost, onStart, notice }) {
  const [mode, setMode] = useState('normal');
  const [seconds, setSeconds] = useState(60);
  const players = session?.participants || [];
  const activeMode = GARTIC_MODES.find((item) => item.id === mode);

  return (
    <div className="glean-gartic-lobby">
      <h2>Gartic Phone</h2>
      <p>Write a prompt, pass it on, and watch it fall apart. {players.length} in the app.</p>
      {notice ? <p className="glean-app-error" role="alert">{notice}</p> : null}
      <div className="glean-gartic-players">
        {players.map((player) => (
          <span key={player.id} className="glean-gartic-player">
            <CommunityAvatar user={player} small interactive={false} />
            <strong><DisplayName user={player} /></strong>
          </span>
        ))}
      </div>
      {isHost ? (
        <>
          <div className="glean-gartic-modes" role="radiogroup" aria-label="Game mode">
            {GARTIC_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={mode === item.id}
                className={mode === item.id ? 'is-active' : undefined}
                onClick={() => setMode(item.id)}
              >
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
          <div className="glean-gartic-timer-pick">
            <span>Round time</span>
            <div role="group" aria-label="Round time">
              {GARTIC_TIMERS.map((item) => (
                <button key={item} type="button" className={seconds === item ? 'is-active' : undefined} aria-pressed={seconds === item} onClick={() => setSeconds(item)}>
                  {item}s
                </button>
              ))}
            </div>
          </div>
          <GleanButton type="button" onClick={() => onStart({ mode, seconds })} disabled={players.length < 2}>
            {players.length < 2 ? 'Need 2 players' : `Start ${activeMode?.label}`}
          </GleanButton>
        </>
      ) : (
        <p className="glean-gartic-wait">Waiting for the host to start the game.</p>
      )}
      {state?.phase === 'done' ? <p className="glean-gartic-wait">That game ended.</p> : null}
    </div>
  );
}

function RevealPage({ page, label }) {
  return (
    <section className="glean-gartic-reveal-page">
      <span className="glean-gartic-reveal-label">{label}</span>
      {page.kind === 'draw' ? <DrawingPreview content={page.content} /> : <p>{page.content}</p>}
      <small>Created by <strong>{page.author?.username || 'Someone'}</strong></small>
    </section>
  );
}

function Reveal({ state, isHost, onReset, onNext }) {
  const books = state.books || [];
  const revealIndex = Math.max(0, Math.min(books.length - 1, Number(state.revealIndex) || 0));
  const book = books[revealIndex] || { pages: [] };
  const pages = Array.isArray(book.pages) ? book.pages : [];
  const promptIndex = pages.findIndex((page) => page.kind === 'text');
  const drawingIndex = pages.findIndex((page, index) => page.kind === 'draw' && (promptIndex < 0 || index > promptIndex));
  const promptPage = promptIndex >= 0 ? pages[promptIndex] : null;
  const drawingPage = drawingIndex >= 0 ? pages[drawingIndex] : null;
  const revealKey = `${revealIndex}:${drawingIndex}`;
  const [shownKey, setShownKey] = useState('');
  const [nexting, setNexting] = useState(false);

  useEffect(() => {
    setNexting(false);
    if (!promptPage || !drawingPage) {
      setShownKey(revealKey);
      return undefined;
    }
    setShownKey('');
    const timer = window.setTimeout(() => setShownKey(revealKey), 2000);
    return () => window.clearTimeout(timer);
  }, [drawingIndex, promptIndex, revealKey]);

  const drawingVisible = shownKey === revealKey || !promptPage || !drawingPage;
  const remainingPages = drawingPage ? pages.slice(drawingIndex + 1) : pages.filter((_, index) => index !== promptIndex);
  const next = () => {
    if (nexting || !drawingVisible) return;
    setNexting(true);
    onNext();
  };

  return (
    <div className="glean-gartic-reveal">
      <header>
        <span className="glean-gartic-reveal-heading">
          <h2>Reveal</h2>
          <small>Chain {books.length ? revealIndex + 1 : 0} of {books.length}</small>
        </span>
        <span className="glean-gartic-reveal-status">{drawingVisible ? 'Drawing revealed' : 'Prompt first'}</span>
      </header>
      <div className="glean-gartic-reveal-card" aria-live="polite">
        {promptPage ? <RevealPage page={promptPage} label="Prompt" /> : null}
        {drawingPage && drawingVisible ? <RevealPage page={drawingPage} label="Drawing" /> : null}
        {drawingPage && !drawingVisible ? (
          <section className="glean-gartic-reveal-page is-waiting">
            <span className="glean-gartic-reveal-label">Drawing</span>
            <p>Revealing drawing…</p>
          </section>
        ) : null}
        {drawingVisible ? remainingPages.map((page, index) => (
          <RevealPage key={`${revealIndex}-${drawingIndex}-${index}`} page={page} label={page.kind === 'draw' ? 'Drawing' : 'Guess'} />
        )) : null}
        {!pages.length ? <p className="glean-gartic-wait">No pages were submitted for this chain.</p> : null}
      </div>
      <div className="glean-gartic-reveal-actions">
        {!isHost ? <p className="glean-gartic-wait">The host controls the next reveal.</p> : null}
        {isHost && revealIndex < books.length - 1 ? (
          <button className="glean-gartic-reveal-next" type="button" onClick={next} disabled={!drawingVisible || nexting}>{nexting ? 'Loading…' : 'Next drawing'}</button>
        ) : null}
        {isHost && revealIndex >= books.length - 1 ? <button className="glean-gartic-reveal-next" type="button" onClick={onReset}>Back to lobby</button> : null}
      </div>
    </div>
  );
}

export default function GarticApp({ state, session, isHost, accountId, sendOp, scopeKey, notice, onNotice }) {
  const padRef = useRef(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const task = state?.task || null;
  const secondsLeft = useCountdown(state?.deadline || null);
  const [peekOver, setPeekOver] = useState(false);

  useEffect(() => {
    setText('');
    setPeekOver(false);
    if (!task?.peek) return undefined;
    const timer = window.setTimeout(() => setPeekOver(true), 6000);
    return () => window.clearTimeout(timer);
  }, [state?.round, state?.phase, task?.peek]);

  const players = useMemo(() => state?.players || [], [state]);
  const waiting = players.filter((player) => !player.submitted && !player.left);

  if (!state || state.phase === 'lobby' || state.phase === 'done') {
    return <Lobby state={state} session={session} isHost={isHost} notice={notice} onStart={(options) => sendOp({ type: 'start', ...options })} />;
  }

  if (state.phase === 'reveal') {
    return <Reveal state={state} isHost={isHost} onReset={() => sendOp({ type: 'reset' })} onNext={() => sendOp({ type: 'reveal-next' })} />;
  }

  const submit = async () => {
    if (busy || !task || task.submitted) return;
    const content = task.kind === 'draw' ? padRef.current?.value() : text;
    if (task.kind !== 'draw' && !String(content || '').trim()) {
      onNotice?.(task.kind === 'write' ? 'Write a prompt first.' : 'Describe the drawing first.');
      return;
    }
    setBusy(true);
    try {
      await submitGarticPage(scopeKey, state.round, content);
    } catch (error) {
      onNotice?.(error.message || 'That answer could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const heading = task?.kind === 'write' ? 'Write a prompt'
    : task?.kind === 'guess' ? 'What is this?'
    : state.mode === 'knockoff' && state.round > 0 ? 'Copy this drawing'
    : state.mode === 'complement' && state.round > 0 ? 'Finish this drawing'
    : state.mode === 'complement' ? 'Scribble something'
    : state.mode === 'knockoff' ? 'Draw anything'
    : 'Draw this';

  return (
    <div className="glean-gartic-round">
      <header>
        <span>
          <strong>{heading}</strong>
          <small>Round {state.round + 1} of {state.totalRounds} · {state.modeLabel}</small>
        </span>
        <span className={`glean-gartic-clock${secondsLeft <= 5 ? ' is-urgent' : ''}`}>{secondsLeft}s</span>
      </header>
      {notice ? <p className="glean-app-error" role="alert">{notice}</p> : null}
      {task?.prompt ? <p className="glean-gartic-prompt">{task.prompt}</p> : null}
      {task?.reference && !(task.peek && peekOver) ? (
        <div className="glean-gartic-reference">
          <DrawingPreview content={task.reference} />
          {task.peek ? <small>Look fast — this hides in a moment.</small> : null}
        </div>
      ) : null}
      {task?.reference && task.peek && peekOver ? <p className="glean-gartic-wait">Reference hidden. Draw it from memory.</p> : null}
      {task?.submitted ? (
        <div className="glean-gartic-submitted">
          <p>Answer locked in.</p>
          <small>{waiting.length ? `Waiting on ${waiting.map((player) => player.username).join(', ')}` : 'Everyone is done.'}</small>
        </div>
      ) : task?.kind === 'draw' ? (
        <>
          <DrawPad ref={padRef} seed={task.seed || '[]'} blind={Boolean(state.blind)} />
          <button className="glean-gartic-submit-button" type="button" onClick={submit} disabled={busy}>{busy ? 'Sending…' : 'Submit drawing'}</button>
        </>
      ) : (
        <form
          className="glean-gartic-write"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, 160))}
            placeholder={task?.kind === 'write' ? 'A raccoon running a bank' : 'Describe what you see'}
            maxLength={160}
            autoFocus
          />
          <button className="glean-gartic-submit-button" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
        </form>
      )}
      <ul className="glean-gartic-status">
        {players.map((player) => (
          <li key={player.id} className={player.submitted ? 'is-done' : undefined}>
            <CommunityAvatar user={player} small interactive={false} />
            <span>{player.username}{Number(player.id) === Number(accountId) ? ' (you)' : ''}</span>
            <small>{player.left ? 'Left' : player.submitted ? 'Done' : 'Working'}</small>
          </li>
        ))}
      </ul>
      {isHost ? <button type="button" className="glean-gartic-skip" onClick={() => sendOp({ type: 'skip' })}>Skip round</button> : null}
    </div>
  );
}
