import { memo } from 'react';

function optionPercent(votes, total) {
  if (!total) return 0;
  return Math.round((votes / total) * 100);
}

function ChannelPoll({ poll, canClose = false, disabled = false, onVote, onClose }) {
  if (!poll?.options?.length) return null;
  const total = Number(poll.voterCount || 0);
  const showCounts = poll.closed || poll.options.some((option) => option.voted);
  return (
    <div className={`community-poll${poll.closed ? ' is-closed' : ''}`}>
      <p className="community-poll-question">{poll.question}</p>
      <div className="community-poll-options" role="group" aria-label="Poll options">
        {poll.options.map((option) => {
          const percent = optionPercent(option.votes, total);
          return (
            <button
              key={option.index}
              className={`community-poll-option${option.voted ? ' is-voted' : ''}`}
              type="button"
              disabled={disabled || poll.closed}
              onClick={() => onVote?.(option.index)}
              aria-pressed={option.voted}
            >
              <span className="community-poll-fill" style={{ width: showCounts ? `${percent}%` : 0 }} aria-hidden="true" />
              <span className="community-poll-label">{option.text}</span>
              {showCounts ? <span className="community-poll-count">{option.votes}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="community-poll-meta">
        <small>{total} vote{total === 1 ? '' : 's'}{poll.allowMultiple ? ' · Multiple' : ''}{poll.closed ? ' · Closed' : ''}</small>
        {canClose && !poll.closed ? <button type="button" className="community-poll-close" onClick={onClose}>Close poll</button> : null}
      </div>
    </div>
  );
}

export default memo(ChannelPoll);
