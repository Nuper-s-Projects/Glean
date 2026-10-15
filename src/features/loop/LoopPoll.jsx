import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import { subscribeToDmEvents } from '../../app/dmApi';
import PollVoters from '../../components/PollVoters';

export default function LoopPoll({ postId, poll }) {
  const [current, setCurrent] = useState(poll);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const version = useRef(0);
  const alive = useRef(true);
  useEffect(() => { setCurrent(poll); version.current++; }, [poll]);
  useEffect(() => {
    alive.current = true;
    const refresh = async (event, data) => {
      if (event !== 'loop-post-updated' || Number(data?.postId) !== postId || lock.current) return;
      const requested = ++version.current;
      try {
        const { post } = await apiRequest(`/loop/posts/${postId}`);
        if (alive.current && requested === version.current && post.poll) setCurrent(post.poll);
      } catch (failure) { if (alive.current && requested === version.current) setError(`Results could not refresh: ${failure.message}`); }
    };
    const subscription = subscribeToDmEvents(refresh);
    return () => { alive.current = false; version.current++; subscription.close(); };
  }, [postId]);
  const vote = async (optionIndex) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); version.current++;
    try {
      const { post } = await apiRequest(`/loop/posts/${postId}/poll/vote`, { method: 'POST', body: JSON.stringify({ optionIndex }) });
      if (alive.current) setCurrent(post.poll);
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const voted = current.options.some(option => option.voted);
  return <div className="loop-poll" aria-busy={busy}>
    <h3>{current.question}</h3>
    <div className="loop-poll-options" role="group" aria-label={current.question}>{current.options.map(option => {
      const percent = current.voterCount ? Math.round(option.votes / current.voterCount * 100) : 0;
      return <button className={`loop-poll-option${option.voted ? ' is-voted' : ''}`} type="button" key={option.index} aria-pressed={option.voted} disabled={busy} onClick={() => vote(option.index)}><span className="loop-poll-fill" style={{ width: voted ? `${percent}%` : '0%' }} aria-hidden="true" /><span>{option.text}{option.voted ? ' ✓' : ''}</span>{voted ? <small>{percent}% · {option.votes}</small> : null}</button>;
    })}</div>
    <p className="loop-muted" aria-live="polite">{current.voterCount} {current.voterCount === 1 ? 'vote' : 'votes'} · {busy ? 'Saving vote…' : voted ? 'You can change your vote.' : 'Choose an option to see results.'}</p>
    {error ? <p className="loop-inline-error" role="alert">{error}</p> : null}
    <PollVoters endpoint={`/loop/posts/${postId}/poll/voters`} options={current.options} />
  </div>;
}
