import { useEffect, useRef, useState } from 'react';
import { updateAccountMainTheme } from '../../app/dmApi';
import { MAIN_THEME_PRESETS, MAX_CUSTOM_THEMES, mainThemeBackdropStyle, normalizeMainTheme, normalizeMainThemes } from '../../app/mainTheme';
import { PROFILE_BACKGROUND_MAX_BYTES, PROFILE_IMAGE_DEFAULTS } from '../../app/profileBackground';
import { SettingsField, SettingsNotice, SettingsSection } from './AccountSettingsPrimitives';
import GleanButton from './GleanButton';
import './MainThemeSettings.css';

function ThemeSwatch({ theme, preview = false, children }) {
  return <span className="main-theme-swatch" style={mainThemeBackdropStyle(theme, preview)}><span className="main-theme-swatch-image" aria-hidden="true" />{children}</span>;
}

function ThemeTile({ theme, active, busy, onSelect, onEdit, onDelete }) {
  return <div className="main-theme-tile">
    <button type="button" className="main-theme-choice" aria-pressed={active} aria-label={`Use ${theme.name} theme`} disabled={busy} onClick={() => onSelect(theme.id)}>
      <ThemeSwatch theme={theme}><span className="main-theme-mini" aria-hidden="true"><i /><span><b /><b /><b /></span></span><span className="main-theme-selected" aria-hidden="true">{active ? '✓' : ''}</span></ThemeSwatch>
      <strong>{theme.name}</strong>
    </button>
    {onEdit ? <div className="main-theme-tile-actions"><button type="button" onClick={event => onEdit(theme, event.currentTarget)} disabled={busy} aria-label={`Edit ${theme.name} theme`}>Edit</button><button type="button" onClick={() => onDelete(theme)} disabled={busy} aria-label={`Delete ${theme.name} theme`}>Delete</button></div> : null}
  </div>;
}

function PhotoAdjustment({ name, value, onChange, busy }) {
  const label = name === 'blur' ? 'Blur' : name === 'contrast' ? 'Contrast' : 'Saturation';
  return <div className="main-theme-range"><label htmlFor={`theme-${name}`}>{label}<output>{value}{name === 'blur' ? 'px' : '%'}</output></label><input type="range" id={`theme-${name}`} min="0" max={name === 'blur' ? 100 : 200} value={value} disabled={busy} onChange={event => onChange(name, Number(event.target.value))} /></div>;
}

export default function MainThemeSettings({ preferences, onSaved }) {
  const state = normalizeMainThemes(preferences);
  const [draft, setDraft] = useState(null);
  const [source, setSource] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadingPhoto, setLoadingPhoto] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [deleting, setDeleting] = useState(null);
  const editorRef = useRef(null);
  const fileRef = useRef(null);
  const returnFocusRef = useRef(null);
  const alive = useRef(true);
  const photoGeneration = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; photoGeneration.current++; }; }, []);
  useEffect(() => () => { if (source?.url) URL.revokeObjectURL(source.url); }, [source?.url]);
  useEffect(() => { if (draft) editorRef.current?.querySelector('input')?.focus(); }, [Boolean(draft)]);

  const update = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const closeEditor = () => { photoGeneration.current++; setDraft(null); setSource(null); setLoadingPhoto(false); setError(''); requestAnimationFrame(() => { if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true }); }); };
  const edit = (theme, trigger) => {
    returnFocusRef.current = trigger;
    photoGeneration.current++; setSource(null); setLoadingPhoto(false); setDeleting(null); setError(''); setNote('');
    setDraft(theme || { name: '', kind: 'gradient', from: '#183B70', to: '#72518B', angle: 135, ...PROFILE_IMAGE_DEFAULTS });
  };
  const act = async (payload, photo) => {
    if (busy) return;
    setBusy(true); setError(''); setNote('');
    try {
      const nextAccount = await updateAccountMainTheme(payload, photo);
      // Still publish successful saves if the user closed Settings during the request.
      onSaved(nextAccount.mainThemes);
      if (alive.current) { closeEditor(); setDeleting(null); setNote(payload.action === 'delete' ? 'Theme deleted.' : payload.action === 'select' && payload.id === null ? 'Default appearance restored.' : 'Theme applied to Glean.'); }
    } catch (failure) { if (alive.current) setError(failure.message || 'Could not save your theme. Try again.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const pickPhoto = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > PROFILE_BACKGROUND_MAX_BYTES) { setError('Choose a still JPG, PNG, or WebP up to 8 MB.'); return; }
    const generation = ++photoGeneration.current;
    const url = URL.createObjectURL(file);
    setLoadingPhoto(true);
    try {
      const image = new Image(); image.src = url; await image.decode();
      if (image.naturalWidth * image.naturalHeight > 24_000_000) throw new Error('Choose an image up to 24 megapixels.');
      if (!alive.current || generation !== photoGeneration.current) { URL.revokeObjectURL(url); return; }
      setSource({ file, url }); setDraft(current => ({ ...current, kind: 'image', imageUrl: url }));
    } catch (failure) { URL.revokeObjectURL(url); if (alive.current && generation === photoGeneration.current) setError(failure.message.includes('megapixels') ? failure.message : 'This photo could not be opened. Choose another image.'); }
    finally { if (alive.current && generation === photoGeneration.current) setLoadingPhoto(false); }
  };
  const isValid = draft && draft.name.trim() && (draft.kind === 'image' ? Boolean(draft.imageUrl) : Boolean(normalizeMainTheme(draft)));

  return <SettingsSection id="main-themes-title" title="Glean themes" description="Free for everyone. Built-in themes or your own gradient or photo, across Glean only. Glean Loop stays unchanged." className="main-theme-section">
    <div className="main-theme-grid">{MAIN_THEME_PRESETS.map(theme => <ThemeTile key={theme.id} theme={theme} active={state.active === theme.id} busy={busy} onSelect={id => act({ action: 'select', id })} />)}</div>
    <div className="settings-actions"><GleanButton variant="quiet" onClick={() => act({ action: 'select', id: null })} disabled={busy || !state.active}>Use default appearance</GleanButton><GleanButton onClick={event => edit(null, event.currentTarget)} disabled={busy || state.custom.length >= MAX_CUSTOM_THEMES}>Create theme</GleanButton></div>
    {state.custom.length ? <><h3 className="main-theme-subtitle">Your themes <small>{state.custom.length}/{MAX_CUSTOM_THEMES}</small></h3><div className="main-theme-grid">{state.custom.map(theme => <ThemeTile key={theme.id} theme={theme} active={state.active === theme.id} busy={busy} onSelect={id => act({ action: 'select', id })} onEdit={edit} onDelete={theme => { setDeleting(theme); setError(''); }} />)}</div></> : null}
    {deleting ? <div className="main-theme-delete" role="group" aria-label="Confirm theme deletion"><p>Delete “{deleting.name}”?{state.active === deleting.id ? ' Glean will return to its default appearance.' : ''}</p><div className="settings-actions"><GleanButton variant="danger" onClick={() => act({ action: 'delete', id: deleting.id })} disabled={busy}>Delete theme</GleanButton><GleanButton variant="quiet" onClick={() => setDeleting(null)} disabled={busy}>Keep theme</GleanButton></div></div> : null}
    {draft ? <form className="main-theme-editor" ref={editorRef} onSubmit={event => { event.preventDefault(); if (isValid && !loadingPhoto) act({ action: 'save', theme: draft }, draft.kind === 'image' ? source?.file : null); }}>
      <h3>{draft.id ? 'Edit theme' : 'Create your theme'}</h3>
      <SettingsField id="main-theme-name" label="Theme name"><input id="main-theme-name" className="settings-input" value={draft.name} maxLength={40} required disabled={busy} onChange={event => update('name', event.target.value)} placeholder="My theme" /></SettingsField>
      <div className="settings-segmented" role="group" aria-label="Custom theme type">{[['gradient','Gradient'],['image','Photo']].map(([kind, label]) => <button type="button" key={kind} aria-pressed={draft.kind === kind} disabled={busy} onClick={() => { photoGeneration.current++; setLoadingPhoto(false); setError(''); setDraft(current => ({ ...current, kind, from: current.from || '#183B70', to: current.to || '#72518B', angle: current.angle ?? 135 })); }}>{label}</button>)}</div>
      <ThemeSwatch theme={draft} preview><span className="main-theme-preview-content"><strong>Live preview</strong><span>Messages stay sharp and readable.</span><i>Message a friend…</i></span></ThemeSwatch>
      {draft.kind === 'gradient' ? <><div className="main-theme-colors">{[['from','First color'],['to','Second color']].map(([key, label]) => <SettingsField key={key} id={`main-theme-${key}`} label={label}><input id={`main-theme-${key}`} type="color" className="settings-color-input" value={draft[key] || '#183B70'} disabled={busy} onChange={event => update(key, event.target.value)} /></SettingsField>)}</div><div className="main-theme-range"><label htmlFor="main-theme-angle">Direction<output>{draft.angle ?? 135}°</output></label><input id="main-theme-angle" type="range" min="0" max="360" value={draft.angle ?? 135} disabled={busy} onChange={event => update('angle', Number(event.target.value))} /></div><p className="settings-help">Choose two different colors. Solid-color themes aren’t supported.</p></> : <>
        <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp" aria-label="Choose theme photo" onChange={pickPhoto} disabled={busy} />
        <GleanButton variant="quiet" onClick={() => fileRef.current?.click()} disabled={busy || loadingPhoto}>{loadingPhoto ? 'Opening photo…' : draft.imageUrl ? 'Replace photo' : 'Choose photo'}</GleanButton><p className="settings-help">Still JPG, PNG, or WebP. Up to 8 MB and 24 megapixels. Your profile banner and background won’t change.</p>
        {['blur', 'contrast', 'saturation'].map(name => <PhotoAdjustment name={name} key={name} value={draft[name] ?? PROFILE_IMAGE_DEFAULTS[name]} onChange={update} busy={busy} />)}
        <GleanButton variant="quiet" disabled={busy} onClick={() => setDraft(current => ({ ...current, ...PROFILE_IMAGE_DEFAULTS }))}>Reset photo adjustments</GleanButton>
      </>}
      <div className="settings-actions"><GleanButton type="submit" disabled={busy || loadingPhoto || !isValid}>{busy ? 'Saving…' : 'Save and apply theme'}</GleanButton><GleanButton variant="quiet" disabled={busy} onClick={closeEditor}>Cancel</GleanButton></div>
    </form> : null}
    <SettingsNotice error>{error}</SettingsNotice><SettingsNotice>{note}</SettingsNotice>
  </SettingsSection>;
}
