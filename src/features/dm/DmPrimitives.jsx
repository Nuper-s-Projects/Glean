import { useCallback, useEffect, useRef, useState } from 'react';
import { decryptAttachment } from '../../app/e2ee';
import { usePresence } from '../../app/presence';
import { AttachIcon, UserIcon } from './icons';
import { classifyFileKind, formatFileSize } from './formatters';
import { AudioAttachment, FileDownloadCard, VideoAttachment } from './MediaPlayers';
import { useImagePreview } from './ImagePreview';
import { useUserPopout } from './userPopout';

export function PresenceWrap({ user, className = '', as: Tag = 'div', children, ...props }) {
  const status = usePresence(user?.id, user?.presence || 'offline');
  return <Tag className={`${className}${status === 'offline' ? ' is-offline' : ''}`} {...props}>{children}</Tag>;
}

export function Avatar({ user, username, avatarUrl, large = false, interactive = true, presence: showPresence = false }) {
  const { open } = useUserPopout();
  const profile = user || ((username || avatarUrl) ? { username, avatarUrl } : null);
  const status = usePresence(profile?.id, showPresence ? (profile?.presence || 'offline') : '');
  const pip = showPresence ? status : '';
  const node = (
    <span className={`dm-avatar${large ? ' dm-avatar-large' : ''}${pip ? ` is-${pip}` : ''}`} aria-hidden="true">
      {(profile?.avatarUrl || avatarUrl) ? <img src={profile?.avatarUrl || avatarUrl} alt="" loading={large ? 'eager' : 'lazy'} decoding="async" /> : <UserIcon size={large ? 46 : 20} />}
    </span>
  );
  if (!interactive || !profile) return node;
  return (
    <button
      type="button"
      className="dm-user-avatar"
      onClick={(event) => { event.stopPropagation(); open(profile, event.currentTarget); }}
      aria-label={`View ${profile.username || 'user'}'s profile`}
    >
      {node}
    </button>
  );
}

export function MessageAttachment({ attachment, message, accountId }) {
  const { open } = useImagePreview();
  const [source, setSource] = useState(attachment.encrypted ? null : attachment.url);
  const [state, setState] = useState('idle');
  const objectUrlRef = useRef(null);
  const previewRef = useRef(null);
  const sourceRef = useRef(source);
  const loadLockRef = useRef(false);
  const generationRef = useRef(0);
  const attachmentRef = useRef(attachment);
  const messageRef = useRef(message);
  attachmentRef.current = attachment;
  messageRef.current = message;
  sourceRef.current = source;
  const kind = classifyFileKind(attachment.type, attachment.name);

  const load = useCallback(async () => {
    if (!attachment.encrypted || sourceRef.current || loadLockRef.current) return;
    loadLockRef.current = true;
    const generation = generationRef.current;
    setState('loading');
    try {
      const blob = await decryptAttachment(accountId, attachmentRef.current, messageRef.current);
      if (generation !== generationRef.current) return;
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      sourceRef.current = objectUrl;
      setSource(objectUrl);
      setState('ready');
    } catch {
      if (generation === generationRef.current) setState('error');
    } finally {
      if (generation === generationRef.current) loadLockRef.current = false;
    }
  }, [accountId, attachment.id, attachment.encrypted]);

  useEffect(() => {
    generationRef.current += 1;
    const release = () => {
      generationRef.current += 1;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      sourceRef.current = null;
      loadLockRef.current = false;
    };
    if (!attachment.encrypted) {
      setSource(attachment.url);
      return release;
    }
    setSource(null);
    sourceRef.current = null;
    setState('idle');
    loadLockRef.current = false;
    const shouldPreview = (kind === 'image' && Number(attachment.size || 0) <= 8 * 1024 * 1024)
      || (kind === 'audio' && Number(attachment.size || 0) <= 20 * 1024 * 1024);
    if (!shouldPreview) return release;
    const target = previewRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') {
      load();
      return release;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: '320px 0px' });
    observer.observe(target);
    return () => { observer.disconnect(); release(); };
  }, [attachment.id, attachment.encrypted, attachment.size, attachment.url, load, kind]);

  if (state === 'error') return <button type="button" className="dm-file-attachment dm-attachment-error" onClick={load}><AttachIcon /><span><strong>{attachment.name}</strong><small>Decryption failed · Retry</small></span></button>;
  if (!source && attachment.encrypted) return <button ref={previewRef} type="button" className="dm-file-attachment dm-attachment-loading" onClick={load} disabled={state === 'loading'}><AttachIcon /><span><strong>{attachment.name}</strong><small>{state === 'loading' ? 'Decrypting…' : `Encrypted · ${formatFileSize(attachment.size)}`}</small></span></button>;
  if (kind === 'image') return (
    <button
      type="button"
      className="dm-image-attachment"
      onClick={(event) => {
        event.stopPropagation();
        open({ src: source, alt: attachment.name, name: attachment.name });
      }}
    >
      <img src={source} alt={attachment.name} loading="lazy" decoding="async" />
    </button>
  );
  if (kind === 'video') return <VideoAttachment src={source} name={attachment.name} />;
  if (kind === 'audio') return <AudioAttachment src={source} name={attachment.name} size={attachment.size} />;
  return <FileDownloadCard href={source} name={attachment.name} size={attachment.size} />;
}
