import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useId, memo } from 'react';
import { Liquid } from 'liquid-gooey';
import { Glass } from '@samasante/liquid-glass';
import { AttachIcon, CloseIcon, MegaphoneIcon, MicIcon, PlusIcon, PollIcon, SendIcon } from './icons';
import { classifyFileKind, formatMediaTime } from './formatters';
import { insertMention, isEveryoneMention, mentionQueryAt } from './mentions';
import { AudioAttachment, useObjectUrl, VideoAttachment } from './MediaPlayers';
import { Avatar } from './DmPrimitives';
import { useImagePreview } from './ImagePreview';
import { canRecordVoice, pickRecorderType, voiceFileFromBlob, VOICE_MAX_MS } from './voiceNote';
import { apiRequest } from '../../app/apiClient';
import { normalizeAccessibility } from '../../app/accessibility';
import { matchingBotCommands } from './botCommands';

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024 * 1024;
export function glassOptics(frostSetting, depthSetting = 20, refractionSetting = 100) {
  const frost = Math.min(1, Math.max(0, frostSetting / 100));
  const depth = Math.min(1, Math.max(0, depthSetting / 100));
  const refractionStrength = Math.min(1, Math.max(0, refractionSetting / 100));
  const frostAmount = 0.15 + (frost ** 2) * 8;
  const refraction = 1 - frost * 0.82;
  return {
    mapSize: Math.round(154 * (1 - frost * 0.5)),
    frost: frostAmount,
    strength: 0.1 * refractionStrength * refraction,
    dispersion: 0,
    brightness: 0,
    specular: 0,
    sheen: 0,
    sheenAngle: 315,
    sheenWidth: 4,
    glow: 0,
    curvature: 1,
    depth,
    bend: 0,
  };
}

export function typingStatusText(names = []) {
  const users = [...new Set(names.filter(Boolean))];
  if (users.length >= 4) return 'Several people are typing…';
  if (users.length === 3) return `${users[0]}, ${users[1]}, and ${users[2]} are typing…`;
  if (users.length === 2) return `${users[0]} and ${users[1]} are typing…`;
  if (users.length === 1) return `${users[0]} is typing…`;
  return '';
}

function PendingFile({ file, onRemove }) {
  const kind = classifyFileKind(file.type, file.name);
  const preview = kind === 'image' || kind === 'audio' || kind === 'video';
  const url = useObjectUrl(preview ? file : null);
  const showMedia = Boolean(url) && preview;
  const { open } = useImagePreview();

  return (
    <div className={`dm-pending-file dm-pending-file-${kind}`}>
      {kind === 'image' && url ? (
        <button type="button" className="dm-pending-file-open" onClick={() => open({ src: url, alt: file.name, name: file.name })} aria-label={`Preview ${file.name}`}>
          <img src={url} alt="" />
        </button>
      ) : null}
      {kind === 'audio' && url ? <AudioAttachment src={url} name={file.name} size={file.size} /> : null}
      {kind === 'video' && url ? <VideoAttachment src={url} name={file.name} mutedPreview /> : null}
      {showMedia ? null : <span className="dm-pending-file-label" title={file.name}>{file.name}</span>}
      <button type="button" className="dm-pending-file-remove" onClick={onRemove} aria-label={`Remove ${file.name}`} title="Remove attachment">×</button>
    </div>
  );
}

function sameMention(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.start === right.start && left.query === right.query;
}

function fitTextarea(node) {
  if (!node) return;
  const styles = getComputedStyle(node);
  const minHeight = Number.parseFloat(styles.minHeight) || 40;
  if (!node.value) {
    node.style.removeProperty('height');
    return;
  }
  node.style.height = '0px';
  const cap = Number.parseFloat(styles.maxHeight) || 168;
  node.style.height = `${Math.min(Math.max(node.scrollHeight, minHeight), cap)}px`;
}

function extFromType(type) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
  };
  if (map[type]) return map[type];
  const subtype = String(type || '').split('/')[1] || 'bin';
  return subtype.split('+')[0].replace(/[^a-z0-9]/gi, '') || 'bin';
}

function namedClipboardFile(file, index) {
  if (!file) return null;
  const type = file.type || 'application/octet-stream';
  const given = String(file.name || '').trim();
  const name = given && given !== 'blob' ? given : `paste-${Date.now()}-${index + 1}.${extFromType(type)}`;
  if (file instanceof File && file.name === name) return file;
  return new File([file], name, { type, lastModified: file.lastModified || Date.now() });
}

function filesFromDataTransfer(data) {
  if (!data) return [];
  const raw = [];
  if (data.items?.length) {
    for (const item of data.items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) raw.push(file);
    }
  }
  if (!raw.length && data.files?.length) raw.push(...Array.from(data.files));
  const seen = new Set();
  const files = [];
  raw.forEach((file, index) => {
    const next = namedClipboardFile(file, index);
    if (!next?.size) return;
    const key = `${next.name}:${next.size}:${next.type}:${next.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(next);
  });
  return files;
}

function isTypingField(node) {
  if (!node || node === document.body) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function useReducedMotionPreference() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    update();
    return () => {
      media.removeEventListener('change', update);
    };
  }, []);
  return reduced;
}

function GifPicker({ onPick }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const search = async (value, offset = 0) => {
    setLoading(true);
    try {
      const result = await apiRequest(`/gifs/search?q=${encodeURIComponent(value)}&offset=${offset}`);
      setGifs((current) => offset ? [...current, ...(result.gifs || [])] : (result.gifs || []));
      setNextOffset(Number(result.nextOffset || 0));
      setHasMore(Boolean(result.hasMore));
    } catch { if (!offset) setGifs([]); setHasMore(false); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    const value = query.trim();
    if (!value) { setGifs([]); setHasMore(false); return undefined; }
    const timer = window.setTimeout(async () => {
      await search(value, 0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  return <div className="dm-gif-picker" role="dialog" aria-label="GIF picker"><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search GIPHY" aria-label="Search GIFs" /><div className="dm-gif-grid">{gifs.map((gif) => <button key={gif.id} type="button" onClick={() => onPick(gif)} title={gif.title}><img src={gif.previewUrl} data-fallback={gif.url} alt={gif.title} loading="lazy" onError={(event) => { const fallback = event.currentTarget.dataset.fallback; if (fallback && event.currentTarget.src !== fallback) event.currentTarget.src = fallback; else event.currentTarget.style.display = 'none'; }} /></button>)}</div>{loading ? <p>Loading GIFs…</p> : hasMore ? <button className="dm-gif-load-more" type="button" onClick={() => search(query.trim(), nextOffset)}>Load more GIFs</button> : null}</div>;
}

function VoiceLive({ analyser, elapsed }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!analyser) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const data = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const draw = () => {
      analyser.getByteTimeDomainData(data);
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bars = 52;
      const gap = 3 * ratio;
      const barWidth = Math.max(2 * ratio, (canvas.width / bars) - gap);
      ctx.fillStyle = 'rgba(247, 251, 255, 0.88)';
      for (let i = 0; i < bars; i += 1) {
        const sample = data[Math.floor((i / bars) * data.length)] || 128;
        const amp = Math.min(1, Math.abs(sample - 128) / 42);
        const barHeight = Math.max(3 * ratio, amp * canvas.height * 0.92);
        const x = i * (barWidth + gap);
        const y = (canvas.height - barHeight) / 2;
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
          ctx.fill();
        } else ctx.fillRect(x, y, barWidth, barHeight);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  return (
    <div className="dm-voice-live">
      <canvas ref={canvasRef} aria-hidden="true" />
      <small>{formatMediaTime(elapsed)}</small>
    </div>
  );
}

function emptyPoll() {
  return { question: '', options: ['', ''], allowMultiple: false };
}

export function normalizePoll(poll) {
  if (!poll) return null;
  const question = String(poll.question || '').trim();
  const options = (Array.isArray(poll.options) ? poll.options : []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!question || options.length < 2 || options.length > 10) return null;
  return { question, options, allowMultiple: Boolean(poll.allowMultiple) };
}

function PollBuilder({ poll, onChange, disabled, error = '' }) {
  const options = poll.options.length < 2 ? [...poll.options, '', ''].slice(0, 2) : poll.options;
  const canAdd = options.length < 10;
  const canRemove = options.length > 2;
  const filledOptionCount = options.filter((option) => String(option || '').trim()).length;
  const countError = filledOptionCount < 2 || filledOptionCount > 10;
  return (
    <div className="dm-poll-builder">
      <div className="dm-poll-builder-head">
        <strong>Poll</strong>
        <button type="button" onClick={() => onChange(null)} disabled={disabled} aria-label="Remove poll"><CloseIcon /></button>
      </div>
      <input
        className="dm-poll-question"
        value={poll.question}
        onChange={(event) => onChange({ ...poll, question: event.target.value.slice(0, 300) })}
        placeholder="Ask a question"
        maxLength={300}
        disabled={disabled}
      />
      <div className="dm-poll-options">
        {options.map((option, index) => (
          <div className="dm-poll-option-row" key={index}>
            <input
              value={option}
              onChange={(event) => {
                const next = options.slice();
                next[index] = event.target.value.slice(0, 100);
                onChange({ ...poll, options: next });
              }}
              placeholder={`Option ${index + 1}`}
              maxLength={100}
              disabled={disabled}
            />
            {canRemove ? (
              <button type="button" onClick={() => onChange({ ...poll, options: options.filter((_, optionIndex) => optionIndex !== index) })} disabled={disabled} aria-label={`Remove option ${index + 1}`}>×</button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="dm-poll-builder-foot">
        <button type="button" onClick={() => onChange({ ...poll, options: [...options, ''] })} disabled={disabled || !canAdd}>{canAdd ? 'Add option' : '10 options max'}</button>
        <label className="dm-poll-multi">
          <input type="checkbox" checked={Boolean(poll.allowMultiple)} onChange={(event) => onChange({ ...poll, allowMultiple: event.target.checked })} disabled={disabled} />
          Allow multiple
        </label>
      </div>
      {error || countError ? <p className="dm-poll-builder-error" role="alert">{error || 'Polls need 2–10 options.'}</p> : null}
    </div>
  );
}

function SendButton({ disabled, isSending }) {
  const glareRef = useRef(null);

  const onMove = (event) => {
    const glare = glareRef.current;
    if (!glare) return;
    const rect = event.currentTarget.getBoundingClientRect();
    glare.style.left = `${event.clientX - rect.left}px`;
    glare.style.top = `${event.clientY - rect.top}px`;
  };

  return (
    <button
      className="dm-send-button"
      type="submit"
      disabled={disabled}
      aria-label={isSending ? 'Sending message' : 'Send message'}
      onMouseEnter={() => { if (glareRef.current) glareRef.current.style.opacity = '0.7'; }}
      onMouseLeave={() => { if (glareRef.current) glareRef.current.style.opacity = '0'; }}
      onMouseMove={onMove}
    >
      <span className="dm-send-glare" ref={glareRef} aria-hidden="true" />
      {isSending ? <span className="dm-upload-spinner" aria-hidden="true" /> : <SendIcon />}
    </button>
  );
}

export default function MessageComposer({
  draft,
  onDraftChange,
  onSubmit,
  placeholder,
  disabled = false,
  isSending = false,
  attachments = [],
  onAttachmentsChange,
  onBlur,
  maxLength = 2000,
  composerRef,
  mentionUsers = [],
  commandBots = [],
  replyTo = null,
  onClearReply,
  typingText = '',
  poll = null,
  onPollChange,
  accessibility = null,
}) {
  const fileInputRef = useRef(null);
  const menuTriggerRef = useRef(null);
  const menuRef = useRef(null);
  const localComposerRef = useRef(null);
  const textareaRef = composerRef || localComposerRef;
  const skipMentionAt = useRef(-1);
  const mentionUsersRef = useRef(mentionUsers);
  mentionUsersRef.current = mentionUsers;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [mention, setMention] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const commandListId = useId();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(null);
  const [commandCaret, setCommandCaret] = useState(draft.length);
  const commandOptions = !disabled && !poll && commandDismissed !== draft
    ? matchingBotCommands(commandBots, draft, commandCaret) : [];
  const activeCommandIndex = Math.min(commandIndex, Math.max(0, commandOptions.length - 1));
  useEffect(() => {
    document.getElementById(`${commandListId}-${activeCommandIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [commandListId, activeCommandIndex, draft]);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [analyser, setAnalyser] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [pollError, setPollError] = useState('');
  const glassSettings = normalizeAccessibility(accessibility);
  const glassFrost = glassSettings.glassFrost;
  const composerGlassOptics = useMemo(
    () => glassOptics(glassFrost, glassSettings.glassDepth, glassSettings.glassRefraction),
    [glassFrost, glassSettings.glassDepth, glassSettings.glassRefraction],
  );
  const sessionRef = useRef(null);
  const menuCloseTimer = useRef(null);
  const menuOpenFrame = useRef(0);
  const recordingRef = useRef(false);
  const submitLock = useRef(false);
  const reduceMotion = useReducedMotionPreference();
  const canRecord = canRecordVoice();

  const openComposerMenu = useCallback(() => {
    window.clearTimeout(menuCloseTimer.current);
    menuCloseTimer.current = null;
    setMenuMounted(true);
    if (menuOpenFrame.current) window.cancelAnimationFrame(menuOpenFrame.current);
    menuOpenFrame.current = window.requestAnimationFrame(() => {
      menuOpenFrame.current = 0;
      setMenuOpen(true);
    });
  }, []);

  const closeComposerMenu = useCallback(() => {
    if (menuOpenFrame.current) window.cancelAnimationFrame(menuOpenFrame.current);
    menuOpenFrame.current = 0;
    setMenuOpen(false);
    window.clearTimeout(menuCloseTimer.current);
    menuCloseTimer.current = window.setTimeout(() => {
      setMenuMounted(false);
      menuCloseTimer.current = null;
    }, reduceMotion ? 0 : 380);
  }, [reduceMotion]);

  const toggleComposerMenu = useCallback(() => {
    if (menuOpen) closeComposerMenu();
    else openComposerMenu();
  }, [menuOpen, closeComposerMenu, openComposerMenu]);

  useEffect(() => () => {
    window.clearTimeout(menuCloseTimer.current);
    if (menuOpenFrame.current) window.cancelAnimationFrame(menuOpenFrame.current);
  }, []);

  useLayoutEffect(() => { fitTextarea(textareaRef.current); }, [draft]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (!menuRef.current?.contains(event.target)) closeComposerMenu();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [menuOpen, closeComposerMenu]);

  const stopSession = (keep = false) => {
    const session = sessionRef.current;
    sessionRef.current = null;
    recordingRef.current = false;
    setRecording(false);
    setAnalyser(null);
    setElapsed(0);
    if (!session) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = () => {
        session.stream?.getTracks().forEach((track) => track.stop());
        session.context?.close().catch(() => {});
        if (session.timer) window.clearInterval(session.timer);
        const blob = new Blob(session.chunks, { type: session.mime || 'audio/webm' });
        resolve(keep ? voiceFileFromBlob(blob, session.mime) : null);
      };
      if (session.recorder && session.recorder.state !== 'inactive') {
        session.recorder.onstop = finish;
        try { session.recorder.stop(); } catch { finish(); }
      } else finish();
    });
  };

  useEffect(() => () => { stopSession(false); }, []);
  useEffect(() => {
    if (disabled && recordingRef.current) stopSession(false);
  }, [disabled]);

  const startRecording = async () => {
    if (disabled || isSending || recordingRef.current || !canRecord) return;
    setRecordError('');
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const mime = pickRecorderType();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const Context = window.AudioContext || window.webkitAudioContext;
      const context = new Context();
      const source = context.createMediaStreamSource(stream);
      const node = context.createAnalyser();
      node.fftSize = 256;
      source.connect(node);
      await context.resume().catch(() => {});
      const session = { stream, recorder, context, mime: recorder.mimeType || mime, chunks: [], started: Date.now(), timer: 0 };
      recorder.ondataavailable = (event) => { if (event.data?.size) session.chunks.push(event.data); };
      recorder.onerror = () => { setRecordError('Could not record audio.'); stopSession(false); };
      try {
        recorder.start(120);
      } catch {
        recorder.start();
      }
      sessionRef.current = session;
      recordingRef.current = true;
      setRecording(true);
      setAnalyser(node);
      setElapsed(0);
      session.timer = window.setInterval(() => {
        const ms = Date.now() - session.started;
        setElapsed(ms / 1000);
        if (ms >= VOICE_MAX_MS) stopSession(true).then((file) => { if (file) appendFiles([file]); });
      }, 200);
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      setRecordError('Microphone permission is needed to send a voice message.');
    }
  };

  const toggleRecording = () => {
    if (recordingRef.current) stopSession(false);
    else startRecording();
  };

  const appendFiles = (files) => {
    if (!files.length || !onAttachmentsChange || disabled) return false;
    const current = attachmentsRef.current || [];
    const next = [...current];
    const accepted = [];
    let error = '';
    for (const file of files) {
      if (next.length + accepted.length >= MAX_ATTACHMENTS) {
        error = `A message can include up to ${MAX_ATTACHMENTS} files.`;
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        error = `${file.name} is larger than the 2 GB per-file limit.`;
        continue;
      }
      const queuedBytes = [...next, ...accepted].reduce((total, item) => total + Number(item.size || 0), 0);
      if (queuedBytes + file.size > MAX_MESSAGE_BYTES) {
        error = 'Attachments can total up to 2 GB per message.';
        break;
      }
      accepted.push(file);
    }
    if (accepted.length) {
      const updated = [...current, ...accepted];
      attachmentsRef.current = updated;
      onAttachmentsChange(updated);
    }
    setAttachmentError(error);
    return accepted.length > 0;
  };

  useEffect(() => {
    if (disabled || !onAttachmentsChange) return undefined;
    const onPaste = (event) => {
      const target = event.target;
      if (isTypingField(target) && target !== textareaRef.current) return;
      const files = filesFromDataTransfer(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      appendFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [disabled, onAttachmentsChange]);

  const pollReady = normalizePoll(poll);
  const canSend = Boolean(draft.trim() || attachments.length || recording || pollReady) && !disabled && !isSending;
  const mentionMatches = mention?.matches || [];
  const activeMention = mentionMatches[Math.min(mentionIndex, Math.max(mentionMatches.length - 1, 0))] || mentionMatches[0];

  const syncMention = (text, cursor) => {
    const next = mentionQueryAt(text, cursor, mentionUsersRef.current);
    const resolved = next && next.start !== skipMentionAt.current ? next : null;
    setMention((current) => (sameMention(current, resolved) ? current : resolved));
    if (!resolved) return;
    setMentionIndex((index) => (sameMention(mention, resolved) ? index : 0));
  };

  const addFiles = (event) => {
    const selectedFiles = Array.from(event.target.files || []);
    event.target.value = '';
    appendFiles(selectedFiles);
  };

  const onDragOver = (event) => {
    if (disabled || !onAttachmentsChange) return;
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (event) => {
    if (disabled || !onAttachmentsChange) return;
    const files = filesFromDataTransfer(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    appendFiles(files);
  };

  const applyMention = (user) => {
    const node = textareaRef.current;
    if (!user?.username || !mention || !node) return;
    const next = insertMention(draft, mention.start, node.selectionStart, user.username);
    skipMentionAt.current = -1;
    setMention(null);
    setMentionIndex(0);
    onDraftChange(next.text.slice(0, maxLength));
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
  };

  const applyCommand = (command) => {
    const text = `/${command.name} `;
    onDraftChange(text);
    setCommandIndex(0);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      node?.focus();
      node?.setSelectionRange(text.length, text.length);
      fitTextarea(node);
    });
  };

  const onKeyDown = (event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (commandOptions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCommandIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + commandOptions.length) % commandOptions.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        applyCommand(commandOptions[activeCommandIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setCommandDismissed(draft);
        return;
      }
    }
    if (mentionMatches.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionMatches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex((index) => (index - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        skipMentionAt.current = mention.start;
        setMention(null);
        setMentionIndex(0);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        applyMention(activeMention);
        return;
      }
    }
    if (event.key === 'Escape' && recordingRef.current) {
      event.preventDefault();
      stopSession(false);
      return;
    }
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault();
      closeComposerMenu();
      menuTriggerRef.current?.focus();
      return;
    }
    if (event.key === 'Escape' && replyTo && onClearReply) {
      event.preventDefault();
      onClearReply();
      return;
    }
    if (event.key === 'Escape' && poll && onPollChange) {
      event.preventDefault();
      onPollChange(null);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (disabled || isSending || submitLock.current) return;
    submitLock.current = true;
    try {
      if (poll) {
        if (!pollReady) {
          setPollError('Polls need 2–10 options.');
          return;
        }
        setPollError('');
        await onSubmit(event, { attachments: [], poll: pollReady });
        return;
      }
      const voice = recordingRef.current ? await stopSession(true) : null;
      if (voice && voice.size < 800) {
        setRecordError('Hold the mic a bit longer, then send.');
        return;
      }
      const files = voice ? [...attachments, voice] : attachments;
      if (!draft.trim() && !files.length) return;
      await onSubmit(event, { attachments: files });
    } finally {
      window.requestAnimationFrame(() => fitTextarea(textareaRef.current));
      submitLock.current = false;
    }
  };

  const chooseFiles = () => {
    if (disabled || recording || poll) return;
    closeComposerMenu();
    fileInputRef.current?.click();
  };

  const togglePoll = () => {
    if (!onPollChange || disabled || recording || isSending) return;
    closeComposerMenu();
    if (poll) onPollChange(null);
    else {
      if (recordingRef.current) stopSession(false);
      onAttachmentsChange?.(() => []);
      onPollChange(emptyPoll());
    }
  };
  const toggleGifs = () => { if (disabled || recording || poll) return; closeComposerMenu(); setGifOpen((open) => !open); };

  const handlePollChange = (next) => {
    setPollError('');
    onPollChange?.(next);
  };

  return (
    <Glass
      className={`dm-composer${recording ? ' is-recording' : ''}`}
      style={{ display: 'flex', '--dm-composer-opacity': `${24 + glassFrost * 0.52}%` }}
      radius={26}
      optics={composerGlassOptics}
    >
    <form className={`dm-composer-form${recording ? ' is-recording' : ''}`} onSubmit={handleSubmit} onBlur={onBlur} onDragOver={onDragOver} onDrop={onDrop}>
      {replyTo ? (
        <div className="dm-reply-bar">
          <span>Replying to <strong>{replyTo.author?.username || replyTo.sender?.username || replyTo.username || 'message'}</strong></span>
          <button type="button" onClick={onClearReply} aria-label="Cancel reply" title="Cancel reply"><CloseIcon /></button>
        </div>
      ) : null}
      {poll ? <PollBuilder poll={poll} onChange={handlePollChange} error={pollError} disabled={disabled || isSending} /> : null}
      <input ref={fileInputRef} className="dm-file-input" type="file" multiple onChange={addFiles} disabled={disabled || Boolean(poll)} />
      {attachments.length ? (
        <div className="dm-selected-files">
          {attachments.map((file, index) => (
            <PendingFile
              key={`${file.name}-${file.lastModified}-${index}`}
              file={file}
              onRemove={() => onAttachmentsChange((current) => current.filter((_, fileIndex) => fileIndex !== index))}
            />
          ))}
        </div>
      ) : null}
      {recordError ? <p className="dm-voice-error" role="alert">{recordError}</p> : null}
      {attachmentError ? <p className="dm-voice-error" role="alert">{attachmentError}</p> : null}
      {gifOpen ? <GifPicker onPick={async (gif) => {
        setGifOpen(false);
        setAttachmentError('Downloading GIF…');
        try {
          const response = await fetch(`/api/v1/gifs/download?id=${encodeURIComponent(gif.id)}`, { credentials: 'same-origin' });
          if (!response.ok) throw new Error('download failed');
          const blob = await response.blob();
          appendFiles([new File([blob], `giphy-${gif.id}.gif`, { type: 'image/gif', lastModified: Date.now() })]);
          setAttachmentError('');
        } catch { setAttachmentError('Could not attach that GIF.'); }
      }} /> : null}
      {typingText ? <div className="dm-composer-typing" aria-live="polite"><span className="dm-typing-dots" aria-hidden="true"><i /><i /><i /></span>{typingText}</div> : null}
      <div className="dm-composer-main">
        <span className="dm-composer-menu-wrap" ref={menuRef}>
          <Liquid className={`dm-composer-liquid-surface${menuOpen ? ' is-open' : ''}`} blur={5} contrast={24} fill={menuMounted ? 'var(--page-background)' : 'transparent'} filterPadding={24}>
            <Liquid.Item className="dm-composer-liquid-trigger" radius={20}>
              <button
                ref={menuTriggerRef}
                className={`dm-attach-button${menuOpen ? ' is-open' : ''}`}
                type="button"
                onClick={toggleComposerMenu}
                disabled={disabled || recording}
                aria-label="Add"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Add"
              >
                <PlusIcon />
              </button>
            </Liquid.Item>
            {menuMounted ? (
              <div
                className={`dm-composer-liquid-actions${menuOpen ? ' is-open' : ''}`}
                role="menu"
                aria-label="Add to message"
                aria-hidden={!menuOpen}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                  const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)')];
                  if (!items.length) return;
                  event.preventDefault();
                  const index = items.indexOf(document.activeElement);
                  items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
                }}
              >
                <Liquid.Item className="dm-composer-liquid-item" x={menuOpen ? 0 : -70} y={menuOpen ? -48 : 0} scale={menuOpen ? 1 : 0} transition={reduceMotion ? { duration: 0 } : { duration: 300, ease: 'cubic-bezier(0.22,1,0.36,1)' }}>
                  <button className="dm-composer-menu-item" type="button" role="menuitem" onClick={chooseFiles} disabled={!menuOpen || disabled || recording || Boolean(poll)} tabIndex={menuOpen ? 0 : -1}>
                    <AttachIcon />
                    <span>Upload a file</span>
                  </button>
                </Liquid.Item>
                <Liquid.Item className="dm-composer-liquid-item" x={menuOpen ? 0 : -70} y={menuOpen ? -86 : 0} scale={menuOpen ? 1 : 0} delay={reduceMotion ? 0 : 24} transition={reduceMotion ? { duration: 0 } : { duration: 300, ease: 'cubic-bezier(0.22,1,0.36,1)' }}>
                  <button className="dm-composer-menu-item" type="button" role="menuitem" onClick={toggleGifs} disabled={!menuOpen || disabled || recording || Boolean(poll)} tabIndex={menuOpen ? 0 : -1}><span aria-hidden="true">GIF</span><span>GIFs</span></button>
                </Liquid.Item>
                {onPollChange ? (
                  <Liquid.Item className="dm-composer-liquid-item" x={menuOpen ? 0 : -70} y={menuOpen ? -124 : 0} scale={menuOpen ? 1 : 0} delay={reduceMotion ? 0 : 48} transition={reduceMotion ? { duration: 0 } : { duration: 300, ease: 'cubic-bezier(0.22,1,0.36,1)' }}>
                    <button className={`dm-composer-menu-item${poll ? ' is-active' : ''}`} type="button" role="menuitem" onClick={togglePoll} disabled={!menuOpen || disabled || recording || isSending} tabIndex={menuOpen ? 0 : -1} aria-pressed={Boolean(poll)}>
                      <PollIcon />
                      <span>Polls</span>
                    </button>
                  </Liquid.Item>
                ) : null}
              </div>
            ) : null}
          </Liquid>
        </span>
        {recording ? (
          <VoiceLive analyser={analyser} elapsed={elapsed} />
        ) : (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              setCommandDismissed(null);
              setCommandIndex(0);
              setCommandCaret(event.target.selectionStart);
              skipMentionAt.current = -1;
              syncMention(event.target.value, event.target.selectionStart);
              onDraftChange(event.target.value);
              fitTextarea(event.target);
            }}
            onKeyDown={onKeyDown}
            onSelect={(event) => setCommandCaret(event.target.selectionStart)}
            aria-controls={commandOptions.length ? commandListId : undefined}
            aria-expanded={commandBots.length ? Boolean(commandOptions.length) : undefined}
            aria-autocomplete={commandBots.length ? 'list' : undefined}
            aria-activedescendant={commandOptions.length ? `${commandListId}-${activeCommandIndex}` : undefined}
            placeholder={poll ? 'Add a comment (optional)' : placeholder}
            maxLength={maxLength}
            rows="1"
            disabled={disabled}
          />
        )}
        {canRecord ? (
          <button
            className={`dm-mic-button${recording ? ' is-recording' : ''}`}
            type="button"
            onClick={toggleRecording}
            disabled={disabled || isSending || Boolean(poll)}
            aria-label={recording ? 'Cancel voice message' : 'Record voice message'}
            aria-pressed={recording}
            title={recording ? 'Cancel recording' : 'Voice message'}
          >
            {recording ? <CloseIcon /> : <MicIcon />}
          </button>
        ) : null}
        <SendButton disabled={!canSend} isSending={isSending} />
      </div>
      {commandOptions.length ? (
        <div className="dm-command-picker" id={commandListId} role="listbox" aria-label="Bot commands">
          {commandOptions.map((command, index) => (
            <div key={command.key}>
              {index === 0 || commandOptions[index - 1].bot.id !== command.bot.id ? (
                <div className="dm-command-bot"><Avatar user={{ ...command.bot, username: command.bot.name }} interactive={false} /><strong>{command.bot.name}</strong><small>BOT</small></div>
              ) : null}
              <button type="button" role="option" id={`${commandListId}-${index}`} aria-selected={index === activeCommandIndex}
                className={`dm-command-option${index === activeCommandIndex ? ' is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()} onClick={() => applyCommand(command)}>
                <span className="dm-command-mark" aria-hidden="true">/</span>
                <span><strong>/{command.name} {command.usage ? <em>{command.usage}</em> : null}</strong><small>{command.description}</small></span>
              </button>
            </div>
          ))}
        </div>
      ) : mentionMatches.length ? (
        <div className="dm-mention-picker" role="listbox" aria-label="Mention someone">
          {mentionMatches.map((user) => (
            <button
              className={`dm-mention-option${activeMention?.id === user.id ? ' is-active' : ''}`}
              type="button"
              key={user.id || user.username}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyMention(user)}
            >
              {isEveryoneMention(user) ? <span className="dm-mention-everyone-mark" aria-hidden="true"><MegaphoneIcon /></span> : <Avatar user={user} interactive={false} />}
              <span>
                <strong>{isEveryoneMention(user) ? 'everyone' : user.username}</strong>
                {user.roleName ? <small>{user.roleName}</small> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </form>
    </Glass>
  );
}

export const IsolatedMessageComposer = memo(function IsolatedMessageComposer({ resetKey, onSend, onTyping, allowPolls = false, draftStore, draftKey, ...props }) {
  const [draft, setDraftState] = useState(() => draftStore?.get(draftKey)?.draft || '');
  const [attachments, setAttachmentsState] = useState(() => draftStore?.get(draftKey)?.attachments || []);
  const [poll, setPoll] = useState(null);
  const draftRef = useRef(draft);
  const attachmentsRef = useRef(attachments);
  const rememberDraft = useCallback(() => {
    if (!draftStore || !draftKey) return;
    draftStore.delete(draftKey);
    if (draftRef.current || attachmentsRef.current.length) draftStore.set(draftKey, { draft: draftRef.current, attachments: attachmentsRef.current });
    while (draftStore.size > 10) draftStore.delete(draftStore.keys().next().value);
  }, [draftStore, draftKey]);
  const setDraft = useCallback(value => {
    const next = typeof value === 'function' ? value(draftRef.current) : value;
    draftRef.current = next;
    setDraftState(next);
    rememberDraft();
  }, [rememberDraft]);
  const setAttachments = useCallback(value => {
    const next = typeof value === 'function' ? value(attachmentsRef.current) : value;
    attachmentsRef.current = next;
    setAttachmentsState(next);
    rememberDraft();
  }, [rememberDraft]);
  useEffect(() => {
    if (draftStore) return;
    setDraft('');
    setAttachments([]);
    setPoll(null);
  }, [resetKey, draftStore, setDraft, setAttachments]);
  useEffect(() => {
    onTyping?.(Boolean(draft.trim()));
    if (!draft.trim()) return undefined;
    const timer = window.setTimeout(() => onTyping?.(false), 4500);
    return () => window.clearTimeout(timer);
  }, [draft, onTyping]);
  useEffect(() => () => onTyping?.(false), [onTyping]);
  return (
    <MessageComposer
      key={resetKey}
      {...props}
      draft={draft}
      onDraftChange={setDraft}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      poll={allowPolls ? poll : null}
      onPollChange={allowPolls ? setPoll : undefined}
      onSubmit={(event, extra) => onSend(event, { draft, attachments: extra?.attachments ?? attachments, poll: extra?.poll ?? poll, setDraft, setAttachments, setPoll })}
    />
  );
});
