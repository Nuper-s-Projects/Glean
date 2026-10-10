import { useEffect, useRef, useState } from 'react';
import { getVideoBackgroundFrame } from './videoBackgroundFrame';

const accents = new Map();

function attachmentAccent(image) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 24;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, 24, 24);
  const pixels = context.getImageData(0, 0, 24, 24).data;
  const buckets = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, alpha] = pixels.subarray(i, i + 4);
    if (alpha < 128 || Math.max(r, g, b) < 24) continue;
    const key = `${r >> 5},${g >> 5},${b >> 5}`;
    const bucket = buckets.get(key) || { rgb: [0, 0, 0], count: 0, score: 0 };
    bucket.rgb[0] += r; bucket.rgb[1] += g; bucket.rgb[2] += b;
    bucket.count++;
    bucket.score += 0.2 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    buckets.set(key, bucket);
  }
  const dominant = [...buckets.values()].sort((a, b) => b.score - a.score)[0];
  let rgb = dominant ? dominant.rgb.map(value => value / dominant.count) : [180, 180, 180];
  const luminance = values => values.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  while (luminance(rgb) < 0.5) rgb = rgb.map(value => value + (255 - value) * 0.1);
  return rgb.map(Math.round).join(' ');
}

export default function PostAttachmentBackground({ url, mimeType, onReady, onFailure }) {
  const video = mimeType?.startsWith('video/');
  const container = useRef(null);
  const [source, setSource] = useState(video ? '' : url);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const card = container.current?.parentElement;
    return () => card?.style.removeProperty('--loop-post-accent-rgb');
  }, []);
  const imageLoaded = (event) => {
    try {
      let accent = accents.get(source);
      if (!accent) {
        accent = attachmentAccent(event.currentTarget); accents.set(source, accent);
        if (accents.size > 100) accents.delete(accents.keys().next().value);
      }
      container.current?.parentElement.style.setProperty('--loop-post-accent-rgb', accent);
    } catch {
      // Cross-origin media can render without allowing canvas color sampling.
    }
    setLoaded(true);
    onReady?.();
  };
  const imageFailed = () => {
    container.current?.parentElement.style.removeProperty('--loop-post-accent-rgb');
    setFailed(true);
    onFailure?.();
  };
  useEffect(() => {
    if (!video) return;
    let cancelled = false;
    const capture = () => getVideoBackgroundFrame(url).then((frame) => {
      if (cancelled) return;
      if (frame) setSource(frame);
      else { setFailed(true); onFailure?.(); }
    });
    let observer;
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        capture();
      }, { rootMargin: '200px' });
      observer.observe(container.current);
    } else capture();
    return () => { cancelled = true; observer?.disconnect(); };
  }, [url, video, onFailure]);
  if (failed) return null;
  return <><div ref={container} className={`loop-post-attachment-background${loaded ? ' is-loaded' : ''}`} aria-hidden="true">
    {source ? <img src={source} alt="" loading="lazy" decoding="async" onLoad={imageLoaded} onError={imageFailed} /> : null}
  </div>{loaded ? <div className="loop-post-attachment-border" style={{ backgroundImage: `url(${JSON.stringify(source)})` }} aria-hidden="true" /> : null}</>;
}
