export function makeUid() {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${random}`.slice(0, 40);
}

export function strokeBounds(points) {
  if (!points?.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length - 1; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

export function objectBounds(object) {
  if (!object) return { x: 0, y: 0, w: 0, h: 0 };
  if (object.kind === 'stroke') {
    const box = strokeBounds(object.points);
    const pad = (object.width || 4) / 2 + 2;
    return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
  }
  if (object.kind === 'shape') {
    const x = Math.min(object.x, object.x + object.w);
    const y = Math.min(object.y, object.y + object.h);
    return { x, y, w: Math.abs(object.w), h: Math.abs(object.h) };
  }
  if (object.kind === 'text') {
    const lines = String(object.text || ' ').split('\n').length;
    const size = object.size || 18;
    return { x: object.x, y: object.y, w: object.w || 220, h: Math.max(size * 1.4, lines * size * 1.35) + 8 };
  }
  return { x: object.x, y: object.y, w: object.w || 200, h: object.h || 160 };
}

export function hitTest(objects, x, y) {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const object = objects[i];
    const box = objectBounds(object);
    if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return object;
  }
  return null;
}

export function boardBounds(objects) {
  if (!objects.length) return { x: 0, y: 0, w: 1200, h: 760 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const object of objects) {
    const box = objectBounds(object);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX - 24, y: minY - 24, w: Math.max(64, maxX - minX + 48), h: Math.max(64, maxY - minY + 48) };
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text || '').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !current) current = candidate;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

function drawShape(ctx, object) {
  const x = Math.min(object.x, object.x + object.w);
  const y = Math.min(object.y, object.y + object.h);
  const w = Math.abs(object.w);
  const h = Math.abs(object.h);
  ctx.beginPath();
  if (object.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
  else if (object.shape === 'triangle') {
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
  } else if (object.shape === 'line') {
    ctx.moveTo(object.x, object.y);
    ctx.lineTo(object.x + object.w, object.y + object.h);
  } else ctx.rect(x, y, Math.max(1, w), Math.max(1, h));
  if (object.filled && object.shape !== 'line') {
    ctx.fillStyle = object.color;
    ctx.fill();
  } else {
    ctx.strokeStyle = object.color;
    ctx.lineWidth = object.width || 4;
    ctx.stroke();
  }
}

export function drawObject(ctx, object, imageFor) {
  ctx.save();
  if (object.kind === 'stroke') {
    ctx.strokeStyle = object.color;
    ctx.lineWidth = object.width || 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const points = object.points || [];
    for (let i = 0; i < points.length - 1; i += 2) {
      if (i === 0) ctx.moveTo(points[0], points[1]);
      else ctx.lineTo(points[i], points[i + 1]);
    }
    if (points.length === 2) ctx.lineTo(points[0] + 0.1, points[1] + 0.1);
    ctx.stroke();
  } else if (object.kind === 'shape') {
    drawShape(ctx, object);
  } else if (object.kind === 'note') {
    const box = objectBounds(object);
    ctx.fillStyle = object.color || '#f5e6a3';
    ctx.beginPath();
    ctx.roundRect?.(box.x, box.y, box.w, box.h, 10);
    if (!ctx.roundRect) ctx.rect(box.x, box.y, box.w, box.h);
    ctx.fill();
    ctx.fillStyle = 'rgba(12, 16, 24, 0.9)';
    ctx.font = `500 ${object.size || 18}px Lexend, Arial, sans-serif`;
    ctx.textBaseline = 'top';
    const lines = wrapLines(ctx, object.text, box.w - 20);
    lines.slice(0, Math.max(1, Math.floor((box.h - 12) / ((object.size || 18) * 1.35)))).forEach((line, index) => {
      ctx.fillText(line, box.x + 10, box.y + 10 + index * (object.size || 18) * 1.35);
    });
  } else if (object.kind === 'text') {
    ctx.fillStyle = object.color || '#f7fbff';
    ctx.font = `600 ${object.size || 18}px Lexend, Arial, sans-serif`;
    ctx.textBaseline = 'top';
    const lines = wrapLines(ctx, object.text, object.w || 220);
    lines.forEach((line, index) => {
      ctx.fillText(line, object.x, object.y + index * (object.size || 18) * 1.35);
    });
  } else if (object.kind === 'image') {
    const image = imageFor?.(object.url);
    if (image?.complete && image.naturalWidth) ctx.drawImage(image, object.x, object.y, object.w, object.h);
    else {
      ctx.strokeStyle = 'rgba(247, 251, 255, 0.35)';
      ctx.lineWidth = 2;
      ctx.strokeRect(object.x, object.y, object.w, object.h);
    }
  }
  ctx.restore();
}

export function drawBoard(canvas, objects, view, { imageFor, selectedUid, ratio = 1 } = {}) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);
  for (const object of objects) drawObject(ctx, object, imageFor);
  if (selectedUid) {
    const selected = objects.find((item) => item.uid === selectedUid);
    if (selected) {
      const box = objectBounds(selected);
      ctx.strokeStyle = '#249cff';
      ctx.lineWidth = 1.5 / view.scale;
      ctx.setLineDash([6 / view.scale, 4 / view.scale]);
      ctx.strokeRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
      ctx.setLineDash([]);
      ctx.fillStyle = '#249cff';
      ctx.fillRect(box.x + box.w, box.y + box.h, 10 / view.scale, 10 / view.scale);
    }
  }
  ctx.restore();
}

export function exportBoardPng(objects, imageFor) {
  const bounds = boardBounds(objects);
  const scale = Math.min(2, Math.max(1, 1600 / Math.max(bounds.w, bounds.h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bounds.w * scale));
  canvas.height = Math.max(1, Math.round(bounds.h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0f16';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(-bounds.x, -bounds.y);
  for (const object of objects) drawObject(ctx, object, imageFor);
  return canvas.toDataURL('image/png');
}
