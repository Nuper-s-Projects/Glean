const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

export function formatDateDivider(value) { return dateFormatter.format(new Date(value)); }
export function formatJoinedDate(value) {
  if (!value) return '';
  return dateFormatter.format(new Date(value));
}
export function formatEstablished(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(value));
}
export function formatMessageTime(value) { return timeFormatter.format(new Date(value)); }
export function shouldShowDivider(previous, current) { return !previous || new Date(previous.createdAt).toDateString() !== new Date(current.createdAt).toDateString(); }
export function isGroupedMessage(previous, current) {
  if (!previous || shouldShowDivider(previous, current)) return false;
  const previousId = Number(previous.author?.id ?? previous.sender?.id);
  const currentId = Number(current.author?.id ?? current.sender?.id);
  if (previousId !== currentId) return false;
  return new Date(current.createdAt) - new Date(previous.createdAt) < 7 * 60 * 1000;
}
export function formatFileSize(size) { return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`; }

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.ogv', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.oga']);

export function classifyFileKind(type = '', name = '') {
  const mime = String(type || '').toLowerCase().split(';')[0].trim();
  const fileName = String(name || '').toLowerCase();
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
  if (fileName.startsWith('voice-message.') || mime === 'audio/webm' || mime === 'audio/mp4' || mime === 'audio/ogg') return 'audio';
  if (mime.startsWith('image/') || IMAGE_EXTS.has(ext)) return 'image';
  if (mime.startsWith('video/') || VIDEO_EXTS.has(ext)) return 'video';
  if (mime.startsWith('audio/') || AUDIO_EXTS.has(ext)) return 'audio';
  if (mime === 'application/pdf' || mime === 'application/x-pdf' || ext === '.pdf') return 'pdf';
  return 'file';
}

export function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
