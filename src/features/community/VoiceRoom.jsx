import { useCallback, useEffect, useRef, useState } from 'react';
import { CommunityAvatar } from './CommunityAvatar';
import { VoiceBadges } from './VoiceBits';
import { HeadphonesIcon, MicIcon, MicOffIcon, PhoneOffIcon, RocketIcon, ScreenIcon, SpeakerIcon, VideoIcon } from '../dm/icons';
import AppShelf from '../apps/AppShelf';
import AppStage from '../apps/AppStage';
import useAppSession from '../apps/useAppSession';
import { channelAppScope } from '../apps/catalog';
import { apiRequest } from '../../app/apiClient';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }],
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

const VOLUME_STORAGE = 'glean:voice-person-volumes';

function tuneVideoSender(sender) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 900000;
    params.encodings[0].maxFramerate = 24;
    if ('degradationPreference' in params) params.degradationPreference = 'maintain-framerate';
    sender.setParameters(params).catch(() => {});
  } catch {}
}

function toJsonCandidate(candidate) {
  return candidate?.toJSON ? candidate.toJSON() : candidate;
}

function sameTracks(stream, tracks) {
  if (!stream && !tracks.length) return true;
  if (!stream) return false;
  const current = stream.getTracks();
  return current.length === tracks.length && tracks.every((track) => current.includes(track));
}

function streamHasLiveVideo(stream) {
  return Boolean(stream?.getVideoTracks().some((track) => track.readyState === 'live' && track.enabled && !track.muted));
}

function clearVideo(node) {
  if (!node) return;
  node.pause();
  node.srcObject = null;
  node.removeAttribute('src');
  try { node.load(); } catch {}
}

export function microphoneError(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Allow microphone access in the browser prompt, then join again.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'Your microphone is already in use by another app.';
  if (name === 'SecurityError') return 'This page is not allowed to use the microphone.';
  if (name === 'NotSupportedError') return 'This browser cannot access a microphone.';
  return 'Microphone access is required to join voice chat.';
}

function hubOf(realtime) {
  return realtime && typeof realtime.send === 'function' ? realtime : realtime?.current || null;
}

function bindVideo(node, track, { mirror = false } = {}) {
  if (!node) return false;
  node.muted = true;
  node.playsInline = true;
  node.autoplay = true;
  node.classList.toggle('is-mirror', Boolean(mirror));
  if (!track || track.readyState === 'ended') {
    clearVideo(node);
    return false;
  }
  const current = node.srcObject;
  const same = current instanceof MediaStream && current.getVideoTracks()[0] === track;
  if (!same) node.srcObject = new MediaStream([track]);
  const play = () => node.play().catch(() => {});
  play();
  node.onloadedmetadata = play;
  node.oncanplay = play;
  track.addEventListener('unmute', play);
  return true;
}

async function grabCamera(deviceId = '') {
  return navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true });
}

function watchSpeaking(stream, onChange) {
  if (!stream || !(window.AudioContext || window.webkitAudioContext)) return () => {};
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let speaking = false;
  let since = performance.now();
  const tick = () => {
    analyser.getByteFrequencyData(data);
    let total = 0;
    for (const value of data) total += value;
    const hot = total / data.length > 18;
    const now = performance.now();
    if (hot && !speaking && now - since > 150) {
      speaking = true;
      since = now;
      onChange(true);
    } else if (!hot && speaking && now - since > 300) {
      speaking = false;
      since = now;
      onChange(false);
    }
  };
  const timer = window.setInterval(tick, 75);
  return () => {
    window.clearInterval(timer);
    try { source.disconnect(); analyser.disconnect(); } catch {}
    context.close().catch(() => {});
  };
}

export default function VoiceRoom({
  serverId,
  channel,
  account,
  realtime,
  stream,
  occupants = [],
  stashed = false,
  joining = false,
  onHangUp,
  onNeedMic,
  onStateChange,
  apiRef,
}) {
  const live = Boolean(stream);
  const [asking, setAsking] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [videoPeerIds, setVideoPeerIds] = useState([]);
  const [peerVolumes, setPeerVolumes] = useState(() => {
    try { return JSON.parse(localStorage.getItem(VOLUME_STORAGE) || '{}'); } catch { return {}; }
  });
  const [showVolumeFor, setShowVolumeFor] = useState(null);
  const [devices, setDevices] = useState([]);
  const [micDeviceId, setMicDeviceId] = useState('');
  const [cameraDeviceId, setCameraDeviceId] = useState('');
  const [speakerDeviceId, setSpeakerDeviceId] = useState('');
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [showShelf, setShowShelf] = useState(false);
  const localStreamRef = useRef(null);
  const screenTrackRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const peersRef = useRef(new Map());
  const remoteStreamsRef = useRef(new Map());
  const remoteNodesRef = useRef(new Map());
  const remoteAudioNodesRef = useRef(new Map());
  const pendingIceRef = useRef(new Map());
  const makingOfferRef = useRef(new Map());
  const localVideoRef = useRef(null);
  const localPipRef = useRef(null);
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const cameraRef = useRef(false);
  const sharingRef = useRef(false);
  const speakingRef = useRef(false);
  const speakTimerRef = useRef(0);
  const stateCb = useRef(onStateChange);
  stateCb.current = onStateChange;
  localStreamRef.current = stream || null;

  useEffect(() => {
    if (!live || !navigator.mediaDevices?.enumerateDevices) return undefined;
    const refresh = () => navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {});
    refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
  }, [live]);

  useEffect(() => {
    remoteAudioNodesRef.current.forEach((node, id) => {
      const value = Number(peerVolumes[id]);
      node.volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value / 100)) : 1;
    });
    try { localStorage.setItem(VOLUME_STORAGE, JSON.stringify(peerVolumes)); } catch {}
  }, [peerVolumes]);

  const emitState = (patch = {}) => {
    const next = {
      muted: mutedRef.current,
      deafened: deafenedRef.current,
      camera: cameraRef.current,
      sharing: sharingRef.current,
      speaking: speakingRef.current,
      ...patch,
    };
    mutedRef.current = next.muted;
    deafenedRef.current = next.deafened;
    cameraRef.current = next.camera;
    sharingRef.current = next.sharing;
    speakingRef.current = next.speaking;
    const speakingOnly = Object.keys(patch).length === 1 && 'speaking' in patch;
    if (!speakingOnly) {
      setMuted(next.muted);
      setDeafened(next.deafened);
      setCameraOn(next.camera);
      setSharing(next.sharing);
    }
    setSpeaking(next.speaking);
    const publish = () => {
      const snap = {
        muted: mutedRef.current,
        deafened: deafenedRef.current,
        camera: cameraRef.current,
        sharing: sharingRef.current,
        speaking: speakingRef.current,
      };
      stateCb.current?.(snap);
      hubOf(realtime)?.send?.('voice-state', { serverId, channelId: channel.id, ...snap });
    };
    if (speakingOnly) {
      if (!speakTimerRef.current) {
        speakTimerRef.current = window.setTimeout(() => {
          speakTimerRef.current = 0;
          publish();
        }, 180);
      }
      return;
    }
    if (speakTimerRef.current) {
      window.clearTimeout(speakTimerRef.current);
      speakTimerRef.current = 0;
    }
    publish();
  };

  const applyRemoteAudio = () => {
    const enabled = !deafenedRef.current;
    remoteStreamsRef.current.forEach((item) => {
      item.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    });
  };

  const applyLocalAudio = () => {
    const enabled = !mutedRef.current && !deafenedRef.current;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
  };

  const attachLocalPreview = () => {
    const camera = cameraTrackRef.current;
    const screen = screenTrackRef.current;
    bindVideo(localVideoRef.current, screen || camera, { mirror: Boolean(camera) && !screen });
    bindVideo(localPipRef.current, screen && camera ? camera : null, { mirror: true });
  };

  const syncRemoteMedia = (id) => {
    const remote = remoteStreamsRef.current.get(id);
    const videoNode = remoteNodesRef.current.get(id);
    const audioNode = remoteAudioNodesRef.current.get(id);
    if (remote && videoNode) {
      const videos = remote.getVideoTracks().filter((track) => track.readyState === 'live' && track.enabled && !track.muted);
      if (!videos.length) clearVideo(videoNode);
      else if (!sameTracks(videoNode.srcObject, videos)) videoNode.srcObject = new MediaStream(videos);
      videoNode.muted = true;
      if (videos.length) videoNode.play?.().catch(() => {});
    }
    if (remote && audioNode) {
      const volume = Number(peerVolumes[Number(id)]);
      audioNode.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100)) : 1;
      const audios = remote.getAudioTracks().filter((track) => track.readyState !== 'ended');
      if (!sameTracks(audioNode.srcObject, audios)) audioNode.srcObject = audios.length ? new MediaStream(audios) : null;
      if (audios.length) {
        audioNode.play?.().then(() => setAudioPlaybackBlocked(false)).catch((playError) => {
          if (playError?.name === 'NotAllowedError') setAudioPlaybackBlocked(true);
        });
      }
    }
  };

  useEffect(() => {
    if (!live) return undefined;
    let stopped = false;
    let rtcReady = false;
    let rtcConfig = RTC_CONFIG;
    const selfId = Number(account.id);
    const send = (event, payload) => hubOf(realtime)?.send?.(event, payload);
    const sendSignal = (targetId, signal) => send('voice-signal', { serverId, channelId: channel.id, targetId, signal });
    const markRemoteVideo = (id) => {
      const liveVideo = streamHasLiveVideo(remoteStreamsRef.current.get(id));
      setVideoPeerIds((current) => {
        const has = current.includes(id);
        if (liveVideo === has) return current;
        return liveVideo ? [...current, id] : current.filter((item) => item !== id);
      });
    };
    const attachRemote = (id) => {
      syncRemoteMedia(id);
      markRemoteVideo(id);
      applyRemoteAudio();
    };
    const closePeer = (id) => {
      const peer = peersRef.current.get(id);
      peer?.close();
      peersRef.current.delete(id);
      pendingIceRef.current.delete(id);
      makingOfferRef.current.delete(id);
      remoteStreamsRef.current.delete(id);
      const node = remoteNodesRef.current.get(id);
      if (node) clearVideo(node);
      setVideoPeerIds((current) => current.filter((item) => item !== id));
    };
    const flushIce = async (id, peer) => {
      const queued = pendingIceRef.current.get(id) || [];
      pendingIceRef.current.set(id, []);
      for (const candidate of queued) await peer.addIceCandidate(candidate).catch(() => {});
    };
    const outboundVideo = () => screenTrackRef.current || cameraTrackRef.current || null;
    const makePeer = (participant) => {
      const id = Number(participant.id);
      if (peersRef.current.has(id)) return peersRef.current.get(id);
      const peer = new RTCPeerConnection(rtcConfig);
      const polite = selfId > id;
      peersRef.current.set(id, peer);
      localStreamRef.current?.getAudioTracks().forEach((track) => peer.addTrack(track, localStreamRef.current));
      const video = outboundVideo();
      if (video) peer.addTrack(video, new MediaStream([video]));
      peer.onicecandidate = (event) => {
        if (event.candidate) sendSignal(id, { candidate: toJsonCandidate(event.candidate) });
      };
      peer.ontrack = (event) => {
        let remote = remoteStreamsRef.current.get(id);
        if (!remote) {
          remote = new MediaStream();
          remoteStreamsRef.current.set(id, remote);
        }
        if (!remote.getTracks().includes(event.track)) remote.addTrack(event.track);
        event.track.addEventListener('mute', () => attachRemote(id));
        event.track.addEventListener('unmute', () => attachRemote(id));
        event.track.addEventListener('ended', () => attachRemote(id));
        attachRemote(id);
      };
      peer.oniceconnectionstatechange = () => {
        if (peer.iceConnectionState === 'failed') {
          setError('Voice connection was blocked by the network. Check the firewall or VPN, then leave and rejoin.');
          try { peer.restartIce(); } catch {}
        }
      };
      peer.onnegotiationneeded = async () => {
        try {
          makingOfferRef.current.set(id, true);
          await peer.setLocalDescription(await peer.createOffer());
          sendSignal(id, { description: peer.localDescription });
        } catch {
          setError('Unable to start a voice connection.');
        } finally {
          makingOfferRef.current.set(id, false);
        }
      };
      peer._polite = polite;
      return peer;
    };
    const joinRoom = () => {
      if (!stopped && rtcReady && localStreamRef.current && Number.isFinite(Number(serverId))) {
        send('voice-join', { serverId, channelId: channel.id });
        send('voice-state', {
          serverId,
          channelId: channel.id,
          muted: mutedRef.current,
          deafened: deafenedRef.current,
          camera: cameraRef.current,
          sharing: sharingRef.current,
          speaking: speakingRef.current,
        });
      }
    };
    const handle = async (event, payload) => {
      if (event === 'voice-reconnect') {
        apiRequest('/voice/ice-servers', { retries: 0 }).then((config) => {
          if (Array.isArray(config.iceServers) && config.iceServers.length) rtcConfig = { ...RTC_CONFIG, iceServers: config.iceServers };
        }).catch(() => {}).finally(joinRoom);
        return;
      }
      if (event === 'voice-error' && Number(payload.channelId) === Number(channel.id)) {
        setError(payload.error || 'Unable to join this voice channel.');
        return;
      }
      if (Number(payload.serverId) !== Number(serverId) || Number(payload.channelId) !== Number(channel.id)) return;
      if (event === 'voice-presence') {
        const next = payload.participants || [];
        for (const participant of next) if (Number(participant.id) !== selfId) makePeer(participant);
        if (payload.action === 'left' && payload.participant?.id) closePeer(Number(payload.participant.id));
        const liveIds = new Set(next.map((item) => Number(item.id)));
        for (const id of [...peersRef.current.keys()]) if (!liveIds.has(id)) closePeer(id);
      }
      if (event === 'voice-signal' && Number(payload.fromId) !== selfId && payload.signal) {
        try {
          const fromId = Number(payload.fromId);
          const peer = makePeer({ id: fromId, username: 'Participant' });
          if (payload.signal.description) {
            const description = payload.signal.description;
            const offerCollision = description.type === 'offer' && (makingOfferRef.current.get(fromId) || peer.signalingState !== 'stable');
            if (offerCollision && !peer._polite) return;
            await peer.setRemoteDescription(description);
            await flushIce(fromId, peer);
            if (description.type === 'offer') {
              await peer.setLocalDescription(await peer.createAnswer());
              sendSignal(fromId, { description: peer.localDescription });
            }
          } else if (payload.signal.candidate) {
            if (peer.remoteDescription) await peer.addIceCandidate(payload.signal.candidate).catch(() => {});
            else {
              const queued = pendingIceRef.current.get(fromId) || [];
              queued.push(payload.signal.candidate);
              pendingIceRef.current.set(fromId, queued);
            }
          }
        } catch {
          setError('Voice connection failed. Leave and rejoin if audio drops.');
        }
      }
    };
    const hub = hubOf(realtime);
    if (hub) hub.onVoice = handle;
    apiRequest('/voice/ice-servers', { retries: 0 }).then((config) => {
      if (Array.isArray(config.iceServers) && config.iceServers.length) rtcConfig = { ...RTC_CONFIG, iceServers: config.iceServers };
    }).catch(() => {}).finally(() => {
      if (stopped) return;
      rtcReady = true;
      applyLocalAudio();
      attachLocalPreview();
      joinRoom();
    });
    const heartbeat = window.setInterval(joinRoom, 8000);
    let stopSpeak = () => {};
    const speakDelay = window.setTimeout(() => {
      stopSpeak = watchSpeaking(localStreamRef.current, (value) => {
        if (mutedRef.current || deafenedRef.current) {
          if (speakingRef.current) emitState({ speaking: false });
          return;
        }
        if (speakingRef.current !== value) emitState({ speaking: value });
      });
    }, 350);
    return () => {
      stopped = true;
      window.clearInterval(heartbeat);
      window.clearTimeout(speakDelay);
      stopSpeak();
      if (speakTimerRef.current) window.clearTimeout(speakTimerRef.current);
      send('voice-leave', { serverId, channelId: channel.id });
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
      if (hubOf(realtime)?.onVoice === handle) hubOf(realtime).onVoice = null;
    };
  }, [account.id, channel.id, live, realtime, serverId]);

  const enableRemoteAudio = () => {
    const playPromises = [...remoteAudioNodesRef.current.values()].map((node) => node.play?.().then(() => true).catch(() => false) ?? Promise.resolve(false));
    Promise.all(playPromises).then((results) => setAudioPlaybackBlocked(results.some((result) => !result)));
  };

  useEffect(() => {
    if (!stashed) attachLocalPreview();
  }, [cameraOn, sharing, stashed]);

  const replaceVideo = (track) => {
    peersRef.current.forEach((peer) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
      if (sender) {
        sender.replaceTrack(track).catch(() => {});
        if (track) tuneVideoSender(sender);
      } else if (track) {
        peer.addTrack(track, new MediaStream([track]));
      }
    });
    attachLocalPreview();
  };

  const toggleMute = () => {
    const next = !mutedRef.current;
    emitState({ muted: next, speaking: next || deafenedRef.current ? false : speakingRef.current });
    applyLocalAudio();
  };

  const toggleDeafen = () => {
    const next = !deafenedRef.current;
    emitState({ deafened: next, muted: next ? true : mutedRef.current, speaking: false });
    applyLocalAudio();
    applyRemoteAudio();
  };

  const changeMicrophone = async (deviceId) => {
    if (!localStreamRef.current) return;
    try {
      const replacement = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
      const track = replacement.getAudioTracks()[0];
      const current = localStreamRef.current.getAudioTracks()[0];
      track.enabled = !mutedRef.current && !deafenedRef.current;
      try {
        await Promise.all([...peersRef.current.values()].map(async (peer) => {
          const sender = peer.getSenders().find((item) => item.track?.kind === 'audio');
          if (sender) await sender.replaceTrack(track);
          else peer.addTrack(track, localStreamRef.current);
        }));
        if (current) localStreamRef.current.removeTrack(current);
        localStreamRef.current.addTrack(track);
        current?.stop();
        setMicDeviceId(deviceId);
        setError('');
      } catch (error) {
        replacement.getTracks().forEach((item) => item.stop());
        throw error;
      }
    } catch (error) { setError(`Microphone change failed: ${error.message}`); }
  };

  const changeCamera = async (deviceId) => {
    if (!cameraRef.current) { setCameraDeviceId(deviceId); return; }
    setCameraBusy(true);
    try {
      const replacement = await grabCamera(deviceId);
      const track = replacement.getVideoTracks()[0];
      if (!track) throw new Error('No camera track');
      const previous = cameraTrackRef.current;
      cameraTrackRef.current = track;
      if (!screenTrackRef.current) replaceVideo(track);
      else attachLocalPreview();
      previous?.stop();
      setCameraDeviceId(deviceId);
      setError('');
    } catch (error) { setError(`Camera change failed: ${error.message}`); }
    finally { setCameraBusy(false); }
  };

  const changeSpeaker = async (deviceId) => {
    try {
      await Promise.all([...remoteAudioNodesRef.current.values()].map((node) => node.setSinkId(deviceId)));
      setSpeakerDeviceId(deviceId);
      setError('');
    } catch (error) { setError(`Speaker change failed: ${error.message}`); }
  };

  const toggleCamera = async () => {
    if (!localStreamRef.current || cameraBusy) return;
    if (cameraRef.current) {
      cameraTrackRef.current?.stop();
      cameraTrackRef.current = null;
      setLocalPlaying(false);
      replaceVideo(screenTrackRef.current || null);
      clearVideo(localVideoRef.current);
      if (!screenTrackRef.current) clearVideo(localPipRef.current);
      emitState({ camera: false });
      return;
    }
    setCameraBusy(true);
    try {
      const camera = await grabCamera(cameraDeviceId);
      const track = camera.getVideoTracks()[0];
      if (!track) throw new Error('No camera track');
      camera.getTracks().forEach((item) => { if (item !== track) item.stop(); });
      cameraTrackRef.current?.stop();
      cameraTrackRef.current = track;
      track.enabled = true;
      try { track.contentHint = 'motion'; } catch {}
      track.onended = () => {
        if (cameraTrackRef.current !== track) return;
        cameraTrackRef.current = null;
        setLocalPlaying(false);
        replaceVideo(screenTrackRef.current || null);
        if (!screenTrackRef.current) clearVideo(localVideoRef.current);
        emitState({ camera: false });
      };
      emitState({ camera: true });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          attachLocalPreview();
          replaceVideo(screenTrackRef.current || track);
          localVideoRef.current?.play?.().catch(() => {});
        });
      });
      setError('');
    } catch (caught) {
      const name = caught?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') setError('Allow camera access in the browser prompt, then try again.');
      else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') setError('No camera was found.');
      else if (name === 'NotReadableError' || name === 'TrackStartError') setError('Your camera is already in use by another app.');
      else setError('Could not start the camera. Check browser permissions and try again.');
    } finally {
      setCameraBusy(false);
    }
  };

  const stopSharing = () => {
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    clearVideo(localPipRef.current);
    clearVideo(localVideoRef.current);
    replaceVideo(cameraTrackRef.current || null);
    if (cameraTrackRef.current) attachLocalPreview();
    else setLocalPlaying(false);
    emitState({ sharing: false });
  };

  const toggleShare = async () => {
    if (sharingRef.current) {
      stopSharing();
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      screenTrackRef.current?.stop();
      screenTrackRef.current = track;
      replaceVideo(track);
      track.onended = () => {
        if (screenTrackRef.current !== track) return;
        stopSharing();
      };
      emitState({ sharing: true });
      setError('');
    } catch {
      setError('Screen sharing was cancelled or unavailable.');
    }
  };

  const hangUp = () => {
    cameraTrackRef.current?.stop();
    screenTrackRef.current?.stop();
    cameraTrackRef.current = null;
    screenTrackRef.current = null;
    setLocalPlaying(false);
    clearVideo(localVideoRef.current);
    clearVideo(localPipRef.current);
    onHangUp?.();
  };

  const joinVoice = async () => {
    if (asking || live) return;
    setError('');
    setAsking(true);
    try {
      await onNeedMic?.();
    } catch (caught) {
      setError(microphoneError(caught));
    } finally {
      setAsking(false);
    }
  };

  useEffect(() => {
    applyLocalAudio();
  }, [muted, deafened, stream]);

  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = { toggleMute, toggleDeafen, hangUp, toggleCamera, toggleShare };
    return () => { apiRef.current = null; };
  });

  const appScope = live ? channelAppScope(serverId, channel.id) : null;
  const appSend = useCallback((event, payload) => hubOf(realtime)?.send?.(event, payload), [realtime]);
  const bindApps = useCallback((handler) => {
    const hub = hubOf(realtime);
    if (!hub) return () => {};
    hub.onApp = handler;
    return () => { if (hub.onApp === handler) hub.onApp = null; };
  }, [realtime]);
  const apps = useAppSession({ scope: appScope, accountId: account?.id, send: appSend, bind: bindApps, active: live });
  const appsLive = Boolean(apps.session);
  const appsOpen = Boolean(apps.joined && apps.appId);

  useEffect(() => {
    if (!appsLive) setShowShelf(false);
  }, [appsLive]);

  const joiningCall = asking || joining;
  const selfFlags = { muted, deafened, camera: cameraOn, sharing, speaking };
  const roster = (() => {
    if (!live) return occupants;
    const selfId = Number(account.id);
    const next = occupants.length ? occupants.map((item) => (Number(item.id) === selfId ? { ...item, ...selfFlags } : item)) : [];
    if (!next.some((item) => Number(item.id) === selfId)) next.unshift({ ...account, ...selfFlags });
    return next;
  })();
  const showLocalVideo = cameraOn || sharing;

  return (
    <section className={`community-voice-room${stashed ? ' is-stashed' : ''}`} aria-label={`Voice chat in ${channel.name}`} aria-hidden={stashed || undefined}>
      <header>
        <h1><SpeakerIcon /> {channel.name}</h1>
        <span className="community-voice-count">{live ? `${roster.length} in call` : 'Voice'}</span>
      </header>
      {error ? <p className="community-voice-error" role="alert">{error}</p> : null}
      {audioPlaybackBlocked ? <p className="community-voice-error" role="status">Your browser blocked voice playback. <button type="button" onClick={enableRemoteAudio}>Enable audio</button></p> : null}
      {!live ? (
        <div className="community-voice-lobby">
          <CommunityAvatar user={account} />
          <p>{joiningCall ? 'Connecting to voice…' : 'Join and allow microphone access when your browser asks.'}</p>
          <button type="button" onClick={joinVoice} disabled={joiningCall}>{joiningCall ? 'Connecting…' : 'Join Voice'}</button>
        </div>
      ) : (
        <>
          {appsOpen ? (
            <AppStage
              appId={apps.appId}
              scopeKey={apps.scopeKey}
              session={apps.session}
              snapshot={apps.snapshot}
              state={apps.state}
              isHost={apps.isHost}
              accountId={account?.id}
              sendOp={apps.sendOp}
              subscribeOps={apps.subscribeOps}
              onLeave={apps.leave}
              onEnd={apps.end}
              error={apps.error}
            />
          ) : appsLive ? (
            <div className="glean-app-banner">
              <span><strong>{apps.session.appName}</strong> is live · {apps.session.participantCount} in app</span>
              <button type="button" onClick={apps.join}>Join</button>
            </div>
          ) : null}
          <div className={`community-voice-grid count-${Math.min(roster.length, 9)}${appsOpen ? ' is-strip' : ''}`}>
            {roster.map((participant) => {
              const self = Number(participant.id) === Number(account.id);
              const hasVideo = self ? showLocalVideo : videoPeerIds.includes(Number(participant.id));
              const showPip = self && cameraOn && sharing;
              return (
                <article
                  className={`community-voice-tile${self ? ' is-local' : ''}${hasVideo ? ' has-video' : ''}${self && localPlaying ? ' is-playing' : ''}${participant.speaking ? ' is-speaking' : ''}${participant.sharing ? ' is-sharing' : ''}`}
                  key={participant.id}
                >
                  <video
                    autoPlay
                    playsInline
                    muted
                    onPlaying={() => {
                      if (self) setLocalPlaying(true);
                      else setVideoPeerIds((current) => current.includes(Number(participant.id)) ? current : [...current, Number(participant.id)]);
                    }}
                    ref={(node) => {
                      if (self) {
                        localVideoRef.current = node;
                        if (node && (cameraTrackRef.current || screenTrackRef.current)) attachLocalPreview();
                        return;
                      }
                      if (node) {
                        remoteNodesRef.current.set(Number(participant.id), node);
                        syncRemoteMedia(Number(participant.id));
                      } else remoteNodesRef.current.delete(Number(participant.id));
                    }}
                  />
                  {self ? null : (
                    <audio
                      autoPlay
                      ref={(node) => {
                        if (node) {
                          remoteAudioNodesRef.current.set(Number(participant.id), node);
                          if (speakerDeviceId && node.setSinkId) node.setSinkId(speakerDeviceId).catch(() => {});
                          syncRemoteMedia(Number(participant.id));
                        } else remoteAudioNodesRef.current.delete(Number(participant.id));
                      }}
                    />
                  )}
                  {showPip ? <video className="community-voice-pip" autoPlay playsInline muted ref={(node) => { if (localPipRef.current !== node) { localPipRef.current = node; attachLocalPreview(); } }} /> : null}
                  <CommunityAvatar user={participant} />
                  <strong>{participant.username}{self ? ' (you)' : ''}</strong>
                  <VoiceBadges user={participant} />
                  {!self ? <div className="community-voice-volume-control" onPointerDown={(event) => event.stopPropagation()}>
                    <button type="button" aria-label={`Adjust ${participant.username} volume`} aria-expanded={showVolumeFor === Number(participant.id)} onClick={() => setShowVolumeFor((current) => current === Number(participant.id) ? null : Number(participant.id))}>
                      <SpeakerIcon />
                    </button>
                    {showVolumeFor === Number(participant.id) ? <label className="community-voice-volume">
                      <span>Volume {peerVolumes[participant.id] ?? 100}%</span>
                      <input type="range" min="0" max="100" value={peerVolumes[participant.id] ?? 100} aria-label={`${participant.username} volume`} onChange={(event) => setPeerVolumes((current) => ({ ...current, [participant.id]: Number(event.target.value) }))} />
                    </label> : null}
                  </div> : null}
                </article>
              );
            })}
          </div>
          {showDeviceSettings ? <div className="community-voice-device-settings">
            <label>Microphone <select value={micDeviceId} onChange={(event) => changeMicrophone(event.target.value)}><option value="">Default</option>{devices.filter((item) => item.kind === 'audioinput').map((item) => <option key={item.deviceId} value={item.deviceId}>{item.label || 'Microphone'}</option>)}</select></label>
            <label>Camera <select value={cameraDeviceId} onChange={(event) => changeCamera(event.target.value)}><option value="">Default</option>{devices.filter((item) => item.kind === 'videoinput').map((item) => <option key={item.deviceId} value={item.deviceId}>{item.label || 'Camera'}</option>)}</select></label>
            {typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype ? <label>Speaker <select value={speakerDeviceId} onChange={(event) => changeSpeaker(event.target.value)}><option value="">Default</option>{devices.filter((item) => item.kind === 'audiooutput').map((item) => <option key={item.deviceId} value={item.deviceId}>{item.label || 'Speaker'}</option>)}</select></label> : null}
          </div> : null}
          <footer className="community-voice-controls">
            <button type="button" aria-expanded={showDeviceSettings} onClick={() => setShowDeviceSettings((value) => !value)}><span>Devices</span></button>
            <button type="button" aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
              {muted ? <MicOffIcon /> : <MicIcon />}
              <span>{muted ? 'Unmute' : 'Mute'}</span>
            </button>
            <button type="button" aria-pressed={deafened} aria-label={deafened ? 'Undeafen' : 'Deafen'} onClick={toggleDeafen}>
              <HeadphonesIcon />
              <span>{deafened ? 'Listen' : 'Deafen'}</span>
            </button>
            <button className="is-media" type="button" aria-pressed={cameraOn} aria-busy={cameraBusy || undefined} aria-label={cameraOn ? 'Camera off' : 'Camera on'} onClick={toggleCamera} disabled={cameraBusy}>
              <VideoIcon />
              <span>Camera</span>
            </button>
            <button className="is-media" type="button" aria-pressed={sharing} aria-label={sharing ? 'Stop sharing' : 'Share screen'} onClick={toggleShare}>
              <ScreenIcon />
              <span>Share</span>
            </button>
            <button
              className={`community-apps-button${appsLive ? ' is-live' : ''}`}
              type="button"
              aria-pressed={showShelf}
              aria-label="Apps"
              onClick={() => setShowShelf((current) => !current)}
            >
              <RocketIcon />
              <span>Apps</span>
            </button>
            <button className="is-danger" type="button" aria-label="Disconnect" onClick={hangUp}>
              <PhoneOffIcon />
              <span>Leave</span>
            </button>
          </footer>
          {showShelf ? (
            <AppShelf
              session={apps.session}
              error={apps.error}
              onLaunch={(id) => { apps.start(id); setShowShelf(false); }}
              onJoin={() => { apps.join(); setShowShelf(false); }}
              onClose={() => setShowShelf(false)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
