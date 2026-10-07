import { useEffect, useRef, useState } from 'react';

const OUTPUT = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const PREVIEW = 112;

function clampOffset(x, y, zoom, rotation, width, height, circle) {
  const base = circle / Math.min(width, height);
  const scaledW = width * base * zoom;
  const scaledH = height * base * zoom;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const boundW = scaledW * cos + scaledH * sin;
  const boundH = scaledW * sin + scaledH * cos;
  const maxX = Math.max(0, (boundW - circle) / 2);
  const maxY = Math.max(0, (boundH - circle) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

function imageStyle(width, height, offsetX, offsetY, zoom, rotation, circle) {
  const base = circle / Math.min(width, height);
  return {
    width: `${width * base * zoom}px`,
    height: `${height * base * zoom}px`,
    transform: `translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px) rotate(${rotation}deg)`,
  };
}

function exportJpeg(image, { offsetX, offsetY, zoom, rotation, circle }) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT;
  canvas.height = OUTPUT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Could not save this photo.'));
  ctx.fillStyle = '#101a23';
  ctx.fillRect(0, 0, OUTPUT, OUTPUT);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const k = OUTPUT / circle;
  const base = circle / Math.min(width, height);
  ctx.translate(OUTPUT / 2, OUTPUT / 2);
  ctx.translate(offsetX * k, offsetY * k);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(base * zoom * k, base * zoom * k);
  ctx.drawImage(image, -width / 2, -height / 2);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not save this photo.'));
        return;
      }
      resolve(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  });
}

export default function AvatarCropEditor({ imageUrl, sourceFile = null, saving = false, error = '', title = 'Edit photo', onCancel, onSave, onError }) {
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  const onErrorRef = useRef(onError);
  onCancelRef.current = onCancel;
  onErrorRef.current = onError;
  const [bitmap, setBitmap] = useState(null);
  const [stagePx, setStagePx] = useState(320);
  const [zoom, setZoom] = useState(1);
  const [tilt, setTilt] = useState(0);
  const [turn, setTurn] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const animatedGif = Boolean(sourceFile && (sourceFile.type === 'image/gif' || sourceFile.name?.toLowerCase().endsWith('.gif')));
  const width = bitmap?.naturalWidth || 0;
  const height = bitmap?.naturalHeight || 0;
  const circle = Math.max(160, Math.round(stagePx * 0.8125));
  const rotation = turn + tilt;
  const live = useRef({ zoom, tilt, turn, offset, width, height, circle });
  live.current = { zoom, tilt, turn, offset, width, height, circle };

  useEffect(() => {
    setZoom(1);
    setTilt(0);
    setTurn(0);
    setOffset({ x: 0, y: 0 });
    setBitmap(null);
    const image = new Image();
    image.onload = () => setBitmap(image);
    image.onerror = () => {
      onErrorRef.current?.('Could not read this photo.');
      onCancelRef.current();
    };
    image.src = imageUrl;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return undefined;
    const sync = () => setStagePx(node.clientWidth || 320);
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    sync();
    return () => observer.disconnect();
  }, [bitmap, animatedGif]);

  useEffect(() => {
    if (!width || !height) return;
    setOffset((current) => clampOffset(current.x, current.y, zoom, turn + tilt, width, height, circle));
  }, [zoom, turn, tilt, width, height, circle]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const delta = event.deltaY > 0 ? -0.1 : 0.1;
      setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + delta)));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [bitmap]);

  const reset = () => {
    setZoom(1);
    setTilt(0);
    setTurn(0);
    setOffset({ x: 0, y: 0 });
  };

  const onPointerDown = (event) => {
    if (saving || event.button) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };

  const onPointerMove = (event) => {
    if (!dragRef.current || !width) return;
    const rect = stageRef.current?.getBoundingClientRect();
    const scale = rect?.width ? rect.width / stagePx : 1;
    const next = clampOffset(
      dragRef.current.ox + (event.clientX - dragRef.current.x) / scale,
      dragRef.current.oy + (event.clientY - dragRef.current.y) / scale,
      live.current.zoom,
      live.current.turn + live.current.tilt,
      width,
      height,
      circle,
    );
    setOffset(next);
  };

  const onPointerUp = (event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const save = async () => {
    if (!bitmap || saving) return;
    try {
      if (animatedGif) {
        const base = circle / Math.min(width, height);
        const side = Math.max(1, Math.round(Math.min(width, height) / zoom));
        const cropScale = base * zoom;
        const x = Math.max(0, Math.min(width - side, Math.round((width - side) / 2 - offset.x / cropScale)));
        const y = Math.max(0, Math.min(height - side, Math.round((height - side) / 2 - offset.y / cropScale)));
        await onSave(sourceFile, { gifCrop: { x, y, size: side, angle: rotation } });
      } else {
        await onSave(await exportJpeg(bitmap, { offsetX: offset.x, offsetY: offset.y, zoom, rotation, circle }));
      }
    } catch (error) {
      onError?.(error.message || 'Could not save this photo.');
    }
  };

  const previewScale = PREVIEW / circle;
  const stageImage = bitmap ? imageStyle(width, height, offset.x, offset.y, zoom, rotation, circle) : null;
  const previewImage = bitmap
    ? imageStyle(width, height, offset.x * previewScale, offset.y * previewScale, zoom, rotation, PREVIEW)
    : null;

  return (
    <div
      className="dm-crop-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <section className="dm-crop-editor" role="dialog" aria-modal="true" aria-labelledby="crop-title" aria-busy={saving}>
        <h2 id="crop-title">{title}</h2>
        {bitmap ? (
          <div className="dm-crop-layout">
            <div
              ref={stageRef}
              className={`dm-crop-stage${dragging ? ' is-dragging' : ''}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <img src={imageUrl} alt="" draggable={false} style={stageImage} />
              <div className="dm-crop-ring" style={{ width: circle, height: circle }} />
            </div>
            <div className="dm-crop-preview-wrap">
              <span>{animatedGif ? 'Animated preview' : 'Preview'}</span>
              <div className="dm-crop-preview">
                <img src={imageUrl} alt="" draggable={false} style={previewImage} />
              </div>
            </div>
          </div>
        ) : (
          <p className="dm-crop-loading">Loading photo…</p>
        )}
        {animatedGif ? <p className="dm-crop-gif-note">GIFs can be cropped, zoomed, tilted, and rotated here. Saving converts the current GIF frame into a profile picture.</p> : null}
        {
          <div className="dm-crop-controls">
            <label className="dm-crop-slider">
              <span>Zoom {zoom.toFixed(2)}x</span>
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step="0.01"
                value={zoom}
                disabled={!bitmap || saving}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
            </label>
            <label className="dm-crop-slider">
              <span>Tilt {Math.round(tilt)}°</span>
              <input
                type="range"
                min="-45"
                max="45"
                step="0.5"
                value={tilt}
                disabled={!bitmap || saving}
                onChange={(event) => setTilt(Number(event.target.value))}
              />
            </label>
            <div className="dm-crop-rotate">
              <button type="button" disabled={!bitmap || saving} onClick={() => setTurn((value) => (value + 270) % 360)}>Rotate left</button>
              <button type="button" disabled={!bitmap || saving} onClick={() => setTurn((value) => (value + 90) % 360)}>Rotate right</button>
            </div>
          </div>
        }
        {error ? <p className="dm-crop-error" role="alert">{error}</p> : null}
        <div className="dm-crop-actions">
          <button type="button" disabled={saving} onClick={reset}>Reset</button>
          <button type="button" disabled={saving} onClick={onCancel}>Cancel</button>
          <button type="button" className="dm-crop-save" disabled={!bitmap || saving} onClick={save}>{saving ? 'Saving…' : 'Save photo'}</button>
        </div>
      </section>
    </div>
  );
}
