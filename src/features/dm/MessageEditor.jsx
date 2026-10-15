import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export default function MessageEditor({ message, draft, onDraft, onSubmit, onCancel }) {
  const input = useRef(null);
  const form = useRef(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const hintId = useId();
  const errorId = useId();
  const changed = draft !== (message.body || '');
  const valid = Boolean(draft.trim() || message.attachments?.length);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    const element = form.current;
    input.current?.focus({ preventScroll: true });
    input.current?.setSelectionRange(draft.length, draft.length);
    return () => {
      mounted.current = false;
      const restore = element?.contains(document.activeElement) || document.activeElement === document.body;
      if (restore && previous?.isConnected && previous !== document.body) previous.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(240, Math.max(80, element.scrollHeight))}px`;
  }, [draft]);

  const save = async event => {
    event.preventDefault();
    if (locked.current || !changed || !valid) return;
    locked.current = true;
    setSaving(true);
    setError('');
    try { await onSubmit(event, message); }
    catch (failure) {
      if (mounted.current) {
        setError(failure.message || 'Your edit could not be saved. Try again.');
        input.current?.focus({ preventScroll: true });
      }
    } finally {
      locked.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return <form ref={form} className="message-editor" onSubmit={save} aria-busy={saving}>
    <div className="message-editor-heading"><span>Editing message</span><span className={draft.length >= 3800 ? 'is-near-limit' : ''}>{draft.length.toLocaleString()} / 4,000</span></div>
    <textarea ref={input} value={draft} maxLength={4000} rows={2} aria-label="Edit message" aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`} aria-invalid={Boolean(error)} readOnly={saving} onChange={event => { onDraft(event.target.value); if (error) setError(''); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!locked.current) onCancel(); }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!locked.current) form.current?.requestSubmit(); }
    }} />
    {error ? <p id={errorId} className="message-editor-error" role="alert">{error}</p> : null}
    {message.attachments?.length ? <p className="message-editor-attachments-note">{message.attachments.length === 1 ? 'Your attachment stays attached.' : `Your ${message.attachments.length} attachments stay attached.`}</p> : null}
    <div className="message-editor-footer"><span id={hintId}>Enter to save · Shift+Enter for a new line · Esc to cancel</span><div className="message-editor-buttons"><button type="button" disabled={saving} onClick={onCancel}>Cancel</button><button type="submit" disabled={saving || !changed || !valid}>{saving ? 'Saving…' : 'Save changes'}</button></div></div>
  </form>;
}
