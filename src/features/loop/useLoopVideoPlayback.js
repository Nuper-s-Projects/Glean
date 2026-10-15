import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';

export default function useLoopVideoPlayback({ file, video, active, flow }) {
  const [playback, setPlayback] = useState(file.playback);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [near, setNear] = useState(flow && active);
  const [preparing, setPreparing] = useState(false);
  const [source, setSource] = useState(file.playback?.url || file.url);
  const started = useRef(null), controller = useRef(null), resume = useRef(null), previousSource = useRef(source);
  const identity = useRef(file.id);
  const current = useRef({ playback, failed, file });
  current.current = { playback, failed, file };
  const adopt = useCallback(next => {
    const url = next?.url || current.current.file.url;
    if (previousSource.current !== url) {
      const element = video.current;
      resume.current = identity.current === current.current.file.id ? { time: element?.currentTime || 0, playing: element && !element.paused } : null;
      previousSource.current = url; setSource(url); setFailed(false); setError('');
    }
    identity.current = current.current.file.id;
    setPlayback(next);
  }, [video]);
  useEffect(() => {
    adopt(file.playback);
    setFailed(false); setError('');
  }, [file.id, file.playback?.status, file.playback?.url, adopt]);
  useEffect(() => {
    if (flow) { setNear(active); return; }
    if (!('IntersectionObserver' in window)) { setNear(true); return; }
    const observer = new IntersectionObserver(entries => setNear(entries[0].isIntersecting), { rootMargin: '200px' });
    if (video.current) observer.observe(video.current);
    return () => observer.disconnect();
  }, [flow, active, video]);
  const prepare = useCallback(async (retry = false) => {
    if (!file.id) return;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setPreparing(true); setError('');
    try {
      const data = await apiRequest(`/loop/media/${file.id}/playback`, { method: 'POST', body: JSON.stringify({ retry }), signal: request.signal });
      if (!request.signal.aborted) {
        adopt(data.playback);
        if (data.playback.status === 'ready') setFailed(false);
      }
    } catch (failure) { if (!request.signal.aborted) setError(failure.message); }
    finally { if (!request.signal.aborted) setPreparing(false); }
  }, [file.id, adopt]);
  useEffect(() => {
    if (!near || !active || !file.id || playback?.status === 'ready' || playback?.status === 'failed' || started.current === file.id) return;
    started.current = file.id;
    if (!['queued', 'processing'].includes(playback?.status)) prepare();
  }, [near, active, file.id, playback?.status, prepare]);
  useEffect(() => () => controller.current?.abort(), [file.id]);
  useEffect(() => {
    if (!near || !active || !['queued','processing'].includes(playback?.status)) return;
    const request = new AbortController(); let timer;
    const poll = async () => {
      if (request.signal.aborted) return;
      if (document.visibilityState !== 'visible') { timer = setTimeout(poll,5000); return; }
      try {
        const data = await apiRequest(`/loop/media/${file.id}/playback`, { signal: request.signal });
        if (!request.signal.aborted) { adopt(data.playback); setError(''); }
      } catch (failure) {
        if (!request.signal.aborted && failure.name !== 'AbortError') {
          if (failure.status === 404 || failure.status === 401) { setError(failure.message); return; }
        }
      }
      if (!request.signal.aborted) timer = setTimeout(poll,3000);
    };
    timer = setTimeout(poll,1500);
    return () => { request.abort(); clearTimeout(timer); };
  }, [file.id, near, active, playback?.status, adopt]);
  const onError = () => {
    if (video.current?.hasAttribute('data-memory-suspended')) return;
    setFailed(true);
    const state = current.current;
    if (state.playback?.status === 'ready' || !file.id) setError('This video could not play. Check your connection and try again.');
    else if (!['queued','processing','failed'].includes(state.playback?.status)) prepare();
  };
  const loaded = () => {
    const element = video.current, saved = resume.current;
    setFailed(false); setError('');
    if (!element || !saved) return;
    resume.current = null;
    if (Number.isFinite(element.duration)) element.currentTime = Math.min(saved.time,Math.max(0,element.duration - .05));
    if (saved.playing && active) element.play().catch(() => { /* A tap can resume playback when autoplay is blocked. */ });
  };
  return { source, near, failed, loading: preparing || ['queued','processing'].includes(playback?.status),
    error: error || (playback?.status === 'failed' ? playback.error : ''), retryable: playback?.status !== 'failed' || playback.retryable,
    onError, loaded, retry: () => { setError(''); if (playback?.status === 'ready') { setFailed(false); video.current?.load(); } else prepare(playback?.status === 'failed'); } };
}
