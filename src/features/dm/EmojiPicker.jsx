import { EmojiPicker as Frimousse } from 'frimousse';

function CategoryHeader({ category, ...props }) {
  return <div {...props} className="dm-emoji-category">{category.label}</div>;
}

function Row({ children, ...props }) {
  return <div {...props} className="dm-emoji-row">{children}</div>;
}

function Emoji({ emoji, ...props }) {
  return <button {...props} type="button" className="dm-emoji-button" title={emoji.label}>{emoji.emoji}</button>;
}

const components = { CategoryHeader, Row, Emoji };

export default function EmojiPicker({ value, onPick }) {
  return (
    <Frimousse.Root className="dm-emoji-picker" role="dialog" aria-label="Emoji picker" columns={7} locale="en" emojibaseUrl="/emoji-data/17.0.0" onEmojiSelect={({ emoji, label }) => onPick(emoji, label)}>
      <div className="dm-emoji-picker-search">
        <Frimousse.Search autoFocus placeholder="Search emoji" aria-label="Search emoji" />
        <Frimousse.SkinToneSelector className="dm-emoji-tone" aria-label="Change emoji skin tone" />
      </div>
      <Frimousse.Viewport className="dm-emoji-viewport">
        <Frimousse.Loading className="dm-emoji-picker-empty">Loading emoji…</Frimousse.Loading>
        <Frimousse.Empty className="dm-emoji-picker-empty">No emoji matched. Try another search.</Frimousse.Empty>
        <Frimousse.List className="dm-emoji-list" components={components} />
      </Frimousse.Viewport>
      <div className="dm-emoji-preview">
        <Frimousse.ActiveEmoji>{({ emoji }) => <><span aria-hidden="true">{emoji?.emoji || value || '☺️'}</span><span>{emoji?.label || 'Choose an emoji'}</span></>}</Frimousse.ActiveEmoji>
      </div>
    </Frimousse.Root>
  );
}
