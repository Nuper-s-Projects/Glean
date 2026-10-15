import { createMemoryCache } from '../../app/memoryCache.js';
const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
const PEAKS_CACHE = createMemoryCache({ maxEntries: 48 });
export const VOICE_MAX_MS = 5 * 60 * 1000;
export const VOICE_SPEEDS = [1, 1.5, 2];

export function canRecordVoice() {
  return Boolean(window.isSecureContext && window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

export function pickRecorderType() {
  if (!window.MediaRecorder) return '';
  return RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

export function voiceFileFromBlob(blob, mime = '') {
  const type = String(blob?.type || mime || 'audio/webm').split(';')[0];
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  if (!blob || blob.size < 256) return null;
  return new File([blob], `voice-message.${ext}`, { type, lastModified: Date.now() });
}

export function isVoiceMessageName(name = '') {
  return /^voice-message\./i.test(String(name || ''));
}

function slicePeaks(channel, buckets) {
  const size = Math.max(1, Math.floor(channel.length / buckets));
  const peaks = [];
  for (let i = 0; i < buckets; i += 1) {
    let peak = 0;
    const start = i * size;
    const end = Math.min(channel.length, start + size);
    for (let j = start; j < end; j += 1) {
      const value = Math.abs(channel[j]);
      if (value > peak) peak = value;
    }
    peaks.push(peak);
  }
  const max = Math.max(...peaks, 0.04);
  return peaks.map((value) => Math.max(0.14, value / max));
}

export async function audioPeaks(src, buckets = 40) {
  if (!src) return Array(buckets).fill(0.22);
  const key = `${src}:${buckets}`;
  if (PEAKS_CACHE.has(key)) return PEAKS_CACHE.get(key);
  const pending = (async () => {
    const response = await fetch(src);
    const buffer = await response.arrayBuffer();
    const Context = window.AudioContext || window.webkitAudioContext;
    const context = new Context();
    try {
      const decoded = await context.decodeAudioData(buffer);
      return slicePeaks(decoded.getChannelData(0), buckets);
    } finally { await context.close().catch(() => {}); }
  })().catch(() => Array(buckets).fill(0.22));
  PEAKS_CACHE.set(key, pending);
  return pending;
}
