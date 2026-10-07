import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadWhiteboardImage } from '../../../app/dmApi';
import { CursorIcon, DownloadIcon, EraserIcon, HandIcon, ImagePlusIcon, PencilIcon, ShapeIcon, StickyIcon, TextIcon, TrashIcon } from '../../dm/icons';
import { boardBounds, drawBoard, exportBoardPng, hitTest, makeUid, objectBounds } from './board';

const COLORS = ['#f7fbff', '#249cff', '#5ce1a6', '#f0a202', '#ff6b81', '#b388ff', '#0c1018'];
const WIDTHS = [3, 6, 12, 22];
const SHAPES = [
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'line', label: 'Line' },
];
const TOOLS = [
  { id: 'select', label: 'Select', Icon: CursorIcon },
  { id: 'pencil', label: 'Pencil', Icon: PencilIcon },
  { id: 'eraser', label: 'Eraser', Icon: EraserIcon },
  { id: 'text', label: 'Text', Icon: TextIcon },
  { id: 'note', label: 'Sticky note', Icon: StickyIcon },
  { id: 'shape', label: 'Shape', Icon: ShapeIcon },
  { id: 'pan', label: 'Pan', Icon: HandIcon },
];

export default function WhiteboardApp({ scopeKey, snapshot, sendOp, subscribeOps, accountId, notice, onNotice }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const fileRef = useRef(null);
  const objectsRef = useRef([]);
  const draftRef = useRef(null);
  const strokeRef = useRef(null);
  const flushTimer = useRef(0);
  const dragRef = useRef(null);
  const imagesRef = useRef(new Map());
  const viewRef = useRef({ x: 40, y: 40, scale: 1 });
  const [, setRevision] = useState(0);
  const [tool, setTool] = useState('pencil');
  const [color, setColor] = useState('#f7fbff');
  const [width, setWidth] = useState(6);
  const [shape, setShape] = useState('rect');
  const [filled, setFilled] = useState(false);
  const [selectedUid, setSelectedUid] = useState(null);
  const [editor, setEditor] = useState(null);
  const [uploading, setUploading] = useState(false);

  const bump = useCallback(() => setRevision((value) => value + 1), []);

  const imageFor = useCallback((url) => {
    if (!url) return null;
    const cached = imagesRef.current.get(url);
    if (cached) return cached;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => bump();
    image.src = url;
    imagesRef.current.set(url, image);
    return image;
  }, [bump]);

  useEffect(() => {
    objectsRef.current = Array.isArray(snapshot?.objects) ? snapshot.objects.map((item) => ({ ...item })) : [];
    draftRef.current = null;
    strokeRef.current = null;
    setSelectedUid(null);
    setEditor(null);
    bump();
  }, [bump, scopeKey, snapshot]);

  const applyOp = useCallback((op) => {
    const list = objectsRef.current;
    if (op.type === 'add' && op.object?.uid) {
      if (!list.some((item) => item.uid === op.object.uid)) list.push({ ...op.object });
    } else if (op.type === 'stroke') {
      const target = list.find((item) => item.uid === op.uid);
      if (target) target.points = [...(target.points || []), ...(op.points || [])];
    } else if (op.type === 'patch') {
      const index = list.findIndex((item) => item.uid === op.uid);
      if (index >= 0) list[index] = { ...list[index], ...op.patch };
    } else if (op.type === 'delete') {
      objectsRef.current = list.filter((item) => item.uid !== op.uid);
    } else if (op.type === 'clear') {
      objectsRef.current = [];
    }
    bump();
  }, [bump]);

  useEffect(() => subscribeOps((op) => applyOp(op)), [applyOp, subscribeOps]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = wrap.clientWidth;
    const cssHeight = wrap.clientHeight;
    if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
      canvas.width = Math.round(cssWidth * ratio);
      canvas.height = Math.round(cssHeight * ratio);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    const list = draftRef.current ? [...objectsRef.current, draftRef.current] : objectsRef.current;
    drawBoard(canvas, list, viewRef.current, { imageFor, selectedUid, ratio });
  });

  useEffect(() => {
    let frame = 0;
    const loop = () => {
      redraw();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [redraw]);

  const toBoard = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (event.clientX - rect.left - view.x) / view.scale,
      y: (event.clientY - rect.top - view.y) / view.scale,
    };
  };

  const toScreen = (x, y) => {
    const view = viewRef.current;
    return { x: view.x + x * view.scale, y: view.y + y * view.scale };
  };

  const flushStroke = useCallback(() => {
    const pending = strokeRef.current;
    if (!pending || !pending.buffer.length) return;
    const points = pending.buffer.splice(0, pending.buffer.length);
    sendOp({ type: 'stroke', uid: pending.uid, points });
  }, [sendOp]);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = 0;
      flushStroke();
    }, 70);
  }, [flushStroke]);

  useEffect(() => () => {
    if (flushTimer.current) window.clearTimeout(flushTimer.current);
  }, []);

  const commitAdd = (object) => {
    objectsRef.current = [...objectsRef.current, object];
    sendOp({ type: 'add', object });
    bump();
  };

  const eraseObject = useCallback((uid) => {
    if (!uid) return;
    applyOp({ type: 'delete', uid });
    sendOp({ type: 'delete', uid });
    setSelectedUid((current) => (current === uid ? null : current));
  }, [applyOp, sendOp]);

  const openEditor = (object, isNew) => {
    const box = objectBounds(object);
    setEditor({ uid: object.uid, kind: object.kind, value: object.text || '', isNew, object, box });
  };

  const closeEditor = (commit) => {
    const current = editor;
    setEditor(null);
    if (!current) return;
    const text = String(commit ?? current.value ?? '').slice(0, 500);
    if (current.isNew) {
      if (!text.trim()) return;
      commitAdd({ ...current.object, text });
      return;
    }
    if (text === (current.object.text || '')) return;
    applyOp({ type: 'patch', uid: current.uid, patch: { text } });
    sendOp({ type: 'patch', uid: current.uid, patch: { text } });
  };

  const onPointerDown = (event) => {
    if (event.button === 1 || tool === 'pan' || event.shiftKey) {
      dragRef.current = { mode: 'pan', startX: event.clientX, startY: event.clientY, view: { ...viewRef.current } };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const point = toBoard(event);
    if (tool === 'eraser') {
      const target = hitTest(objectsRef.current, point.x, point.y);
      if (target) eraseObject(target.uid);
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { mode: 'erase', uid: target?.uid || null };
      return;
    }
    if (tool === 'pencil') {
      const object = { uid: makeUid(), kind: 'stroke', color, width, points: [point.x, point.y], authorId: accountId };
      strokeRef.current = { uid: object.uid, buffer: [] };
      commitAdd(object);
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { mode: 'draw', uid: object.uid, last: point };
      return;
    }
    if (tool === 'shape') {
      draftRef.current = { uid: makeUid(), kind: 'shape', shape, x: point.x, y: point.y, w: 1, h: 1, color, filled, width, authorId: accountId };
      dragRef.current = { mode: 'shape', start: point };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'text' || tool === 'note') {
      const object = tool === 'text'
        ? { uid: makeUid(), kind: 'text', x: point.x, y: point.y, w: 260, text: '', color, size: 20, authorId: accountId }
        : { uid: makeUid(), kind: 'note', x: point.x, y: point.y, w: 220, h: 180, text: '', color: '#f5e6a3', size: 18, authorId: accountId };
      openEditor(object, true);
      return;
    }
    const target = hitTest(objectsRef.current, point.x, point.y);
    setSelectedUid(target?.uid || null);
    if (!target) return;
    const box = objectBounds(target);
    const handleSize = 14 / viewRef.current.scale;
    const onHandle = point.x >= box.x + box.w - handleSize && point.y >= box.y + box.h - handleSize;
    if (onHandle && target.kind !== 'stroke') {
      dragRef.current = { mode: 'resize', uid: target.uid, start: point, origin: { ...target } };
    } else {
      dragRef.current = { mode: 'move', uid: target.uid, start: point, origin: { ...target } };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === 'pan') {
      viewRef.current = { ...drag.view, x: drag.view.x + (event.clientX - drag.startX), y: drag.view.y + (event.clientY - drag.startY) };
      return;
    }
    const point = toBoard(event);
    if (drag.mode === 'erase') {
      const target = hitTest(objectsRef.current, point.x, point.y);
      if (target && target.uid !== drag.uid) {
        eraseObject(target.uid);
        drag.uid = target.uid;
      }
      return;
    }
    if (drag.mode === 'draw') {
      const object = objectsRef.current.find((item) => item.uid === drag.uid);
      if (!object) return;
      const dx = point.x - drag.last.x;
      const dy = point.y - drag.last.y;
      if (Math.hypot(dx, dy) < 1.2 / viewRef.current.scale) return;
      drag.last = point;
      object.points = [...object.points, point.x, point.y];
      strokeRef.current?.buffer.push(point.x, point.y);
      if ((strokeRef.current?.buffer.length || 0) >= 320) flushStroke();
      else scheduleFlush();
      return;
    }
    if (drag.mode === 'shape' && draftRef.current) {
      draftRef.current = { ...draftRef.current, w: point.x - drag.start.x, h: point.y - drag.start.y, color, filled, shape };
      return;
    }
    if (drag.mode === 'move') {
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      const object = objectsRef.current.find((item) => item.uid === drag.uid);
      if (!object) return;
      if (object.kind === 'stroke') {
        object.points = drag.origin.points.map((value, index) => (index % 2 === 0 ? value + dx : value + dy));
      } else {
        object.x = drag.origin.x + dx;
        object.y = drag.origin.y + dy;
      }
      bump();
      return;
    }
    if (drag.mode === 'resize') {
      const object = objectsRef.current.find((item) => item.uid === drag.uid);
      if (!object) return;
      object.w = Math.max(20, drag.origin.w + (point.x - drag.start.x));
      if (object.kind !== 'text') object.h = Math.max(20, (drag.origin.h || 120) + (point.y - drag.start.y));
      bump();
    }
  };

  const onPointerUp = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag) return;
    if (drag.mode === 'draw') {
      if (flushTimer.current) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = 0;
      }
      flushStroke();
      strokeRef.current = null;
      return;
    }
    if (drag.mode === 'shape' && draftRef.current) {
      const draft = draftRef.current;
      draftRef.current = null;
      if (Math.abs(draft.w) < 6 && Math.abs(draft.h) < 6) {
        commitAdd({ ...draft, w: 160, h: 120 });
        return;
      }
      commitAdd(draft);
      return;
    }
    if (drag.mode === 'move' || drag.mode === 'resize') {
      const object = objectsRef.current.find((item) => item.uid === drag.uid);
      if (!object) return;
      if (object.kind === 'stroke') {
        sendOp({ type: 'delete', uid: object.uid });
        sendOp({ type: 'add', object: { ...object, points: object.points.slice(0, 500) } });
        const rest = object.points.slice(500);
        for (let i = 0; i < rest.length; i += 500) sendOp({ type: 'stroke', uid: object.uid, points: rest.slice(i, i + 500) });
        return;
      }
      sendOp({ type: 'patch', uid: object.uid, patch: { x: object.x, y: object.y, w: object.w, h: object.h } });
    }
  };

  const onDoubleClick = (event) => {
    const point = toBoard(event);
    const target = hitTest(objectsRef.current, point.x, point.y);
    if (!target || (target.kind !== 'text' && target.kind !== 'note')) return;
    if (target.kind === 'text' && Number(target.authorId) !== Number(accountId)) {
      onNotice?.('Only the author can edit that text.');
      return;
    }
    openEditor(target, false);
  };

  const onWheel = (event) => {
    event.preventDefault();
    const view = viewRef.current;
    const rect = canvasRef.current.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const scale = Math.max(0.25, Math.min(4, view.scale * factor));
    viewRef.current = {
      scale,
      x: pointerX - ((pointerX - view.x) / view.scale) * scale,
      y: pointerY - ((pointerY - view.y) / view.scale) * scale,
    };
  };

  const removeSelected = () => {
    if (!selectedUid) return;
    eraseObject(selectedUid);
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (editor) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedUid) {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        event.preventDefault();
        removeSelected();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  const addImage = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await uploadWhiteboardImage(scopeKey, file);
      const bitmap = await new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = url;
      });
      const maxSide = 420;
      const ratio = bitmap?.naturalWidth ? bitmap.naturalHeight / bitmap.naturalWidth : 0.75;
      const w = Math.min(maxSide, bitmap?.naturalWidth || maxSide);
      const view = viewRef.current;
      const wrap = wrapRef.current;
      const centerX = ((wrap?.clientWidth || 800) / 2 - view.x) / view.scale;
      const centerY = ((wrap?.clientHeight || 600) / 2 - view.y) / view.scale;
      commitAdd({
        uid: makeUid(),
        kind: 'image',
        url,
        x: centerX - w / 2,
        y: centerY - (w * ratio) / 2,
        w,
        h: Math.max(24, Math.round(w * ratio)),
        authorId: accountId,
      });
    } catch (error) {
      onNotice?.(error.message || 'That image could not be added.');
    } finally {
      setUploading(false);
    }
  };

  const exportPng = () => {
    const dataUrl = exportBoardPng(objectsRef.current, imageFor);
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'glean-whiteboard.png';
    link.click();
  };

  const fitBoard = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const bounds = boardBounds(objectsRef.current);
    const scale = Math.max(0.25, Math.min(2, Math.min(wrap.clientWidth / bounds.w, wrap.clientHeight / bounds.h)));
    viewRef.current = {
      scale,
      x: (wrap.clientWidth - bounds.w * scale) / 2 - bounds.x * scale,
      y: (wrap.clientHeight - bounds.h * scale) / 2 - bounds.y * scale,
    };
  };

  const editorScreen = editor ? toScreen(editor.box.x, editor.box.y) : null;
  const showColor = tool !== 'select' && tool !== 'pan' && tool !== 'eraser';

  return (
    <div className="glean-whiteboard">
      <div
        className={`glean-board-surface tool-${tool}`}
        ref={wrapRef}
        onWheel={onWheel}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
        />
        {editor ? (
          <textarea
            className={`glean-board-editor${editor.kind === 'note' ? ' is-note' : ''}`}
            style={{
              left: `${editorScreen.x}px`,
              top: `${editorScreen.y}px`,
              width: `${Math.max(140, editor.box.w * viewRef.current.scale)}px`,
              height: `${Math.max(48, (editor.kind === 'note' ? editor.box.h : 60) * viewRef.current.scale)}px`,
            }}
            value={editor.value}
            autoFocus
            maxLength={500}
            placeholder={editor.kind === 'note' ? 'Sticky note' : 'Type text'}
            onChange={(event) => setEditor((current) => ({ ...current, value: event.target.value }))}
            onBlur={() => closeEditor()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setEditor(null);
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                closeEditor();
              }
            }}
          />
        ) : null}
      </div>
      {notice ? <p className="glean-app-error" role="alert">{notice}</p> : null}
      <div className="glean-board-toolbar">
        <div className="glean-board-tools" role="group" aria-label="Whiteboard tools">
          {TOOLS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={tool === id ? 'is-active' : undefined}
              aria-pressed={tool === id}
              aria-label={label}
              title={label}
              onClick={() => { setTool(id); setSelectedUid(null); }}
            >
              <Icon />
            </button>
          ))}
          <button type="button" aria-label="Add image" title="Add image" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <ImagePlusIcon />
          </button>
          <input
            ref={fileRef}
            className="dm-file-input"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              addImage(file);
            }}
          />
        </div>
        {showColor ? (
          <div className="glean-board-colors" role="group" aria-label="Color">
            {COLORS.map((item) => (
              <button
                key={item}
                type="button"
                className={color === item ? 'is-active' : undefined}
                style={{ background: item }}
                aria-label={`Color ${item}`}
                aria-pressed={color === item}
                onClick={() => setColor(item)}
              />
            ))}
          </div>
        ) : null}
        {tool === 'pencil' ? (
          <div className="glean-board-widths" role="group" aria-label="Thickness">
            {WIDTHS.map((item) => (
              <button key={item} type="button" className={width === item ? 'is-active' : undefined} aria-pressed={width === item} aria-label={`Thickness ${item}`} onClick={() => setWidth(item)}>
                <i style={{ width: `${Math.min(18, item)}px`, height: `${Math.min(18, item)}px` }} aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : null}
        {tool === 'shape' ? (
          <div className="glean-board-shapes">
            <select value={shape} onChange={(event) => setShape(event.target.value)} aria-label="Shape">
              {SHAPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <label>
              <input type="checkbox" checked={filled} onChange={(event) => setFilled(event.target.checked)} />
              Filled
            </label>
          </div>
        ) : null}
        <div className="glean-board-actions">
          <button type="button" onClick={fitBoard}>Fit</button>
          <button type="button" onClick={exportPng} aria-label="Export as PNG" title="Export as PNG"><DownloadIcon /></button>
          <button type="button" className="is-danger" onClick={removeSelected} disabled={!selectedUid} aria-label="Delete selection" title="Delete selection"><TrashIcon /></button>
        </div>
      </div>
      <p className="glean-board-hint">
        {tool === 'eraser' ? 'Click or drag over objects to erase them.' : objectsRef.current.length ? 'Drag with Select to move things. Double-click text to edit it.' : 'Pick the pencil and start drawing. Everyone in the call sees it live.'}
      </p>
    </div>
  );
}
