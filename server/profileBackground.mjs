import busboy from 'busboy';
import sharp from 'sharp';
import { PROFILE_BACKGROUND_MAX_BYTES, profileImageAdjustments } from '../src/app/profileBackground.js';

const message = 'Choose a JPG, PNG, or WebP up to 8 MB.';

// Bound both the compressed upload and decoded pixels before saving a sanitized image.
export async function readProfileBackgroundImage(request, { includeMetadata = false } = {}) {
  const maxBody = PROFILE_BACKGROUND_MAX_BYTES + 64 * 1024;
  if (Number(request.headers['content-length']) > maxBody) {
    request.resume();
    throw new Error(message);
  }
  const { bytes, adjustments, metadata: inputMetadata } = await new Promise((resolve, reject) => {
    let parser;
    let settled = false;
    let total = 0;
    let fileSeen = false;
    const chunks = [];
    let settings = {};
    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      request.unpipe(parser);
      request.resume();
      reject(error);
    };
    try {
      parser = busboy({ headers: request.headers, limits: { files: 1, fields: 1, parts: 3, fileSize: PROFILE_BACKGROUND_MAX_BYTES + 1, fieldSize: 1024 } });
    } catch {
      request.resume();
      reject(new Error('Invalid image upload.'));
      return;
    }
    request.on('data', chunk => {
      total += chunk.length;
      if (total > maxBody) fail(new Error(message));
    });
    request.on('aborted', () => fail(new Error('Upload was interrupted.')));
    request.on('error', fail);
    parser.on('error', () => fail(new Error('Invalid image upload.')));
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => fail(new Error('Upload one background image.')));
    parser.on('field', (name, value, info) => {
      if (name !== 'adjustments' || info.valueTruncated) return fail(new Error('Invalid image adjustments.'));
      try { settings = JSON.parse(value); } catch { fail(new Error('Invalid image adjustments.')); }
    });
    parser.on('file', (name, stream, info) => {
      fileSeen = true;
      stream.on('error', fail);
      stream.on('limit', () => fail(new Error(message)));
      if (name !== 'background' || !['image/jpeg', 'image/png', 'image/webp'].includes(info.mimeType)) {
        stream.resume();
        fail(new Error(message));
        return;
      }
      stream.on('data', chunk => { if (!settled) chunks.push(chunk); });
    });
    parser.on('close', () => {
      if (settled) return;
      const normalized = profileImageAdjustments(settings, true);
      if (!normalized) return fail(new Error('Contrast and saturation must be 0–200%. Blur must be 0–100px.'));
      if (!fileSeen || !chunks.length) return fail(new Error(message));
      settled = true;
      resolve({ bytes: Buffer.concat(chunks), adjustments: normalized, metadata: { name: settings.name, id: settings.id } });
    });
    request.pipe(parser);
  });
  try {
    const image = sharp(bytes, { limitInputPixels: 24_000_000 });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error(message);
    const output = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#101a23' }).jpeg({ quality: 88 }).toBuffer();
    return { bytes: output, adjustments, ...(includeMetadata ? { metadata: inputMetadata } : {}) };
  } catch {
    throw new Error('Choose a valid, still JPG, PNG, or WebP image up to 8 MB and 24 megapixels.');
  }
}
