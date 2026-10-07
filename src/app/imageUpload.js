const OPTIMIZE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_EDGE = 1920;
const MIN_OPTIMIZE_BYTES = 1_500_000;

async function optimizeImage(file) {
  if (!OPTIMIZE_MIME_TYPES.has(file.type) || typeof createImageBitmap !== 'function') return file;
  let bitmap;
  let canvas;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < MIN_OPTIMIZE_BYTES) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: file.type !== 'image/jpeg' });
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, file.type, file.type === 'image/png' ? undefined : 0.84));
    if (!blob || blob.type !== file.type || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

export async function prepareUploadFiles(files) {
  const source = Array.from(files || []);
  const output = new Array(source.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(2, source.length) }, async () => {
    while (nextIndex < source.length) {
      const index = nextIndex++;
      output[index] = await optimizeImage(source[index]);
    }
  });
  await Promise.all(workers);
  return output;
}
