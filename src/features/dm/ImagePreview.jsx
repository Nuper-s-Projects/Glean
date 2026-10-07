import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import GleanButton from './GleanButton';
import { CloseIcon, DownloadIcon, MinusIcon, PlusIcon } from './icons';

const ImagePreviewContext = createContext({ open() {}, close() {} });
const MIN_SCALE = 1;
const MAX_SCALE = 8;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pointOf(event) {
  return { x: event.clientX, y: event.clientY };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function useImagePreview() {
  return useContext(ImagePreviewContext);
}

function downloadName(item, src) {
  const raw = String(item?.name || item?.alt || '').trim().replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 80);
  if (raw && /\.[a-z0-9]{2,8}$/i.test(raw)) return raw;
  try {
    const path = new URL(src, window.location.origin).pathname.split('/').pop() || '';
    if (path && /\.[a-z0-9]{2,8}$/i.test(path) && !path.startsWith('blob')) return path.slice(0, 80);
  } catch { /* ignore */ }
  return raw ? `${raw.replace(/\.[^.]+$/, '') || 'glean-image'}.jpg` : 'glean-image.jpg';
}

function clickDownload(href, filename) {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noreferrer';
  link.click();
}

async function savePreview(item) {
  const src = String(item?.src || '');
  const filename = downloadName(item, src);
  if (!src) return;
  if (src.startsWith('blob:')) {
    clickDownload(src, filename);
    return;
  }
  const same = src.startsWith('/') || src.startsWith(window.location.origin);
  const response = await fetch(src, { credentials: same ? 'include' : 'omit' });
  if (!response.ok) throw new Error('Download failed.');
  const blob = await response.blob();
  const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] }) && window.matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  clickDownload(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function ImagePreviewDialog({ item, onClose }) {
  const stageRef = useRef(null);
  const scaleRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const pointersRef = useRef(new Map());
  const pinchRef = useRef(null);
  const dragRef = useRef(null);
  const movedRef = useRef(false);
  const lastTapRef = useRef(0);
  const swipeRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [saving, setSaving] = useState(false);

  const commit = useCallback((nextScale, nextPan) => {
    const next = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const panNext = next <= 1.01 ? { x: 0, y: 0 } : nextPan;
    scaleRef.current = next;
    panRef.current = panNext;
    setScale(next);
    setPan(panNext);
  }, []);

  const zoomBy = useCallback((factor) => {
    commit(scaleRef.current * factor, panRef.current);
  }, [commit]);

  const download = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await savePreview(item);
    } catch {
      clickDownload(item.src, downloadName(item, item.src));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      htmlTouch: html.style.touchAction,
    };
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    html.style.touchAction = 'none';
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomBy(1.25);
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomBy(1 / 1.25);
      }
      if (event.key === '0') commit(1, { x: 0, y: 0 });
    };
    window.addEventListener('keydown', onKey);
    const stage = stageRef.current;
    const onWheel = (event) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    stage?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      html.style.overflow = prev.htmlOverflow;
      body.style.overflow = prev.bodyOverflow;
      html.style.touchAction = prev.htmlTouch;
      window.removeEventListener('keydown', onKey);
      stage?.removeEventListener('wheel', onWheel);
    };
  }, [commit, onClose, zoomBy]);

  const onPointerDown = (event) => {
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    pointersRef.current.set(event.pointerId, pointOf(event));
    movedRef.current = false;
    swipeRef.current = scaleRef.current <= 1.01 ? { y: event.clientY } : null;
    const points = [...pointersRef.current.values()];
    if (points.length >= 2) {
      dragRef.current = null;
      pinchRef.current = {
        dist: distance(points[0], points[1]),
        scale: scaleRef.current,
        mid: midpoint(points[0], points[1]),
        pan: { ...panRef.current },
      };
      return;
    }
    if (scaleRef.current > 1.01) {
      dragRef.current = { x: event.clientX - panRef.current.x, y: event.clientY - panRef.current.y };
      setPanning(true);
    }
  };

  const onPointerMove = (event) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, pointOf(event));
    const points = [...pointersRef.current.values()];
    if (points.length >= 2) {
      if (!pinchRef.current) {
        pinchRef.current = {
          dist: distance(points[0], points[1]),
          scale: scaleRef.current,
          mid: midpoint(points[0], points[1]),
          pan: { ...panRef.current },
        };
      }
      const nextMid = midpoint(points[0], points[1]);
      const ratio = distance(points[0], points[1]) / Math.max(1, pinchRef.current.dist);
      movedRef.current = true;
      commit(pinchRef.current.scale * ratio, {
        x: pinchRef.current.pan.x + (nextMid.x - pinchRef.current.mid.x),
        y: pinchRef.current.pan.y + (nextMid.y - pinchRef.current.mid.y),
      });
      return;
    }
    if (swipeRef.current && scaleRef.current <= 1.01 && event.clientY - swipeRef.current.y > 96) {
      onClose();
      return;
    }
    if (!dragRef.current) return;
    const next = { x: event.clientX - dragRef.current.x, y: event.clientY - dragRef.current.y };
    if (Math.hypot(next.x - panRef.current.x, next.y - panRef.current.y) > 3) movedRef.current = true;
    commit(scaleRef.current, next);
  };

  const onPointerUp = (event) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) {
      dragRef.current = null;
      swipeRef.current = null;
      setPanning(false);
      if (!movedRef.current) {
        const now = Date.now();
        if (now - lastTapRef.current < 280) {
          lastTapRef.current = 0;
          if (scaleRef.current > 1.05) commit(1, { x: 0, y: 0 });
          else commit(2.5, panRef.current);
        } else {
          lastTapRef.current = now;
          if (event.target === event.currentTarget && scaleRef.current <= 1.01) onClose();
        }
      }
    }
  };

  return createPortal(
    <div className="dm-image-preview" role="dialog" aria-modal="true" aria-label={item.name || item.alt || 'Image preview'}>
      <div className="dm-image-preview-top">
        <p>{item.name || item.alt || 'Preview'}</p>
        <div className="dm-image-preview-top-actions">
          <GleanButton variant="quiet" type="button" onClick={download} disabled={saving} aria-label="Download image"><DownloadIcon /><span className="dm-image-preview-label">{saving ? 'Saving…' : 'Download'}</span></GleanButton>
          <GleanButton variant="quiet" type="button" onClick={onClose} aria-label="Close preview"><CloseIcon /><span className="dm-image-preview-label">Close</span></GleanButton>
        </div>
      </div>
      <div
        ref={stageRef}
        className={`dm-image-preview-stage${scale > 1.01 ? ' is-zoomed' : ''}${panning ? ' is-panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={item.src}
          alt={item.alt || item.name || ''}
          draggable={false}
          decoding="async"
          fetchPriority="high"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        />
      </div>
      <div className="dm-image-preview-bar">
        <GleanButton variant="quiet" type="button" onClick={() => zoomBy(1 / 1.25)} disabled={scale <= MIN_SCALE} aria-label="Zoom out"><MinusIcon /><span className="dm-image-preview-label">Zoom out</span></GleanButton>
        <span className="dm-image-preview-zoom">{Math.round(scale * 100)}%</span>
        <GleanButton variant="quiet" type="button" onClick={() => zoomBy(1.25)} disabled={scale >= MAX_SCALE} aria-label="Zoom in"><PlusIcon /><span className="dm-image-preview-label">Zoom in</span></GleanButton>
        <GleanButton type="button" onClick={() => commit(1, { x: 0, y: 0 })} disabled={scale <= 1.01} aria-label="Reset zoom">Fit</GleanButton>
      </div>
    </div>,
    document.body,
  );
}

export function ImagePreviewProvider({ children }) {
  const [item, setItem] = useState(null);
  const open = useCallback((next) => {
    if (!next?.src) return;
    setItem({ src: next.src, alt: next.alt || '', name: next.name || next.alt || '' });
  }, []);
  const close = useCallback(() => setItem(null), []);
  return (
    <ImagePreviewContext.Provider value={{ open, close }}>
      {children}
      {item ? <ImagePreviewDialog item={item} onClose={close} /> : null}
    </ImagePreviewContext.Provider>
  );
}
