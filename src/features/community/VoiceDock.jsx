import { HeadphonesIcon, MicIcon, MicOffIcon, PhoneOffIcon, ScreenIcon, VideoIcon } from '../dm/icons';
import './VoiceRoom.css';

export default function VoiceDock({ channel, muted, deafened, camera, sharing, connecting = false, onMute, onDeafen, onCamera, onShare, onDisconnect, onReturn }) {
  return (
    <div className="community-voice-dock">
      <div className="community-voice-dock-info"
        role={onReturn ? 'button' : undefined}
        tabIndex={onReturn ? 0 : undefined}
        onClick={onReturn}
        onKeyDown={onReturn ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onReturn();
          }
        } : undefined}
      >
        <strong><span className="voice-status-dot" />{connecting ? 'Connecting to voice…' : 'Voice connected'}</strong>
        <small>{channel?.name || 'Voice'}</small>
      </div>
      <div className="community-voice-dock-actions">
        <button type="button" disabled={deafened} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} title={deafened ? 'Turn sound on to use your microphone' : muted ? 'Unmute' : 'Mute'} onClick={onMute}>{muted ? <MicOffIcon /> : <MicIcon />}</button>
        <button type="button" aria-pressed={deafened} aria-label={deafened ? 'Undeafen' : 'Deafen'} title={deafened ? 'Undeafen' : 'Deafen'} onClick={onDeafen}><HeadphonesIcon /></button>
        <button className="is-media" type="button" aria-pressed={camera} aria-label={camera ? 'Camera off' : 'Camera on'} title={camera ? 'Camera off' : 'Camera on'} onClick={onCamera}><VideoIcon /></button>
        <button className="is-media" type="button" aria-pressed={sharing} aria-label={sharing ? 'Stop sharing' : 'Share screen'} title={sharing ? 'Stop sharing' : 'Share screen'} onClick={onShare}><ScreenIcon /></button>
        <button className="is-danger" type="button" aria-label="Disconnect" title="Disconnect" onClick={onDisconnect}><PhoneOffIcon /></button>
      </div>
    </div>
  );
}
