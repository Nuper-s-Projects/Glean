const frames = new Map();
const pending = new Map();
const queue = [];
let active = 0;

function capture(url) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let finished = false;
    let seeking = false;
    const finish = (frame = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
      video.removeAttribute('src');
      video.load();
      resolve(frame);
    };
    const draw = () => {
      if (video.readyState < 2 || !video.videoWidth || seeking) return;
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 160 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        finish();
      }
    };
    const timer = setTimeout(() => finish(), 15000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => {
      const time = Number.isFinite(video.duration) ? Math.min(1, video.duration * 0.1) : 0;
      if (time > 0) {
        seeking = true;
        video.currentTime = time;
      }
    };
    video.onloadeddata = draw;
    video.onseeked = () => { seeking = false; draw(); };
    video.onerror = () => finish();
    video.src = url;
  });
}

function drain() {
  while (active < 2 && queue.length) {
    const { url, resolve } = queue.shift();
    active++;
    capture(url).then((frame) => {
      frames.set(url, frame);
      if (frames.size > 100) frames.delete(frames.keys().next().value);
      pending.delete(url);
      resolve(frame);
    }).finally(() => { active--; drain(); });
  }
}

export function getVideoBackgroundFrame(url) {
  if (frames.has(url)) return Promise.resolve(frames.get(url));
  if (pending.has(url)) return pending.get(url);
  const promise = new Promise((resolve) => queue.push({ url, resolve }));
  pending.set(url, promise);
  drain();
  return promise;
}
