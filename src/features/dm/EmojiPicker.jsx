import { useMemo, useState } from 'react';
import { EMOJI_GROUPS } from './emojiData';

export default function EmojiPicker({ value, onPick }) {
  const [query, setQuery] = useState('');
  const [groupId, setGroupId] = useState(EMOJI_GROUPS[0].id);
  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    if (!needle) return EMOJI_GROUPS;
    return EMOJI_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(([, name]) => name.includes(needle) || name.replace(/\s+/g, '_').includes(needle.replace(/\s+/g, '_'))),
    })).filter((group) => group.items.length);
  }, [needle]);
  const active = groups.find((group) => group.id === groupId) || groups[0];

  return (
    <div className="dm-emoji-picker" role="dialog" aria-label="Emoji picker">
      <div className="dm-emoji-picker-search">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emoji"
          aria-label="Search emoji"
        />
      </div>
      <div className="dm-emoji-picker-tabs" role="tablist">
        {(needle ? groups : EMOJI_GROUPS).map((group) => (
          <button
            key={group.id}
            type="button"
            role="tab"
            aria-selected={active?.id === group.id}
            className={active?.id === group.id ? 'is-active' : ''}
            onClick={() => setGroupId(group.id)}
          >
            {group.label}
          </button>
        ))}
      </div>
      {active ? (
        <div className="dm-emoji-picker-grid" role="listbox" aria-label={active.label}>
          {active.items.map(([emoji, name]) => (
            <button
              key={`${emoji}-${name}`}
              type="button"
              role="option"
              aria-selected={value === emoji}
              className={value === emoji ? 'is-active' : ''}
              title={name}
              onClick={() => onPick(emoji, name)}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : (
        <p className="dm-emoji-picker-empty">No emoji matched.</p>
      )}
    </div>
  );
}
