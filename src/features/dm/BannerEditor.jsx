import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { updateAccountBanner } from '../../app/dmApi';
import { schoolBadgeStyle } from '../../app/laredoSchools';
import { ServerInvitePreview } from '../community/ServerInviteCard';
import { BANNER_HEX, bannerStyle, normalizeHex, profileThemeStyle } from './banner';
import { formatJoinedDate } from './formatters';
import { CopyIcon, DiscordIcon, UserIcon } from './icons';
import DisplayName from './DisplayName';
import CustomBadges from './CustomBadges';

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
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const OUT_W = 1200;
const OUT_H = 300;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function clampPan(x, y, zoom, imgW, imgH, frameW, frameH) {
  const cover = Math.max(frameW / imgW, frameH / imgH);
  const scaledW = imgW * cover * zoom;
  const scaledH = imgH * cover * zoom;
  const maxX = Math.max(0, (scaledW - frameW) / 2);
  const maxY = Math.max(0, (scaledH - frameH) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

function coverImageStyle(imgW, imgH, frameW, frameH, offset, zoom) {
  const cover = Math.max(frameW / imgW, frameH / imgH) * zoom;
  return {
    width: `${imgW * cover}px`,
    height: `${imgH * cover}px`,
    transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
  };
}

function exportBanner(image, offset, zoom, frameW, frameH) {
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Could not save this photo.'));
  ctx.fillStyle = '#101a23';
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const k = OUT_W / frameW;
  const cover = Math.max(frameW / image.naturalWidth, frameH / image.naturalHeight) * zoom;
  ctx.translate(OUT_W / 2, OUT_H / 2);
  ctx.translate(offset.x * k, offset.y * k);
  ctx.scale(cover * k, cover * k);
  ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not save this photo.'));
        return;
      }
      resolve(new File([blob], 'banner.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  });
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

function ProfileLivePreview({ account, banner, profileBackground }) {
  const backgroundStyle = profileThemeStyle(profileBackground) || undefined;
  const bannerPreviewStyle = bannerStyle(banner) || undefined;
  const programs = account?.programs || [];
  const visiblePrograms = programs.filter((program) => program.id === 'magnet' || program.id === 'laredo-college');
  const presence = account?.presenceHidden
    ? 'offline'
    : account?.presence === 'online' || account?.presence === 'idle'
      ? account.presence
      : 'offline';
  const statusText = account?.presenceHidden
    ? 'Invisible'
    : presence === 'online'
      ? 'Online'
      : presence === 'idle'
        ? 'Idle'
        : 'Offline';
  const inLaredoCollege = programs.some((item) => item.id === 'laredo-college');
  const inMagnet = programs.some((item) => item.id === 'magnet');
  const joined = formatJoinedDate(account?.createdAt);
  const handle = account?.username ? `@${account.username}` : '';
  const rootClass = `dm-banner-live-card dm-contact-profile${backgroundStyle ? ' has-profile-background' : ''}${inLaredoCollege ? ' has-lc-ribbon' : ''}${inMagnet ? ' has-magnet-ribbon' : ''}`;

  return (
    <aside className="dm-banner-live-preview" aria-label="Live profile preview">
      <p className="dm-banner-live-label">Live preview</p>
      <div className={rootClass} style={backgroundStyle}>
        {inMagnet ? (
          <div className="dm-profile-ribbon is-magnet" aria-hidden="true"><span>MAGNET</span></div>
        ) : null}
        {inLaredoCollege ? (
          <div className="dm-profile-ribbon is-lc" aria-hidden="true"><span>LC</span></div>
        ) : null}
        <div className="dm-contact-banner" style={bannerPreviewStyle} />
        <div className={`dm-contact-avatar-wrap${presence === 'offline' ? ' is-offline' : ''}`}>
          <span className={`dm-avatar dm-avatar-large is-${presence}`} aria-hidden="true">
            {account?.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <UserIcon size={46} />}
          </span>
        </div>
        <div className="dm-contact-identity">
          <h2><DisplayName user={account} className="dm-profile-display-name" /></h2>
          <p className={`dm-contact-status is-${presence}`}>{statusText}</p>
          {handle || account?.discordUsername ? (
            <div className="dm-contact-handles">
              {handle ? (
                <span className="dm-contact-handle">
                  {handle}
                  <CopyIcon />
                </span>
              ) : null}
              {account?.discordUsername ? (
                <span className="dm-contact-handle is-discord">
                  <DiscordIcon />
                  {account.discordUsername}
                  <CopyIcon />
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="dm-contact-chips">
            {(account?.badges || []).map((badge) => (
              <span className={`dm-profile-badge is-${badge.id}`} key={badge.id}>{badge.label}</span>
            ))}
            <CustomBadges badges={account?.customBadges} />
            {account?.schoolLabel ? (
              <span className="dm-contact-chip is-school" key="school" style={schoolBadgeStyle(account.schoolHex) || undefined}>{account.schoolLabel}</span>
            ) : null}
            {visiblePrograms.map((program) => (
              <span className="dm-contact-chip is-program" key={program.id || program.label} style={schoolBadgeStyle(program.hex) || undefined}>{program.id === 'laredo-college' ? 'Early College' : program.label}</span>
            ))}
          </div>
        </div>
        <div className="dm-contact-body">
          <div className="dm-contact-section">
            <h3>About me</h3>
            <p>{account?.bio || 'No bio yet.'}</p>
          </div>
          {joined ? (
            <div className="dm-contact-section">
              <h3>Member since</h3>
              <p>{joined}</p>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

export default function BannerEditor({
  banner,
  onClose,
  onSaved,
  saveBanner = updateAccountBanner,
  title = 'Edit banner',
  lead = 'This strip sits at the top of your profile card. Pick a color, a two-color fade, or a photo.',
  saveLabel = 'Save banner',
  invitePreview = null,
  allowImage = true,
  preserveAnimatedGif = false,
  previewAccount = null,
  previewTarget = 'banner',
}) {
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const fileRef = useRef(null);
  const [kind, setKind] = useState(() => {
    if (allowImage && banner?.kind === 'image') return 'image';
    return banner?.kind === 'solid' ? 'solid' : 'gradient';
  });
  const [color, setColor] = useState(normalizeHex(banner?.color, '#249cff'));
  const [from, setFrom] = useState(normalizeHex(banner?.from, '#249cff'));
  const [to, setTo] = useState(normalizeHex(banner?.to, '#101a23'));
  const [angle, setAngle] = useState(Math.min(360, Math.max(0, Math.round(Number(banner?.angle) || 135))));
  const [existingUrl] = useState(banner?.kind === 'image' ? banner.imageUrl : '');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceFile, setSourceFile] = useState(null);
  const [bitmap, setBitmap] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [frame, setFrame] = useState({ w: 480, h: 120 });
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const animatedGif = preserveAnimatedGif && sourceFile?.type === 'image/gif';

  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || saving) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, saving]);

  useEffect(() => {
    if (!sourceUrl) {
      setBitmap(null);
      return undefined;
    }
    const image = new Image();
    image.onload = () => {
      setBitmap(image);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
    image.onerror = () => setError('Could not read this photo.');
    image.src = sourceUrl;
    return () => { image.onload = null; image.onerror = null; };
  }, [sourceUrl]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return undefined;
    const sync = () => {
      const w = node.clientWidth || 480;
      setFrame({ w, h: Math.max(72, Math.round(w / 4)) });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    sync();
    return () => observer.disconnect();
  }, [kind, sourceUrl]);

  useEffect(() => {
    if (!bitmap) return;
    setOffset((current) => clampPan(current.x, current.y, zoom, bitmap.naturalWidth, bitmap.naturalHeight, frame.w, frame.h));
  }, [bitmap, zoom, frame.w, frame.h]);

  useEffect(() => {
    const node = stageRef.current;
    if (animatedGif || !node || !bitmap) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + (event.deltaY > 0 ? -0.08 : 0.08))));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [bitmap, animatedGif]);

  const draft = kind === 'solid'
    ? { kind: 'solid', color }
    : kind === 'gradient'
      ? { kind: 'gradient', from, to, angle }
      : sourceUrl && bitmap
        ? null
        : existingUrl
          ? { kind: 'image', imageUrl: existingUrl }
          : null;
  const previewStyle = sourceUrl && bitmap
    ? animatedGif
      ? { backgroundColor: '#101a23', backgroundImage: `url(${sourceUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
      : { backgroundColor: '#101a23', overflow: 'hidden' }
    : bannerStyle(draft);

  const takeFile = (file) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024 || (file.type && !TYPES.has(file.type))) {
      setError('Choose a JPG, PNG, WebP, or GIF up to 8 MB.');
      return;
    }
    setError('');
    setKind('image');
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setSourceFile(file);
    setSourceUrl(URL.createObjectURL(file));
  };

  const pickFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    takeFile(file);
  };

  const onPointerDown = (event) => {
    if (saving || animatedGif || event.button || !bitmap) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };
  const onPointerMove = (event) => {
    if (!dragRef.current || !bitmap) return;
    setOffset(clampPan(
      dragRef.current.ox + (event.clientX - dragRef.current.x),
      dragRef.current.oy + (event.clientY - dragRef.current.y),
      zoom,
      bitmap.naturalWidth,
      bitmap.naturalHeight,
      frame.w,
      frame.h,
    ));
  };
  const onPointerUp = (event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      let result;
      if (kind === 'image' && animatedGif && sourceFile) {
        result = await saveBanner(sourceFile);
      } else if (kind === 'image' && bitmap && sourceUrl) {
        const file = await exportBanner(bitmap, offset, zoom, frame.w, frame.h);
        result = await saveBanner(file);
      } else if (kind === 'image' && existingUrl) {
        result = await saveBanner({ kind: 'image', imageUrl: existingUrl });
      } else if (kind === 'solid') {
        result = await saveBanner({ kind: 'solid', color });
      } else if (kind === 'gradient') {
        result = await saveBanner({ kind: 'gradient', from, to, angle });
      } else {
        setError(allowImage ? 'Pick a color, gradient, or photo first.' : 'Pick a solid color or gradient first.');
        setSaving(false);
        return;
      }
      onSaved(result);
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
      const result = await saveBanner({ kind: 'none' });
      onSaved(result);
      onClose();
    } catch (next) {
      setError(next.message);
    } finally {
      setSaving(false);
    }
  };

  const cropActive = kind === 'image' && sourceUrl && bitmap && !animatedGif;
  const pendingImage = kind === 'image' && sourceUrl && bitmap
    ? { kind: 'image', imageUrl: sourceUrl }
    : null;
  const liveBanner = pendingImage || draft;
  const liveProfileBackground = previewTarget === 'profileBackground' ? draft : previewAccount?.profileBackground || null;
  const previewBanner = previewTarget === 'banner' ? liveBanner : previewAccount?.banner || null;
  const liveServer = invitePreview
    ? { ...invitePreview, banner: liveBanner || invitePreview.banner || null }
    : null;

  return createPortal(
    <div className="dm-banner-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className={`dm-banner-editor${previewAccount ? ' has-live-preview' : ''}`} role="dialog" aria-modal="true" aria-labelledby="banner-title" aria-busy={saving}>
        <div className="dm-banner-editor-form">
          <h2 id="banner-title">{title}</h2>
          <p className="dm-banner-lead">{lead}</p>
          {liveServer ? (
          <div className="dm-banner-invite">
            <p className="dm-banner-hint">Live invite preview</p>
            <ServerInvitePreview server={liveServer} goDisabled goLabel="Go to Server" />
          </div>
          ) : cropActive ? null : (
            <div className="dm-banner-preview" style={previewStyle} />
          )}
          <div className={`dm-banner-tabs${allowImage ? '' : ' is-color-only'}`} role="tablist" aria-label={allowImage ? 'Banner type' : 'Profile background type'}>
          <button type="button" className={kind === 'solid' ? 'is-active' : ''} aria-pressed={kind === 'solid'} onClick={() => setKind('solid')}>Solid color</button>
          <button type="button" className={kind === 'gradient' ? 'is-active' : ''} aria-pressed={kind === 'gradient'} onClick={() => setKind('gradient')}>Gradient</button>
          {allowImage ? <button type="button" className={kind === 'image' ? 'is-active' : ''} aria-pressed={kind === 'image'} onClick={() => setKind('image')}>Image</button> : null}
          </div>
          {kind === 'solid' ? (
          <div className="dm-banner-panel">
            <ColorField label="Color" value={color} onChange={setColor} />
            <div className="dm-banner-swatches" role="group" aria-label="Preset colors">
              {SOLID_COLORS.map((item) => (
                <button key={item} type="button" className={item === color ? 'is-active' : ''} style={{ background: item }} aria-label={item} onClick={() => setColor(item)} />
              ))}
            </div>
          </div>
          ) : null}
          {kind === 'gradient' ? (
          <div className="dm-banner-panel">
            <div className="dm-banner-colors">
              <ColorField label="Start" value={from} onChange={setFrom} />
              <ColorField label="End" value={to} onChange={setTo} />
            </div>
            <p className="dm-banner-hint">Direction</p>
            <div className="dm-banner-dirs">
              {DIRECTIONS.map((item) => (
                <button key={item.angle} type="button" className={angle === item.angle ? 'is-active' : ''} onClick={() => setAngle(item.angle)}>{item.label}</button>
              ))}
            </div>
            <label className="dm-banner-angle">
              <span>Angle {angle}°</span>
              <input type="range" min="0" max="360" value={angle} onChange={(event) => setAngle(Number(event.target.value))} />
            </label>
            <div className="dm-banner-swatches" role="group" aria-label="Preset gradients">
              {GRADIENTS.map((item) => (
                <button
                  key={`${item.from}-${item.to}-${item.angle}`}
                  type="button"
                  className={from === item.from && to === item.to && angle === item.angle ? 'is-active' : ''}
                  style={{ background: `linear-gradient(${item.angle}deg, ${item.from}, ${item.to})` }}
                  aria-label="Gradient preset"
                  onClick={() => { setFrom(item.from); setTo(item.to); setAngle(item.angle); }}
                />
              ))}
            </div>
          </div>
          ) : null}
          {kind === 'image' ? (
          <div className="dm-banner-panel">
            <p className="dm-banner-hint">{animatedGif ? 'Animated GIFs stay animated. Glean saves the original GIF without flattening it into a still image.' : sourceUrl ? 'Drag to reposition. Scroll or use the slider to zoom, then save.' : 'Choose a photo, then crop it to the banner shape.'}</p>
            {cropActive ? (
              <div
                ref={stageRef}
                className={`dm-banner-stage${dragging ? ' is-dragging' : ''}`}
                style={{ height: frame.h }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <img alt="" draggable="false" style={coverImageStyle(bitmap.naturalWidth, bitmap.naturalHeight, frame.w, frame.h, offset, zoom)} src={sourceUrl} />
              </div>
            ) : animatedGif ? (
              <div className="dm-banner-preview is-animated-gif" style={previewStyle} />
            ) : existingUrl ? (
              <div className="dm-banner-preview" style={bannerStyle({ kind: 'image', imageUrl: existingUrl })} />
            ) : (
              <div
                ref={stageRef}
                className="dm-banner-stage is-empty"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  takeFile(event.dataTransfer.files?.[0]);
                }}
              >
                Drop a photo here or choose one below.
              </div>
            )}
            {cropActive ? (
              <label className="dm-banner-angle">
                <span>Zoom {zoom.toFixed(2)}x</span>
                <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
              </label>
            ) : null}
            <div className="dm-banner-file-row">
              <button type="button" className="dm-small-action" onClick={() => fileRef.current?.click()}>{sourceUrl || existingUrl ? 'Replace photo' : 'Choose photo'}</button>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={pickFile} />
            </div>
          </div>
          ) : null}
          {error ? <p className="dm-crop-error" role="alert">{error}</p> : null}
          <div className="dm-crop-actions">
          <button type="button" onClick={reset} disabled={saving}>Reset</button>
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="dm-crop-save" onClick={save} disabled={saving}>{saving ? 'Saving…' : animatedGif ? 'Save animated GIF' : saveLabel}</button>
          </div>
        </div>
        {previewAccount ? <ProfileLivePreview account={previewAccount} banner={previewBanner} profileBackground={liveProfileBackground} /> : null}
      </section>
    </div>,
    document.body,
  );
}
