import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../app/apiClient';
import FlowSubtitles from './FlowSubtitles';
import { playbackTime } from './flowPlayback';

const preferenceKey = 'glean-loop-video-cc-v1';
const readPreference = () => { try { return localStorage.getItem(preferenceKey) === 'on'; } catch { return false; } };

export default function LoopVideo({ file, autoPlay = false, canRetry = false, active = true, muted = false, onMutedChange, loop = false, variant, onError }) {
  const video = useRef(null);
  const seek = useRef(null);
  const clock = useRef(null);
  const manualPause = useRef(false);
  const flow = variant === 'flow';
  const [paused, setPaused] = useState(true);
  const [silent, setSilent] = useState(muted);
  const [captions, setCaptions] = useState(file.captions);
  const [enabled, setEnabled] = useState(readPreference);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nativeFullscreen,setNativeFullscreen]=useState(false);
  const [buffering,setBuffering]=useState(false);
  const [soundBlocked,setSoundBlocked]=useState(false);
  useEffect(() => { if (flow) setSilent(muted); }, [flow,muted]);
  useEffect(()=>{
    if(!flow)return;
    const element=video.current;
    const entered=()=>setNativeFullscreen(true), exited=()=>setNativeFullscreen(false);
    const fullscreen=()=>setNativeFullscreen(document.fullscreenElement===element);
    element.addEventListener('webkitbeginfullscreen',entered);element.addEventListener('webkitendfullscreen',exited);document.addEventListener('fullscreenchange',fullscreen);
    return()=>{element.removeEventListener('webkitbeginfullscreen',entered);element.removeEventListener('webkitendfullscreen',exited);document.removeEventListener('fullscreenchange',fullscreen);};
  },[flow]);
  useEffect(() => { setCaptions(file.captions); }, [file.id, file.captions]);
  useEffect(() => {
    const element = video.current;
    let disposed = false;
    const update = () => {
      if (!active || document.visibilityState !== 'visible') element?.pause();
      else if (autoPlay && !manualPause.current) element?.play().catch(async failure => {
        if (disposed || failure.name==='AbortError' || !flow) return;
        if (failure.name==='NotAllowedError' && !element.muted) {
          element.muted=true;setSilent(true);setSoundBlocked(true);
          try { await element.play(); } catch { /* The visible play control is the user-gesture fallback. */ }
        }
      });
    };
    update();
    document.addEventListener('visibilitychange',update);
    return () => { disposed=true;document.removeEventListener('visibilitychange',update); element?.pause(); };
  }, [active,autoPlay,file.url,flow]);
  useEffect(() => {
    const sync = () => setEnabled(readPreference());
    window.addEventListener('storage',sync); window.addEventListener('glean-loop-cc',sync);
    return () => { window.removeEventListener('storage',sync); window.removeEventListener('glean-loop-cc',sync); };
  }, []);
  useEffect(() => {
    if (!['queued','processing'].includes(captions?.status)) return;
    const controller = new AbortController(); let timer;
    const poll = async () => {
      try { const data = await apiRequest(`/loop/media/${file.id}/captions`,{signal:controller.signal}); if (!controller.signal.aborted) setCaptions(data.captions); }
      catch (failure) { if (!controller.signal.aborted && failure.status === 404) setCaptions(null); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll,5000); }
    };
    timer = setTimeout(poll,3000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [file.id, captions?.status]);
  const apply = () => { if (video.current) for (const track of video.current.textTracks) if (track.kind === 'captions') track.mode = enabled ? (flow && !nativeFullscreen ? 'hidden' : 'showing') : 'disabled'; };
  useEffect(apply,[enabled,captions?.url,flow,nativeFullscreen]);
  const toggle = () => {
    const next = !enabled; setEnabled(next);
    try { localStorage.setItem(preferenceKey,next ? 'on' : 'off'); } catch {}
    window.dispatchEvent(new Event('glean-loop-cc'));
  };
  const retry = async () => {
    if (busy) return; setBusy(true); setError('');
    try { const data = await apiRequest(`/loop/media/${file.id}/captions`,{method:'POST',body:'{}'}); setCaptions(data.captions); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const progress = () => {
    const element = video.current, input = seek.current;
    if (!element || !input) return;
    const value = Number.isFinite(element.duration) && element.duration > 0 ? element.currentTime / element.duration * 100 : 0;
    input.value = String(value);
    input.style.setProperty('--flow-progress',`${value}%`);
    input.setAttribute('aria-valuetext',`${playbackTime(element.currentTime)} of ${playbackTime(element.duration)}`);
    if (clock.current) clock.current.textContent=`${playbackTime(element.currentTime)} / ${playbackTime(element.duration)}`;
  };
  const playPause = async () => {
    const element = video.current;
    if (!element || !active) return;
    if (!element.paused) { manualPause.current=true;element.pause(); }
    else { manualPause.current=false;try { await element.play(); setError(''); } catch { setError('Playback could not start. Tap play to try again.'); } }
  };
  const toggleSound = () => {
    const next=!silent;setSilent(next);setSoundBlocked(false);onMutedChange?.(next);
    if(video.current)video.current.muted=next;
    if(video.current?.paused && active && !manualPause.current)void video.current.play().catch(()=>setError('Tap play to start the video.'));
  };
  const fullscreen = async () => {
    const element=video.current;
    try {
      if(document.fullscreenElement)await document.exitFullscreen();
      else if(element?.requestFullscreen)await element.requestFullscreen();
      else if(element?.webkitEnterFullscreen)element.webkitEnterFullscreen();
      else setError('Fullscreen is not supported in this browser.');
    } catch {setError('Fullscreen could not open. Try again.');}
  };
  return <div className={`loop-caption-video${flow ? ' is-flow-video' : ''}`}><video ref={video} src={file.url} controls={!flow || nativeFullscreen} preload="metadata" autoPlay={autoPlay && active} muted={flow ? silent : muted} loop={loop} playsInline onLoadedMetadata={() => { apply(); progress(); }} onTimeUpdate={flow ? progress : undefined} onPlay={flow ? () => setPaused(false) : undefined} onPlaying={flow ? () => setBuffering(false) : undefined} onWaiting={flow ? () => setBuffering(true) : undefined} onCanPlay={flow ? () => setBuffering(false) : undefined} onPause={flow ? () => {setPaused(true);setBuffering(false);} : undefined} onError={onError}>
    {captions?.status === 'ready' ? <track key={captions.url} kind="captions" src={captions.url} srcLang="und" label="Automatic captions" default={enabled} onLoad={apply} /> : null}
  </video>{flow ? <>
    <FlowSubtitles video={video} enabled={enabled && !nativeFullscreen} source={captions?.url}/>
    <button className="loop-flow-play" type="button" aria-label={paused ? 'Play video' : 'Pause video'} onClick={playPause}>{buffering ? <span className="loop-flow-buffering" role="status" aria-label="Buffering video"/> : paused ? <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg> : null}</button>
    <button className="loop-flow-sound" type="button" aria-label={silent ? 'Unmute video' : 'Mute video'} aria-pressed={silent} onClick={toggleSound}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m11 5-6 4H2v6h3l6 4Z"/>{silent ? <path d="m16 9 6 6m0-6-6 6"/> : <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>}</svg>{soundBlocked ? <span>Tap for sound</span> : null}</button>
    <div className="loop-flow-player-controls">
      <button type="button" aria-label={paused ? 'Play video' : 'Pause video'} onClick={playPause}><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{paused ? <path d="m8 5 11 7-11 7Z"/> : <path d="M6 5h4v14H6zm8 0h4v14h-4z"/>}</svg></button>
      <span ref={clock} className="loop-flow-clock">0:00 / 0:00</span>
      <input ref={seek} className="loop-flow-seek" type="range" min="0" max="100" step=".1" defaultValue="0" aria-label="Video progress" onChange={event => { const element=video.current; if (element && Number.isFinite(element.duration) && element.duration>0) { element.currentTime= Math.max(0,Math.min(100,Number(event.target.value))) / 100 * element.duration; progress(); } }}/>
      <button type="button" aria-label="Fullscreen video" onClick={fullscreen}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button>
    </div>
  </> : null}{captions || (flow && error) ? <div className="loop-caption-controls">
    {captions?.status === 'ready' ? <><button type="button" aria-label="Closed captions" aria-pressed={enabled} onClick={toggle}>CC {enabled ? 'On' : 'Off'}</button>{!flow ? <small>Auto-generated captions</small> : null}</> : captions ? <><small role="status">{captions.status === 'empty' ? 'No speech detected.' : captions.status === 'failed' ? captions.error || 'Captions unavailable.' : 'Generating captions…'}</small>{canRetry && captions.status === 'failed' ? <button type="button" disabled={busy} onClick={retry}>{busy ? 'Retrying…' : 'Retry captions'}</button> : null}</> : null}
    {error ? <small role="alert">{error}</small> : null}
  </div> : null}</div>;
}
