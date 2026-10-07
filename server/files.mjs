import { createReadStream, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import busboy from 'busboy';

const STREAM_CHUNK = 256 * 1024;
const MAX_FILE = 100 * 1024 * 1024;
const MAX_TOTAL = 250 * 1024 * 1024;

function parseBytesRange(header, size) {
  const match = String(header || '').match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start == null && end == null) return null;
  if (start == null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    end = end == null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end };
}

export function sendLocalFile(request, response, filePath, { type, extra = {}, gzipText = false } = {}) {
  const size = statSync(filePath).size;
  const range = request.method !== 'HEAD' ? parseBytesRange(request.headers.range, size) : null;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extra };
  const finish = (stream) => pipeline(stream, response).catch(() => { if (!response.writableEnded) response.destroy(); });
  if (range) {
    response.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': range.end - range.start + 1,
    });
    return finish(createReadStream(filePath, { start: range.start, end: range.end, highWaterMark: STREAM_CHUNK }));
  }
  const text = gzipText && request.method !== 'HEAD' && size > 1024 && /\bgzip\b/.test(String(request.headers['accept-encoding'] || ''));
  if (text) {
    const vary = extra.Vary ? `${extra.Vary}, Accept-Encoding` : 'Accept-Encoding';
    response.writeHead(200, { ...base, 'Content-Encoding': 'gzip', Vary: vary });
    return pipeline(createReadStream(filePath, { highWaterMark: STREAM_CHUNK }), createGzip({ level: 4 }), response).catch(() => { if (!response.writableEnded) response.destroy(); });
  }
  response.writeHead(200, { ...base, 'Content-Length': size });
  if (request.method === 'HEAD') return response.end();
  return finish(createReadStream(filePath, { highWaterMark: STREAM_CHUNK }));
}

export function parseMultipart(request, { directory, nameFile }) {
  return new Promise((resolve, reject) => {
    const files = [];
    const fields = {};
    const pending = [];
    let settled = false;
    let total = 0;
    let bb;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { request.unpipe(bb); } catch {}
      try { bb?.destroy(); } catch {}
      Promise.allSettled(pending).finally(() => {
        for (const file of files) {
          try { unlinkSync(join(directory, file.storageName)); } catch {}
        }
        reject(error);
      });
    };
    bb = busboy({
      headers: request.headers,
      highWaterMark: STREAM_CHUNK,
      limits: {
        files: 10,
        fileSize: MAX_FILE + 4096,
        fields: 24,
        fieldSize: 96 * 1024,
      },
    });
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      if (name !== 'files') {
        stream.resume();
        return;
      }
      const storageName = nameFile();
      const dest = join(directory, storageName);
      const item = {
        storageName,
        name: info.filename || 'file',
        type: info.mimeType || 'application/octet-stream',
        size: 0,
      };
      files.push(item);
      const writer = createWriteStream(dest, { flags: 'wx', mode: 0o600, highWaterMark: STREAM_CHUNK });
      stream.on('limit', () => fail(new Error('Each file can be up to 100 MB, with 250 MB total per message.')));
      stream.on('data', (chunk) => {
        item.size += chunk.length;
        total += chunk.length;
        if (total > MAX_TOTAL) fail(new Error('Attachments can total up to 250 MB per message.'));
      });
      pending.push(pipeline(stream, writer).catch((error) => {
        fail(error);
        throw error;
      }));
    });
    let completing = false;
    const complete = () => {
      if (settled || completing) return;
      completing = true;
      Promise.all(pending).then(() => {
        if (settled) return;
        settled = true;
        resolve({ fields, files });
      }).catch(fail);
    };
    bb.on('error', fail);
    bb.on('finish', complete);
    bb.on('close', complete);
    request.on('aborted', () => fail(new Error('Upload aborted')));
    request.on('error', fail);
    request.pipe(bb);
  });
}
