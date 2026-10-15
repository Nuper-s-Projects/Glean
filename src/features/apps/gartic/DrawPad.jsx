import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { UndoIcon } from '../../dm/icons';
import { startVisualLoop } from '../../../app/pageActivity';

const WIDTHS = [3, 6, 12, 22];
const PAD_WIDTH = 1000;
const PAD_HEIGHT = 640;

function drawStrokes(canvas, strokes, { blind = false } = {}) {
  const ctx = canvas.getContext('2d');
  const ratio = canvas.width / PAD_WIDTH;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, PAD_WIDTH, PAD_HEIGHT);
  ctx.fillStyle = '#f7fbff';
  ctx.fillRect(0, 0, PAD_WIDTH, PAD_HEIGHT);
  if (blind) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    const points = stroke.points || [];
    if (points.length < 2) continue;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length - 1; i += 2) ctx.lineTo(points[i], points[i + 1]);
    if (points.length === 2) ctx.lineTo(points[0] + 0.1, points[1] + 0.1);
    ctx.stroke();
  }
}

export const DrawingPreview = function DrawingPreview({ content, className = '' }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let strokes = [];
    try { strokes = JSON.parse(content || '[]'); } catch { strokes = []; }
    canvas.width = PAD_WIDTH;
    canvas.height = PAD_HEIGHT;
    drawStrokes(canvas, Array.isArray(strokes) ? strokes : []);
  }, [content]);
  return <canvas className={`glean-gartic-preview ${className}`.trim()} ref={canvasRef} aria-label="Drawing" />;
};

const DrawPad = forwardRef(function DrawPad({ seed, blind = false, disabled = false }, ref) {
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);
  const seedCountRef = useRef(0);
  const drawingRef = useRef(null);
  const [color, setColor] = useState('#0c1018');
  const [width, setWidth] = useState(6);
  const [, setRevision] = useState(0);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || PAD_WIDTH;
    const target = Math.round(cssWidth * ratio);
    if (canvas.width !== target) {
      canvas.width = target;
      canvas.height = Math.round(target * (PAD_HEIGHT / PAD_WIDTH));
    }
    drawStrokes(canvas, strokesRef.current, { blind });
  }, [blind]);

  useEffect(() => {
    let parsed = [];
    try { parsed = JSON.parse(seed || '[]'); } catch { parsed = []; }
    strokesRef.current = Array.isArray(parsed) ? parsed.map((item) => ({ ...item })) : [];
    seedCountRef.current = strokesRef.current.length;
    setRevision((value) => value + 1);
    render();
  }, [render, seed]);

  useEffect(() => startVisualLoop(render), [render]);

  useImperativeHandle(ref, () => ({
    value: () => JSON.stringify(strokesRef.current),
  }), []);

  const toPad = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(PAD_WIDTH, ((event.clientX - rect.left) / rect.width) * PAD_WIDTH)),
      y: Math.max(0, Math.min(PAD_HEIGHT, ((event.clientY - rect.top) / rect.height) * PAD_HEIGHT)),
    };
  };

  const onPointerDown = (event) => {
    if (disabled) return;
    const point = toPad(event);
    const stroke = { color, width, points: [point.x, point.y] };
    strokesRef.current = [...strokesRef.current, stroke];
    drawingRef.current = { stroke, last: point };
    event.currentTarget.setPointerCapture(event.pointerId);
    setRevision((value) => value + 1);
  };

  const onPointerMove = (event) => {
    const active = drawingRef.current;
    if (!active) return;
    const point = toPad(event);
    if (Math.hypot(point.x - active.last.x, point.y - active.last.y) < 2) return;
    active.last = point;
    active.stroke.points.push(point.x, point.y);
  };

  const onPointerUp = (event) => {
    drawingRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const undo = () => {
    if (strokesRef.current.length <= seedCountRef.current) return;
    strokesRef.current = strokesRef.current.slice(0, -1);
    setRevision((value) => value + 1);
  };

  const clear = () => {
    strokesRef.current = strokesRef.current.slice(0, seedCountRef.current);
    setRevision((value) => value + 1);
  };

  return (
    <div className={`glean-gartic-pad${blind ? ' is-blind' : ''}`}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {blind ? <p className="glean-gartic-blind-note">Secret mode: your ink is hidden until the reveal.</p> : null}
      <div className="glean-gartic-pad-tools">
        <label className="glean-gartic-color-picker">
          <span>Color</span>
          <input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            aria-label="Drawing color"
          />
          <code>{color.toUpperCase()}</code>
        </label>
        <div className="glean-board-widths" role="group" aria-label="Thickness">
          {WIDTHS.map((item) => (
            <button key={item} type="button" className={width === item ? 'is-active' : undefined} aria-pressed={width === item} aria-label={`Thickness ${item}`} onClick={() => setWidth(item)}>
              <i style={{ width: `${Math.min(18, item)}px`, height: `${Math.min(18, item)}px` }} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="glean-board-actions">
          <button type="button" onClick={undo} aria-label="Undo" title="Undo"><UndoIcon /></button>
          <button type="button" onClick={clear}>Clear</button>
        </div>
      </div>
    </div>
  );
});

export default DrawPad;
