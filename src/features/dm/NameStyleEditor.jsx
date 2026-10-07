import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { updateAccountNameStyle } from '../../app/dmApi';
import { BANNER_HEX, normalizeHex } from './banner';
import DisplayName from './DisplayName';
import GleanButton from './GleanButton';
import { NAME_FONT_OPTIONS, ensureNameFonts, nameGlowAmount } from './nameStyle';

const GLOW_PRESETS = [
  { label: 'Soft', value: 25 },
  { label: 'Medium', value: 50 },
  { label: 'Strong', value: 75 },
  { label: 'Max', value: 100 },
];

const SOLID_COLORS = ['#249cff', '#1b6fb8', '#7c5cff', '#ff5c8a', '#2ecc71', '#f1c40f', '#e67e22', '#101a23', '#18232e', '#f7fbff'];
const GRADIENTS = [
  { from: '#249cff', to: '#101a23', angle: 135 },
  { from: '#7c5cff', to: '#249cff', angle: 90 },
  { from: '#ff5c8a', to: '#7c5cff', angle: 135 },
  { from: '#101a23', to: '#249cff', angle: 180 },
  { from: '#2ecc71', to: '#249cff', angle: 120 },
  { from: '#f1c40f', to: '#ff5c8a', angle: 45 },
];
const DIRECTIONS = [
  { label: 'Left to right', angle: 90 },
  { label: 'Top to bottom', angle: 180 },
  { label: 'Diagonal down', angle: 135 },
  { label: 'Diagonal up', angle: 45 },
];

function FontOption({ item, selected, sample, onPick }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || !item.href) return;
    const root = node.closest('.dm-name-fonts');
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      ensureNameFonts(item.id);
      io.disconnect();
    }, { root, rootMargin: '120px' });
    io.observe(node);
    return () => io.disconnect();
  }, [item.href, item.id]);
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      className={`dm-name-font${selected ? ' is-active' : ''}`}
      style={{ fontFamily: item.family }}
      onMouseEnter={() => ensureNameFonts(item.id)}
      onFocus={() => ensureNameFonts(item.id)}
      onClick={() => onPick(item.id)}
    >
      <span>{item.label}</span>
      <strong style={{ fontFamily: item.family }}>{sample}</strong>
    </button>
  );
}

function ColorField({ label, value, onChange }) {
  const [hex, setHex] = useState(value);
  useEffect(() => { setHex(value); }, [value]);
  return (
    <label className="dm-banner-color">
      <span>{label}</span>
      <input type="color" value={value} onChange={(event) => onChange(normalizeHex(event.target.value, value))} aria-label={label} />
      <input
        value={hex}
        maxLength="7"
        spellCheck="false"
        aria-label={`${label} hex`}
        onChange={(event) => {
          const next = event.target.value.trim();
          setHex(next);
          if (BANNER_HEX.test(next) || /^[0-9a-f]{6}$/i.test(next)) onChange(normalizeHex(next, value));
        }}
        onBlur={() => setHex(value)}
      />
    </label>
  );
}

function draftFrom(style) {
  const kind = style?.kind === 'solid' || style?.kind === 'gradient' ? style.kind : 'none';
  return {
    kind,
    color: normalizeHex(style?.color, '#249cff'),
    from: normalizeHex(style?.from, '#249cff'),
    to: normalizeHex(style?.to, '#7c5cff'),
    angle: Math.min(360, Math.max(0, Math.round(Number(style?.angle) || 135))),
    glow: nameGlowAmount(style?.glow),
    font: NAME_FONT_OPTIONS.some((item) => item.id === style?.font) ? style.font : 'lexend',
  };
}

function payloadFrom(draft) {
  const glow = nameGlowAmount(draft.glow);
  const next = { font: draft.font };
  if (glow) next.glow = glow;
  if (draft.kind === 'none') {
    if (!glow && next.font === 'lexend') return { kind: 'none' };
    return next;
  }
  if (draft.kind === 'solid') return { ...next, kind: 'solid', color: draft.color };
  return { ...next, kind: 'gradient', from: draft.from, to: draft.to, angle: draft.angle };
}

function previewStyle(draft) {
  const glow = nameGlowAmount(draft.glow);
  const next = { glow: glow || undefined, font: draft.font === 'lexend' ? undefined : draft.font };
  if (draft.kind === 'solid') return { ...next, kind: 'solid', color: draft.color };
  if (draft.kind === 'gradient') return { ...next, kind: 'gradient', from: draft.from, to: draft.to, angle: draft.angle };
  return Object.keys(next).some((key) => next[key]) ? next : null;
}

export default function NameStyleEditor({ account, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => draftFrom(account?.nameStyle));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const preview = useMemo(() => previewStyle(draft), [draft]);
  const fontGroups = useMemo(() => {
    const groups = [];
    for (const item of NAME_FONT_OPTIONS) {
      const last = groups[groups.length - 1];
      if (!last || last.name !== item.group) groups.push({ name: item.group, items: [item] });
      else last.items.push(item);
    }
    return groups;
  }, []);
  const sample = account?.username || 'you';

  useEffect(() => {
    ensureNameFonts(draft.font);
  }, [draft.font]);

  useEffect(() => {
    document.querySelector('.dm-name-font.is-active')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || saving) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, saving]);

  const patch = (next) => setDraft((current) => ({ ...current, ...next }));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const nextAccount = await updateAccountNameStyle(payloadFrom(draft));
      onSaved(nextAccount);
      onClose();
    } catch (next) {
      setError(next.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const nextAccount = await updateAccountNameStyle({ kind: 'none' });
      onSaved(nextAccount);
      onClose();
    } catch (next) {
      setError(next.message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="dm-banner-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="dm-banner-editor dm-name-editor" role="dialog" aria-modal="true" aria-labelledby="name-style-title" aria-busy={saving}>
        <h2 id="name-style-title">Name style</h2>
        <p className="dm-banner-lead">Color, fade, glow, and font for your username. Everyone sees this on your messages and profile.</p>
        <div className="dm-name-preview" aria-label="Preview">
          <DisplayName user={{ username: account?.username || 'you', nameStyle: preview }} />
        </div>
        <div className="dm-banner-tabs" role="tablist" aria-label="Name color">
          <button type="button" className={draft.kind === 'none' ? 'is-active' : ''} aria-pressed={draft.kind === 'none'} onClick={() => patch({ kind: 'none' })}>Default</button>
          <button type="button" className={draft.kind === 'solid' ? 'is-active' : ''} aria-pressed={draft.kind === 'solid'} onClick={() => patch({ kind: 'solid' })}>Solid color</button>
          <button type="button" className={draft.kind === 'gradient' ? 'is-active' : ''} aria-pressed={draft.kind === 'gradient'} onClick={() => patch({ kind: 'gradient' })}>Gradient</button>
        </div>
        {draft.kind === 'solid' ? (
          <div className="dm-banner-panel">
            <ColorField label="Color" value={draft.color} onChange={(color) => patch({ color })} />
            <div className="dm-banner-swatches" role="group" aria-label="Preset colors">
              {SOLID_COLORS.map((item) => (
                <button key={item} type="button" className={item === draft.color ? 'is-active' : ''} style={{ background: item }} aria-label={item} onClick={() => patch({ color: item })} />
              ))}
            </div>
          </div>
        ) : null}
        {draft.kind === 'gradient' ? (
          <div className="dm-banner-panel">
            <div className="dm-banner-colors">
              <ColorField label="Start" value={draft.from} onChange={(from) => patch({ from })} />
              <ColorField label="End" value={draft.to} onChange={(to) => patch({ to })} />
            </div>
            <p className="dm-banner-hint">Direction</p>
            <div className="dm-banner-dirs">
              {DIRECTIONS.map((item) => (
                <button key={item.angle} type="button" className={draft.angle === item.angle ? 'is-active' : ''} onClick={() => patch({ angle: item.angle })}>{item.label}</button>
              ))}
            </div>
            <label className="dm-banner-angle">
              <span>Angle {draft.angle}°</span>
              <input type="range" min="0" max="360" value={draft.angle} onChange={(event) => patch({ angle: Number(event.target.value) })} />
            </label>
            <div className="dm-banner-swatches" role="group" aria-label="Preset gradients">
              {GRADIENTS.map((item) => (
                <button
                  key={`${item.from}-${item.to}-${item.angle}`}
                  type="button"
                  className={draft.from === item.from && draft.to === item.to && draft.angle === item.angle ? 'is-active' : ''}
                  style={{ background: `linear-gradient(${item.angle}deg, ${item.from}, ${item.to})` }}
                  aria-label="Gradient preset"
                  onClick={() => patch({ from: item.from, to: item.to, angle: item.angle })}
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className="dm-banner-panel">
          <p className="dm-banner-hint">Glow</p>
          <div className="dm-settings-actions" role="group" aria-label="Name glow">
            <GleanButton type="button" pressed={draft.glow > 0} onClick={() => patch({ glow: draft.glow || 50 })}>On</GleanButton>
            <GleanButton variant="quiet" type="button" pressed={draft.glow <= 0} onClick={() => patch({ glow: 0 })}>Off</GleanButton>
          </div>
          <div className="dm-banner-dirs" role="group" aria-label="Glow presets">
            {GLOW_PRESETS.map((item) => (
              <button key={item.value} type="button" className={draft.glow === item.value ? 'is-active' : ''} onClick={() => patch({ glow: item.value })}>{item.label}</button>
            ))}
          </div>
          <label className="dm-banner-angle">
            <span>Strength {draft.glow}</span>
            <input type="range" min="0" max="100" value={draft.glow} onChange={(event) => patch({ glow: Number(event.target.value) })} aria-label="Glow strength" />
          </label>
        </div>
        <div className="dm-banner-panel">
          <p className="dm-banner-hint">Font</p>
          <div className="dm-name-fonts" role="listbox" aria-label="Name font">
            {fontGroups.map((group) => (
              <div key={group.name} className="dm-name-font-section">
                <p className="dm-name-font-group">{group.name}</p>
                {group.items.map((item) => (
                  <FontOption
                    key={item.id}
                    item={item}
                    selected={draft.font === item.id}
                    sample={sample}
                    onPick={(id) => patch({ font: id })}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        {error ? <p className="dm-crop-error" role="alert">{error}</p> : null}
        <div className="dm-name-editor-actions">
          <GleanButton variant="quiet" type="button" onClick={reset} disabled={saving}>Reset</GleanButton>
          <GleanButton variant="quiet" type="button" onClick={onClose} disabled={saving}>Cancel</GleanButton>
          <GleanButton type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</GleanButton>
        </div>
      </section>
    </div>,
    document.body,
  );
}
