import { useEffect, useRef, useState } from 'react';
import { AttachIcon, FullscreenIcon, MuteIcon, PauseIcon, PlayIcon, SpeakerIcon, VolumeIcon } from './icons';
import { formatFileSize, formatMediaTime } from './formatters';
import { audioPeaks, VOICE_SPEEDS } from './voiceNote';

function MediaSlider({ value, max, disabled, onChange, onPointerDown, onPointerUp, ariaLabel }) {
  const railRef = useRef(null);
  const draggingRef = useRef(false);
  const pct = max > 0 ? Math.min(100, Math.max(0, (Number(value) / max) * 100)) : 0;
  const apply = (clientX) => {
    if (disabled || !(max > 0) || !railRef.current) return;
    const rect = railRef.current.getBoundingClientRect();
    onChange(Math.min(max, Math.max(0, ((clientX - rect.left) / rect.width) * max)));
  };
  return (
    <div
      className="dm-video-slider"
      ref={railRef}
      role="slider"
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={Math.round(max || 0)}
      aria-valuenow={Math.round(Number(value) || 0)}
      aria-disabled={disabled ? 'true' : undefined}
      onPointerDown={(event) => {
        if (disabled) return;
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onPointerDown?.();
        apply(event.clientX);
      }}
      onPointerMove={(event) => { if (draggingRef.current) apply(event.clientX); }}
      onPointerUp={() => { draggingRef.current = false; onPointerUp?.(); }}
      onPointerCancel={() => { draggingRef.current = false; onPointerUp?.(); }}
    >
      <span className="dm-video-slider-bar">
        <span className="dm-video-slider-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function VolumeRail({ value, onChange }) {
  const railRef = useRef(null);
  const draggingRef = useRef(false);
  const apply = (clientY) => {
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    onChange(Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height)));
  };
  return (
    <div
      className="dm-video-volume-rail"
      ref={railRef}
      onPointerDown={(event) => {
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        apply(event.clientY);
      }}
      onPointerMove={(event) => { if (draggingRef.current) apply(event.clientY); }}
      onPointerUp={() => { draggingRef.current = false; }}
      onPointerCancel={() => { draggingRef.current = false; }}
      role="slider"
      aria-label="Volume"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <span className="dm-video-volume-fill" style={{ height: `${value * 100}%` }} />
    </div>
  );
}

function useMediaVolume(mediaRef, { volume, muted, src }) {
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    media.muted = muted;
    media.volume = muted ? 0 : volume;
  }, [mediaRef, muted, src, volume]);
}

export function AudioAttachment({ src, name }) {
  const audioRef = useRef(null);
  const waveRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [peaks, setPeaks] = useState(() => Array(40).fill(0.22));

  useEffect(() => {
    let cancelled = false;
    audioPeaks(src, 40).then((next) => { if (!cancelled) setPeaks(next); });
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    audio.muted = muted;
    audio.playbackRate = speed;
    const syncPlay = () => setPlaying(!audio.paused);
    const syncTime = () => {
      setCurrent(audio.currentTime || 0);
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onEnded = () => { setPlaying(false); setCurrent(0); };
    audio.addEventListener('play', syncPlay);
    audio.addEventListener('pause', syncPlay);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', syncTime);
    audio.addEventListener('loadedmetadata', syncTime);
    audio.addEventListener('durationchange', syncTime);
    return () => {
      audio.pause();
      audio.removeEventListener('play', syncPlay);
      audio.removeEventListener('pause', syncPlay);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', syncTime);
      audio.removeEventListener('loadedmetadata', syncTime);
      audio.removeEventListener('durationchange', syncTime);
    };
  }, [src, speed, muted]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };

  const seek = (event) => {
    const audio = audioRef.current;
    const wave = waveRef.current;
    if (!audio || !wave || !(duration > 0)) return;
    const rect = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrent(audio.currentTime);
  };

  const progress = duration > 0 && Number.isFinite(duration) ? current / duration : 0;
  const shownTime = duration > 0 && Number.isFinite(duration)
    ? ((playing || current > 0) ? Math.max(0, duration - current) : duration)
    : current;

  return (
    <div className="dm-voice-note">
      <audio ref={audioRef} src={src} preload="metadata" muted={muted} />
      <button className="dm-voice-play" type="button" onClick={togglePlay} aria-label={playing ? 'Pause voice message' : 'Play voice message'}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="dm-voice-wave" ref={waveRef} role="slider" tabIndex="0" aria-label={name || 'Voice message'} aria-valuemin="0" aria-valuemax={Math.round(duration || 0)} aria-valuenow={Math.round(current || 0)} onPointerDown={seek}>
        {peaks.map((value, index) => (
          <i
            key={index}
            className={index / peaks.length <= progress ? 'is-played' : ''}
            style={{ height: `${Math.round(6 + value * 18)}px` }}
          />
        ))}
      </div>
      <span className="dm-voice-time">{formatMediaTime(shownTime)}</span>
      <button className="dm-voice-speed" type="button" onClick={() => setSpeed((value) => VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(value) + 1) % VOICE_SPEEDS.length])} aria-label="Playback speed">
        {`${String(speed).replace(/\.0$/, '')}X`}
      </button>
      <button className="dm-voice-speaker" type="button" onClick={() => setMuted((value) => !value)} aria-label={muted ? 'Unmute' : 'Mute'}>
        {muted ? <MuteIcon /> : <SpeakerIcon />}
      </button>
    </div>
  );
}

export function VideoAttachment({ src, name, mutedPreview = false }) {
  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const draggingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(Boolean(mutedPreview));
  const [hover, setHover] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [seeking, setSeeking] = useState(false);

  const idleRef = useRef(null);

  useMediaVolume(videoRef, { volume, muted, src });

  const keepControls = () => {
    setHover(true);
    clearTimeout(idleRef.current);
    const video = videoRef.current;
    if (video && !video.paused) idleRef.current = setTimeout(() => setHover(false), 1800);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const syncPlay = () => setPlaying(!video.paused);
    const syncTime = () => {
      if (!draggingRef.current) setCurrent(video.currentTime || 0);
      if (Number.isFinite(video.duration)) setDuration(video.duration);
    };
    video.addEventListener('play', syncPlay);
    video.addEventListener('pause', syncPlay);
    video.addEventListener('ended', syncPlay);
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('loadedmetadata', syncTime);
    video.addEventListener('durationchange', syncTime);
    return () => {
      clearTimeout(idleRef.current);
      video.pause();
      video.removeEventListener('play', syncPlay);
      video.removeEventListener('pause', syncPlay);
      video.removeEventListener('ended', syncPlay);
      video.removeEventListener('timeupdate', syncTime);
      video.removeEventListener('loadedmetadata', syncTime);
      video.removeEventListener('durationchange', syncTime);
    };
  }, [src]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  const onSeek = (next) => {
    setCurrent(next);
    const video = videoRef.current;
    if (video) video.currentTime = next;
  };

  const setVolumeLevel = (next) => {
    setVolume(next);
    setMuted(next === 0);
  };

  const toggleFullscreen = () => {
    const wrap = wrapRef.current;
    const video = videoRef.current;
    if (document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else document.webkitExitFullscreen?.();
      return;
    }
    if (wrap?.requestFullscreen) {
      wrap.requestFullscreen().catch(() => {});
      return;
    }
    if (wrap?.webkitRequestFullscreen) {
      wrap.webkitRequestFullscreen();
      return;
    }
    video?.webkitEnterFullscreen?.();
  };

  const showBar = hover || volumeOpen || seeking;

  return (
    <div
      className={`dm-video-player${playing ? ' is-playing' : ' is-paused'}${showBar ? ' is-hover' : ''}${volumeOpen ? ' is-volume' : ''}`}
      ref={wrapRef}
      onMouseEnter={keepControls}
      onMouseMove={keepControls}
      onMouseLeave={() => { clearTimeout(idleRef.current); setHover(false); setVolumeOpen(false); }}
    >
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        playsInline
        muted={muted}
        onClick={togglePlay}
        aria-label={name}
      />
      {playing ? null : (
        <button className="dm-video-overlay-play" type="button" onClick={togglePlay} aria-label="Play">
          <PlayIcon />
        </button>
      )}
      <div className="dm-video-controls" onClick={(event) => event.stopPropagation()}>
        <button className="dm-video-ctrl" type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="dm-media-time">{formatMediaTime(current)} / {formatMediaTime(duration)}</span>
        <MediaSlider
          max={duration || 0}
          value={Math.min(current, duration || 0)}
          disabled={!duration}
          onPointerDown={() => { draggingRef.current = true; setSeeking(true); }}
          onPointerUp={() => { draggingRef.current = false; setSeeking(false); }}
          onChange={onSeek}
          ariaLabel="Seek"
        />
        <div
          className="dm-video-volume"
          onMouseEnter={() => setVolumeOpen(true)}
          onMouseLeave={() => setVolumeOpen(false)}
        >
          <div className="dm-video-volume-pop">
            <VolumeRail value={muted ? 0 : volume} onChange={setVolumeLevel} />
          </div>
          <button className="dm-video-ctrl" type="button" onClick={() => setMuted((value) => !value)} aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}>
            {muted || volume === 0 ? <MuteIcon /> : <VolumeIcon />}
          </button>
        </div>
        <button className="dm-video-ctrl" type="button" onClick={toggleFullscreen} aria-label="Fullscreen">
          <FullscreenIcon />
        </button>
      </div>
    </div>
  );
}

export function FileDownloadCard({ href, name, size }) {
  return (
    <a className="dm-file-attachment" href={href} target="_blank" rel="noreferrer" download={name}>
      <AttachIcon />
      <span>
        <strong>{name}</strong>
        <small>{size != null ? formatFileSize(size) : 'Download'}</small>
      </span>
    </a>
  );
}

export function useObjectUrl(file) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file) {
      setUrl('');
      return undefined;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}
