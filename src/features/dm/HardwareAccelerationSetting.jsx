import { useEffect, useState } from 'react';
import { HARDWARE_ACCELERATION_KEY, hardwareAccelerationPreference, isHardwareAccelerationEnabled, saveHardwareAccelerationPreference } from '../../app/hardwareAcceleration';
import { SettingsSection, SettingsSwitch, SettingsNotice } from './AccountSettingsPrimitives';
import GleanButton from './GleanButton';
import useMemorySaver from '../../app/useMemorySaver';
import { saveMemorySaver } from '../../app/memorySaver';

export default function HardwareAccelerationSetting() {
  const [enabled, setEnabled] = useState(hardwareAccelerationPreference);
  const [error, setError] = useState('');
  const memorySaver = useMemorySaver();
  const [memoryError, setMemoryError] = useState('');
  const requiresRefresh = enabled !== isHardwareAccelerationEnabled();
  useEffect(() => {
    const update = event => {
      if (event.key === HARDWARE_ACCELERATION_KEY || event.key === null) {
        setEnabled(hardwareAccelerationPreference());
        setError('');
      }
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);

  const change = next => {
    try {
      saveHardwareAccelerationPreference(next);
      setEnabled(next);
      setError('');
    } catch (failure) { setError(failure.message); }
  };

  return <SettingsSection id="settings-hardware-title" title="Performance" description="Preferences for this browser only.">
    <SettingsSwitch label="Memory saver" hint="Uses smaller caches in Glean and Glean Loop, simplifies voice-note waveforms, and releases paused, offscreen media buffers. Applies immediately. Returning to media may reload it; playing audio and calls are not interrupted." checked={memorySaver} onChange={next => {
      try { saveMemorySaver(next); setMemoryError(''); }
      catch (failure) { setMemoryError(failure.message); }
    }} />
    <SettingsNotice error>{memoryError}</SettingsNotice>
    <SettingsSwitch label="Hardware acceleration" hint="Enabled by default. Turning it off disables Glean’s GPU-heavy glass and blur effects and may resolve graphical glitches. Refresh the page for changes to take effect." checked={enabled} onChange={change} />
    <p className="settings-help">Controls Glean’s visual effects, not your browser’s hardware acceleration setting. Chats, calls, and video playback stay available.</p>
    <SettingsNotice error>{error}</SettingsNotice>
    {requiresRefresh ? <div className="settings-renderer-restart" role="status"><p>Refresh required. Glean’s accelerated effects are currently {isHardwareAccelerationEnabled() ? 'on' : 'off'}. A refresh will turn them {enabled ? 'on' : 'off'}. Save any unsent work first.</p><GleanButton onClick={() => window.location.reload()}>Refresh now</GleanButton></div> : null}
  </SettingsSection>;
}
