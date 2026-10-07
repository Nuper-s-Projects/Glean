import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { subscribeToDmEvents } from '../../app/dmApi';
import { apiRequest } from '../../app/apiClient';
import { CommunityAvatar } from '../community/CommunityAvatar';
import { VoiceBadges } from '../community/VoiceBits';
import VoiceDock from '../community/VoiceDock';
import GleanButton from './GleanButton';
import DisplayName from './DisplayName';
import { ChevronLeftIcon, HeadphonesIcon, MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon, RocketIcon, ScreenIcon, SpeakerIcon, VideoIcon } from './icons';
import AppShelf from '../apps/AppShelf';
import AppStage from '../apps/AppStage';
import useAppSession from '../apps/useAppSession';
import { dmAppScope } from '../apps/catalog';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }],
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

const IDLE = { status: 'idle', conversationId: null, peer: null, video: false, error: '' };
const PEER_IDLE = { muted: false, deafened: false, camera: false, sharing: false, speaking: false };

const DmCallContext = createContext({
  call: IDLE,
  startCall: () => {},
  accept: () => {},
  decline: () => {},
  hangup: () => {},
  registerSlot: () => {},
});

export function useDmCall() {
  return useContext(DmCallContext);
}

export function DmCallSlot({ conversationId, onBack }) {
  const { registerSlot } = useDmCall();
  const ref = useRef(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useLayoutEffect(() => {
    registerSlot(conversationId, ref.current, () => onBackRef.current?.());
    return () => registerSlot(conversationId, null);
  }, [conversationId, registerSlot]);
  return <div className="dm-call-slot" ref={ref} />;
}

function toJsonCandidate(candidate) {
  return candidate?.toJSON ? candidate.toJSON() : candidate;
}

function microphoneError(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Allow microphone access, then try again.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'Your microphone is already in use.';
  if (name === 'SecurityError') return 'This page is not allowed to use the microphone.';
  return 'Microphone access is required to start a call.';
}

function clearVideo(node) {
  if (!node) return;
  node.pause();
  node.srcObject = null;
  node.removeAttribute('src');
  try { node.load(); } catch {}
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

async function grabCamera() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  }
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

function dockHostNode() {
  return document.querySelector('[data-voice-dock-host]');
}

export function DmCallProvider({ account, children }) {
  const [call, setCall] = useState(IDLE);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [peerFlags, setPeerFlags] = useState(PEER_IDLE);
  const [slot, setSlot] = useState({ id: null, node: null, onBack: null });
  const [dockHost, setDockHost] = useState(null);
  const callRef = useRef(IDLE);
  const sendRef = useRef(() => {});
  const appHandlerRef = useRef(null);
  const peerRef = useRef(null);
  const peerSetupRef = useRef(null);
  const peerGenerationRef = useRef(0);
  const signalQueueRef = useRef(Promise.resolve());
  const localStreamRef = useRef(null);
  const micRequestRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const localVideoRef = useRef(null);
  const localPipRef = useRef(null);
  const makingOfferRef = useRef(false);
  const pendingIceRef = useRef([]);
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const cameraRef = useRef(false);
  const sharingRef = useRef(false);
  const speakingRef = useRef(false);
  const speakTimerRef = useRef(0);
  const accountId = Number(account?.id);

  callRef.current = call;
  mutedRef.current = muted;
  deafenedRef.current = deafened;
  cameraRef.current = cameraOn;
  sharingRef.current = sharing;
  speakingRef.current = speaking;

  const registerSlot = useCallback((id, node, onBack) => {
    setSlot((current) => {
      if (!node) {
        if (Number(current.id) !== Number(id)) return current;
        return { id: null, node: null, onBack: null };
      }
      if (current.node === node && Number(current.id) === Number(id) && current.onBack === onBack) return current;
      return { id, node, onBack };
    });
  }, []);

  const applyRemoteAudio = useCallback(() => {
    const enabled = !deafenedRef.current;
    remoteStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    if (remoteAudioRef.current) remoteAudioRef.current.muted = !enabled;
  }, []);

  const applyLocalAudio = useCallback(() => {
    const enabled = !mutedRef.current && !deafenedRef.current;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
  }, []);

  const attachLocalPreview = useCallback(() => {
    const camera = cameraTrackRef.current;
    const screen = screenTrackRef.current;
    bindVideo(localVideoRef.current, screen || camera, { mirror: Boolean(camera) && !screen });
    bindVideo(localPipRef.current, screen && camera ? camera : null, { mirror: true });
  }, []);

  const attachRemote = useCallback(() => {
    const remote = remoteStreamRef.current;
    const videoNode = remoteVideoRef.current;
    const audioNode = remoteAudioRef.current;
    if (remote && videoNode) {
      const videos = remote.getVideoTracks().filter((track) => track.readyState === 'live' && track.enabled && !track.muted);
      if (!videos.length) clearVideo(videoNode);
      else if (!sameTracks(videoNode.srcObject, videos)) videoNode.srcObject = new MediaStream(videos);
      videoNode.muted = true;
      if (videos.length) videoNode.play?.().catch(() => {});
    }
    if (remote && audioNode) {
      const audios = remote.getAudioTracks().filter((track) => track.readyState !== 'ended');
      if (!sameTracks(audioNode.srcObject, audios)) audioNode.srcObject = audios.length ? new MediaStream(audios) : null;
      audioNode.muted = deafenedRef.current;
      if (audios.length) audioNode.play?.().catch(() => {});
    }
    setRemoteHasVideo(streamHasLiveVideo(remote));
    applyRemoteAudio();
  }, [applyRemoteAudio]);

  const stopLocal = useCallback(() => {
    if (micRequestRef.current) {
      micRequestRef.current.cancelled = true;
      micRequestRef.current = null;
    }
    cameraTrackRef.current?.stop();
    cameraTrackRef.current = null;
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    clearVideo(remoteVideoRef.current);
    clearVideo(localVideoRef.current);
    clearVideo(localPipRef.current);
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setCameraOn(false);
    setSharing(false);
    setMuted(false);
    setDeafened(false);
    setSpeaking(false);
    setLocalPlaying(false);
    setRemoteHasVideo(false);
    setPeerFlags(PEER_IDLE);
    mutedRef.current = false;
    deafenedRef.current = false;
    cameraRef.current = false;
    sharingRef.current = false;
    speakingRef.current = false;
  }, []);

  const closePeer = useCallback(() => {
    peerGenerationRef.current += 1;
    peerSetupRef.current = null;
    signalQueueRef.current = Promise.resolve();
    try { peerRef.current?.close(); } catch {}
    peerRef.current = null;
    makingOfferRef.current = false;
    pendingIceRef.current = [];
  }, []);

  const resetCall = useCallback((error = '') => {
    closePeer();
    stopLocal();
    const next = error ? { ...IDLE, error } : IDLE;
    callRef.current = next;
    setCall(next);
  }, [closePeer, stopLocal]);

  const sendSignal = useCallback((signal) => {
    const current = callRef.current;
    if (!current.conversationId) return;
    sendRef.current('dm-call-signal', { conversationId: current.conversationId, signal });
  }, []);

  const publishState = useCallback((patch = {}) => {
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
    const snap = {
      muted: mutedRef.current,
      deafened: deafenedRef.current,
      camera: cameraRef.current,
      sharing: sharingRef.current,
      speaking: speakingRef.current,
    };
    const publish = () => sendSignal({ state: snap });
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
  }, [sendSignal]);

  const ensureMic = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    if (micRequestRef.current) return micRequestRef.current.promise;
    window.dispatchEvent(new Event('glean-leave-voice'));
    const request = { cancelled: false, promise: null };
    request.promise = navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then((stream) => {
      if (request.cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        throw new DOMException('Microphone request was cancelled.', 'AbortError');
      }
      localStreamRef.current = stream;
      applyLocalAudio();
      return stream;
    }).finally(() => {
      if (micRequestRef.current === request) micRequestRef.current = null;
    });
    micRequestRef.current = request;
    return request.promise;
  }, [applyLocalAudio]);

  const flushIce = useCallback(async (peer) => {
    const queued = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const candidate of queued) {
      try { await peer.addIceCandidate(candidate); } catch {}
    }
  }, []);

  const outboundVideo = useCallback(() => screenTrackRef.current || cameraTrackRef.current || null, []);

  const replaceVideo = useCallback((track) => {
    const peer = peerRef.current;
    if (!peer) {
      attachLocalPreview();
      return;
    }
    const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
    if (sender) {
      sender.replaceTrack(track).catch(() => {});
      if (track) tuneVideoSender(sender);
    } else if (track) {
      peer.addTrack(track, new MediaStream([track]));
    }
    attachLocalPreview();
  }, [attachLocalPreview]);

  const startRtc = useCallback(async (peerUser, selfId) => {
    if (peerRef.current) return peerRef.current;
    if (peerSetupRef.current) return peerSetupRef.current;
    const generation = peerGenerationRef.current;
    const setup = (async () => {
    const [stream, network] = await Promise.all([
      ensureMic(),
      apiRequest('/voice/ice-servers', { timeoutMs: 10000 }),
    ]);
    if (generation !== peerGenerationRef.current) throw new DOMException('Call ended.', 'AbortError');
    if (!Array.isArray(network.iceServers) || !network.iceServers.length) throw new Error('Voice network settings are unavailable. Try again.');
    const peer = new RTCPeerConnection({ ...RTC_CONFIG, iceServers: network.iceServers });
    peerRef.current = peer;
    const polite = Number(selfId) > Number(peerUser.id);
    peer._polite = polite;
    peer._initialOfferer = callRef.current.role === 'caller';
    peer._ignoreOffer = false;
    peer._settingRemoteAnswer = false;
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    const video = outboundVideo();
    if (video) peer.addTrack(video, new MediaStream([video]));
    peer.onicecandidate = (event) => {
      if (peerRef.current === peer && event.candidate) sendSignal({ candidate: toJsonCandidate(event.candidate) });
    };
    peer.oniceconnectionstatechange = () => {
      if (peerRef.current !== peer) return;
      if (peer.iceConnectionState === 'failed') {
        peer.restartIce();
        setCall((current) => ({ ...current, error: 'Reconnecting the call…' }));
      } else if (['connected', 'completed'].includes(peer.iceConnectionState)) {
        setCall((current) => ({ ...current, error: '' }));
      }
    };
    peer.ontrack = (event) => {
      let remote = remoteStreamRef.current;
      if (!remote) {
        remote = new MediaStream();
        remoteStreamRef.current = remote;
      }
      if (!remote.getTracks().includes(event.track)) remote.addTrack(event.track);
      event.track.addEventListener('mute', attachRemote);
      event.track.addEventListener('unmute', attachRemote);
      event.track.addEventListener('ended', attachRemote);
      attachRemote();
    };
    peer.onnegotiationneeded = async () => {
      if (peerRef.current !== peer || peer.signalingState !== 'stable' || makingOfferRef.current) return;
      if (!peer._initialOfferer && !peer.remoteDescription) return;
      try {
        makingOfferRef.current = true;
        await peer.setLocalDescription(await peer.createOffer());
        if (peerRef.current === peer) sendSignal({ description: peer.localDescription });
      } catch {
        if (peerRef.current === peer) setCall((current) => ({ ...current, error: 'Unable to start the call connection.' }));
      } finally {
        if (peerRef.current === peer) makingOfferRef.current = false;
      }
    };
    return peer;
    })();
    peerSetupRef.current = setup;
    try { return await setup; }
    finally { if (peerSetupRef.current === setup) peerSetupRef.current = null; }
  }, [attachRemote, ensureMic, outboundVideo, sendSignal]);

  const handleSignal = useCallback(async (payload) => {
    const current = callRef.current;
    if (Number(payload.conversationId) !== Number(current.conversationId) || !payload.signal) return;
    if (payload.signal.state) {
      setPeerFlags((flags) => ({ ...flags, ...payload.signal.state }));
      return;
    }
    let peer = peerRef.current;
    if (!peer) {
      if (!current.peer) return;
      peer = await startRtc(current.peer, accountId);
    }
    if (peerRef.current !== peer || Number(callRef.current.conversationId) !== Number(payload.conversationId)) return;
    try {
      if (payload.signal.description) {
        const description = payload.signal.description;
        const readyForOffer = !makingOfferRef.current && (peer.signalingState === 'stable' || peer._settingRemoteAnswer);
        const offerCollision = description.type === 'offer' && !readyForOffer;
        peer._ignoreOffer = offerCollision && !peer._polite;
        if (peer._ignoreOffer) return;
        peer._settingRemoteAnswer = description.type === 'answer';
        try { await peer.setRemoteDescription(description); }
        finally { peer._settingRemoteAnswer = false; }
        await flushIce(peer);
        if (description.type === 'offer') {
          await peer.setLocalDescription(await peer.createAnswer());
          sendSignal({ description: peer.localDescription });
        }
      } else if (payload.signal.candidate) {
        if (peer._ignoreOffer) return;
        if (peer.remoteDescription) await peer.addIceCandidate(payload.signal.candidate).catch(() => {});
        else pendingIceRef.current.push(payload.signal.candidate);
      }
    } catch {
      setCall((currentCall) => ({ ...currentCall, error: 'Call connection failed.' }));
    }
  }, [accountId, flushIce, sendSignal, startRtc]);

  useEffect(() => {
    if (!accountId) {
      sendRef.current = () => {};
      resetCall();
      return undefined;
    }
    const connection = subscribeToDmEvents((eventName, payload) => {
      if (eventName === 'dm-call-invite') {
        const conversationId = Number(payload.conversationId);
        if (!conversationId) return;
        if (payload.role === 'caller') {
          setCall({
            status: 'outgoing',
            conversationId,
            peer: payload.peer || callRef.current.peer,
            video: Boolean(payload.video),
            error: '',
          });
          return;
        }
        if (callRef.current.status === 'active' || callRef.current.status === 'outgoing') return;
        setCall({
          status: 'incoming',
          conversationId,
          peer: payload.peer,
          video: Boolean(payload.video),
          error: '',
        });
        return;
      }
      if (eventName === 'dm-call-accepted') {
        const conversationId = Number(payload.conversationId);
        if (Number(callRef.current.conversationId) !== conversationId && payload.role !== 'callee') return;
        const accepted = {
          ...callRef.current,
          status: 'active',
          conversationId,
          role: payload.role,
          peer: payload.peer || callRef.current.peer,
          error: '',
        };
        callRef.current = accepted;
        setCall(accepted);
        const peerUser = payload.peer || callRef.current.peer;
        if (peerUser) startRtc(peerUser, accountId).catch((error) => {
          if (Number(callRef.current.conversationId) === conversationId && error.name !== 'AbortError') {
            setCall((current) => ({ ...current, error: microphoneError(error) }));
          }
        });
        return;
      }
      if (eventName === 'dm-call-signal') {
        const generation = peerGenerationRef.current;
        signalQueueRef.current = signalQueueRef.current.then(() => {
          if (generation === peerGenerationRef.current) return handleSignal(payload);
        }).catch((error) => {
          if (generation === peerGenerationRef.current && error.name !== 'AbortError') {
            setCall((current) => ({ ...current, error: error.message || 'Call connection failed.' }));
          }
        });
        return;
      }
      if (eventName === 'dm-call-ended') {
        if (Number(payload.conversationId) !== Number(callRef.current.conversationId) && callRef.current.status === 'idle') return;
        const reason = payload.reason;
        const error = reason === 'timeout' ? 'No answer.'
          : reason === 'declined' ? 'Call declined.'
          : reason === 'busy' ? 'They are already in a call.'
          : reason === 'blocked' ? "You can't call this person."
          : '';
        resetCall(error);
        return;
      }
      if (eventName.startsWith('app-')) {
        appHandlerRef.current?.(eventName, payload);
        return;
      }
      if (eventName === 'dm-call-error') {
        setCall((current) => ({ ...current, error: payload.error || 'Unable to start that call.' }));
        if (callRef.current.status === 'outgoing' || callRef.current.status === 'idle') {
          window.setTimeout(() => {
            if (callRef.current.status !== 'active') resetCall(payload.error || '');
          }, 1600);
        }
      }
    }, () => {}, accountId);
    sendRef.current = connection.send;
    return () => {
      sendRef.current = () => {};
      connection.close();
      resetCall();
    };
  }, [accountId, handleSignal, resetCall, startRtc]);

  useEffect(() => {
    const live = call.status === 'outgoing' || call.status === 'active';
    if (!live) return undefined;
    attachRemote();
    attachLocalPreview();
    applyLocalAudio();
    applyRemoteAudio();
  }, [applyLocalAudio, applyRemoteAudio, attachLocalPreview, attachRemote, call.status, cameraOn, remoteHasVideo, sharing, deafened]);

  useEffect(() => {
    if (call.status !== 'outgoing' && call.status !== 'active') return undefined;
    let stopSpeak = () => {};
    const delay = window.setTimeout(() => {
      stopSpeak = watchSpeaking(localStreamRef.current, (value) => {
        if (mutedRef.current || deafenedRef.current) {
          if (speakingRef.current) publishState({ speaking: false });
          return;
        }
        if (speakingRef.current !== value) publishState({ speaking: value });
      });
    }, 350);
    return () => {
      window.clearTimeout(delay);
      stopSpeak();
      if (speakTimerRef.current) window.clearTimeout(speakTimerRef.current);
    };
  }, [call.status, publishState]);

  useLayoutEffect(() => {
    setDockHost(dockHostNode());
  });

  const hangup = useCallback(() => {
    const current = callRef.current;
    if (current.conversationId) sendRef.current('dm-call-hangup', { conversationId: current.conversationId });
    resetCall();
  }, [resetCall]);

  const startCall = useCallback(async (conversation, { video = false } = {}) => {
    const conversationId = Number(conversation?.id);
    if (!conversationId || conversation?.blocked) return;
    const current = callRef.current;
    if (current.status !== 'idle' && Number(current.conversationId) === conversationId) {
      if (current.status === 'incoming') return;
      hangup();
      return;
    }
    if (current.status === 'incoming' || current.status === 'active' || current.status === 'outgoing') hangup();
    const nextCall = {
      status: 'outgoing',
      conversationId,
      peer: conversation.user,
      video: Boolean(video),
      error: '',
    };
    callRef.current = nextCall;
    setCall(nextCall);
    sendRef.current('dm-call-invite', { conversationId, video: Boolean(video) });
    ensureMic().catch((error) => {
      const latest = callRef.current;
      if (Number(latest.conversationId) !== conversationId || (latest.status !== 'outgoing' && latest.status !== 'active')) return;
      sendRef.current('dm-call-hangup', { conversationId });
      resetCall(microphoneError(error));
    });
  }, [ensureMic, hangup, resetCall]);

  const accept = useCallback(async () => {
    const current = callRef.current;
    if (current.status !== 'incoming' || !current.conversationId) return;
    const conversationId = current.conversationId;
    const nextCall = { ...current, status: 'outgoing', error: '' };
    callRef.current = nextCall;
    setCall(nextCall);
    sendRef.current('dm-call-accept', { conversationId });
    window.dispatchEvent(new CustomEvent('glean-open-dm', { detail: { conversationId } }));
    ensureMic().catch((error) => {
      const latest = callRef.current;
      if (Number(latest.conversationId) !== Number(conversationId) || (latest.status !== 'outgoing' && latest.status !== 'active')) return;
      sendRef.current('dm-call-hangup', { conversationId });
      resetCall(microphoneError(error));
    });
  }, [ensureMic, resetCall]);

  const decline = useCallback(() => {
    const current = callRef.current;
    if (current.conversationId) sendRef.current('dm-call-decline', { conversationId: current.conversationId });
    resetCall();
  }, [resetCall]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    publishState({ muted: next, speaking: next || deafenedRef.current ? false : speakingRef.current });
    applyLocalAudio();
  }, [applyLocalAudio, publishState]);

  const toggleDeafen = useCallback(() => {
    const next = !deafenedRef.current;
    publishState({ deafened: next, muted: next ? true : mutedRef.current, speaking: false });
    applyLocalAudio();
    applyRemoteAudio();
  }, [applyLocalAudio, applyRemoteAudio, publishState]);

  const toggleCamera = useCallback(async () => {
    if (cameraBusy) return;
    if (cameraRef.current) {
      cameraTrackRef.current?.stop();
      cameraTrackRef.current = null;
      setLocalPlaying(false);
      replaceVideo(screenTrackRef.current || null);
      if (!screenTrackRef.current) clearVideo(localVideoRef.current);
      publishState({ camera: false });
      return;
    }
    setCameraBusy(true);
    try {
      const camera = await grabCamera();
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
        publishState({ camera: false });
      };
      publishState({ camera: true });
      window.requestAnimationFrame(() => {
        attachLocalPreview();
        replaceVideo(screenTrackRef.current || track);
      });
    } catch (caught) {
      const name = caught?.name || '';
      const error = name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'Allow camera access, then try again.'
        : name === 'NotFoundError' || name === 'DevicesNotFoundError' ? 'No camera was found.'
        : name === 'NotReadableError' || name === 'TrackStartError' ? 'Your camera is already in use.'
        : 'Could not start the camera.';
      setCall((current) => ({ ...current, error }));
    } finally {
      setCameraBusy(false);
    }
  }, [attachLocalPreview, cameraBusy, publishState, replaceVideo]);

  const stopSharing = useCallback(() => {
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    clearVideo(localPipRef.current);
    clearVideo(localVideoRef.current);
    replaceVideo(cameraTrackRef.current || null);
    if (cameraTrackRef.current) attachLocalPreview();
    else setLocalPlaying(false);
    publishState({ sharing: false });
  }, [attachLocalPreview, publishState, replaceVideo]);

  const toggleShare = useCallback(async () => {
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
      publishState({ sharing: true });
    } catch {
      setCall((current) => ({ ...current, error: 'Screen sharing was cancelled or unavailable.' }));
    }
  }, [publishState, replaceVideo, stopSharing]);

  const appScope = call.status === 'active' ? dmAppScope(call.conversationId) : null;
  const appSend = useCallback((event, payload) => sendRef.current?.(event, payload), []);
  const bindApps = useCallback((handler) => {
    appHandlerRef.current = handler;
    return () => { if (appHandlerRef.current === handler) appHandlerRef.current = null; };
  }, []);
  const apps = useAppSession({
    scope: appScope,
    accountId: account?.id,
    send: appSend,
    bind: bindApps,
    active: call.status === 'active',
  });

  const value = useMemo(() => ({ call, startCall, accept, decline, hangup, registerSlot }), [accept, call, decline, hangup, registerSlot, startCall]);
  const inSlot = Boolean(slot.node && Number(slot.id) === Number(call.conversationId) && (call.status === 'outgoing' || call.status === 'active'));
  const live = call.status === 'outgoing' || call.status === 'active';
  const room = live ? (
    <DmCallRoom
      account={account}
      apps={apps}
      call={call}
      muted={muted}
      deafened={deafened}
      cameraOn={cameraOn}
      sharing={sharing}
      speaking={speaking}
      cameraBusy={cameraBusy}
      localPlaying={localPlaying}
      remoteHasVideo={remoteHasVideo}
      peerFlags={peerFlags}
      stashed={!inSlot}
      onBack={inSlot ? slot.onBack : null}
      onMute={toggleMute}
      onDeafen={toggleDeafen}
      onCamera={toggleCamera}
      onShare={toggleShare}
      onHangup={hangup}
      onLocalPlaying={setLocalPlaying}
      onRemoteVideo={setRemoteHasVideo}
      localVideoRef={localVideoRef}
      localPipRef={localPipRef}
      remoteVideoRef={remoteVideoRef}
      remoteAudioRef={remoteAudioRef}
      attachLocalPreview={attachLocalPreview}
      attachRemote={attachRemote}
    />
  ) : null;

  return (
    <DmCallContext.Provider value={value}>
      {children}
      {room && inSlot ? createPortal(room, slot.node) : room}
      {account && call.status === 'incoming' ? createPortal(
        <DmCallIncoming call={call} onAccept={accept} onDecline={decline} />,
        document.body,
      ) : null}
      {account && live && !inSlot ? createPortal(
        <VoiceDock
          channel={{ name: call.peer?.username || 'Voice' }}
          muted={muted}
          deafened={deafened}
          camera={cameraOn}
          sharing={sharing}
          onReturn={() => window.dispatchEvent(new CustomEvent('glean-open-dm', { detail: { conversationId: call.conversationId } }))}
          onMute={toggleMute}
          onDeafen={toggleDeafen}
          onCamera={toggleCamera}
          onShare={toggleShare}
          onDisconnect={hangup}
        />,
        dockHost || document.body,
      ) : null}
    </DmCallContext.Provider>
  );
}

function DmCallIncoming({ call, onAccept, onDecline }) {
  return (
    <div className="dm-call-shell is-ringing" role="dialog" aria-modal="true" aria-label="Incoming call">
      <section className="dm-call-card">
        <div className="community-voice-lobby">
          <CommunityAvatar user={call.peer} interactive={false} />
          <strong><DisplayName user={call.peer} /></strong>
          <p>Incoming call</p>
          {call.error ? <p className="community-voice-error" role="alert">{call.error}</p> : null}
          <div className="dm-call-actions">
            <GleanButton variant="danger" type="button" onClick={onDecline} aria-label="Decline call"><PhoneOffIcon /><span>Decline</span></GleanButton>
            <GleanButton type="button" onClick={onAccept} aria-label="Accept call"><PhoneIcon /><span>Accept</span></GleanButton>
          </div>
        </div>
      </section>
    </div>
  );
}

function DmCallRoom({
  account,
  apps,
  call,
  muted,
  deafened,
  cameraOn,
  sharing,
  speaking,
  cameraBusy,
  localPlaying,
  remoteHasVideo,
  peerFlags,
  stashed,
  onBack,
  onMute,
  onDeafen,
  onCamera,
  onShare,
  onHangup,
  onLocalPlaying,
  onRemoteVideo,
  localVideoRef,
  localPipRef,
  remoteVideoRef,
  remoteAudioRef,
  attachLocalPreview,
  attachRemote,
}) {
  const [showShelf, setShowShelf] = useState(false);
  const selfFlags = { muted, deafened, camera: cameraOn, sharing, speaking };
  const self = { ...account, ...selfFlags };
  const peer = call.peer ? { ...call.peer, ...peerFlags } : null;
  const roster = call.status === 'active' && peer ? [self, peer] : [self];
  const showLocalVideo = cameraOn || sharing;
  const title = call.peer?.username || 'Voice';
  const count = call.status === 'outgoing' ? 'Calling…' : `${roster.length} in call`;
  const appsLive = Boolean(apps?.session);
  const appsOpen = Boolean(apps?.joined && apps.appId);

  useEffect(() => {
    if (!appsLive) setShowShelf(false);
  }, [appsLive]);

  return (
    <section className={`community-voice-room${stashed ? ' is-stashed' : ''}`} aria-label={`Voice chat with ${title}`} aria-hidden={stashed || undefined}>
      <header>
        {onBack ? <button className="glean-nav-back dm-back-button community-mobile-back" type="button" onClick={onBack} aria-label="Back to chats"><ChevronLeftIcon /><span>Chats</span></button> : null}
        <h1><SpeakerIcon /> {title}</h1>
        <span className="community-voice-count">{count}</span>
      </header>
      {call.error ? <p className="community-voice-error" role="alert">{call.error}</p> : null}
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
          const selfTile = Number(participant.id) === Number(account.id);
          const hasVideo = selfTile ? showLocalVideo : remoteHasVideo;
          const showPip = selfTile && cameraOn && sharing;
          return (
            <article
              className={`community-voice-tile${selfTile ? ' is-local' : ''}${hasVideo ? ' has-video' : ''}${selfTile && localPlaying ? ' is-playing' : ''}${participant.speaking ? ' is-speaking' : ''}${participant.sharing ? ' is-sharing' : ''}`}
              key={participant.id}
            >
              <video
                autoPlay
                playsInline
                muted
                onPlaying={() => {
                  if (selfTile) onLocalPlaying(true);
                  else onRemoteVideo(true);
                }}
                ref={(node) => {
                  if (selfTile) {
                    localVideoRef.current = node;
                    if (node) attachLocalPreview();
                    return;
                  }
                  remoteVideoRef.current = node;
                  if (node) attachRemote();
                }}
              />
              {selfTile ? null : (
                <audio
                  autoPlay
                  ref={(node) => {
                    remoteAudioRef.current = node;
                    if (node) attachRemote();
                  }}
                />
              )}
              {showPip ? <video className="community-voice-pip" autoPlay playsInline muted ref={(node) => { localPipRef.current = node; if (node) attachLocalPreview(); }} /> : null}
              <CommunityAvatar user={participant} interactive={false} />
              <strong><DisplayName user={participant} suffix={selfTile ? ' (you)' : ''} /></strong>
              <VoiceBadges user={participant} />
            </article>
          );
        })}
      </div>
      <footer className="community-voice-controls">
        <button type="button" aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} onClick={onMute}>
          {muted ? <MicOffIcon /> : <MicIcon />}
          <span>{muted ? 'Unmute' : 'Mute'}</span>
        </button>
        <button type="button" aria-pressed={deafened} aria-label={deafened ? 'Undeafen' : 'Deafen'} onClick={onDeafen}>
          <HeadphonesIcon />
          <span>{deafened ? 'Listen' : 'Deafen'}</span>
        </button>
        <button className="is-media" type="button" aria-pressed={cameraOn} aria-busy={cameraBusy || undefined} aria-label={cameraOn ? 'Camera off' : 'Camera on'} onClick={onCamera} disabled={cameraBusy}>
          <VideoIcon />
          <span>Camera</span>
        </button>
        <button className="is-media" type="button" aria-pressed={sharing} aria-label={sharing ? 'Stop sharing' : 'Share screen'} onClick={onShare}>
          <ScreenIcon />
          <span>Share</span>
        </button>
        {call.status === 'active' && apps ? (
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
        ) : null}
        <button className="is-danger" type="button" aria-label="Disconnect" onClick={onHangup}>
          <PhoneOffIcon />
          <span>Leave</span>
        </button>
      </footer>
      {showShelf && apps ? (
        <AppShelf
          session={apps.session}
          error={apps.error}
          onLaunch={(id) => { apps.start(id); setShowShelf(false); }}
          onJoin={() => { apps.join(); setShowShelf(false); }}
          onClose={() => setShowShelf(false)}
        />
      ) : null}
    </section>
  );
}
