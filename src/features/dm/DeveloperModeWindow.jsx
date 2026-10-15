import { useEffect, useState } from 'react';
import { getBrowserDiagnostics, getDeveloperTraffic, setDeveloperModeEnabled } from '../../app/developerMode';
import { CloseIcon } from './icons';
import { startVisualLoop, subscribePageActivity } from '../../app/pageActivity';

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMemory(value) {
  return value ? `${formatBytes(value.used)} / ${formatBytes(value.limit)}` : 'Not exposed by this browser';
}

export default function DeveloperModeWindow({ onClose }) {
  const [diagnostics, setDiagnostics] = useState(() => getBrowserDiagnostics());
  const [fps, setFps] = useState(null);

  useEffect(() => {
    let frames = 0;
    let lastSample = performance.now();
    const sample = (now) => {
      frames += 1;
      if (now - lastSample >= 1000) {
        setFps(Math.round((frames * 1000) / (now - lastSample)));
        frames = 0;
        lastSample = now;
      }
    };
    const stop = startVisualLoop(sample);
    const unsubscribe = subscribePageActivity(() => { frames = 0; lastSample = performance.now(); setFps(null); });
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') setDiagnostics(getBrowserDiagnostics());
    }, 1000);
    return () => {
      stop();
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);

  const traffic = diagnostics.traffic || getDeveloperTraffic();
  const close = () => {
    setDeveloperModeEnabled(false);
    onClose?.();
  };

  return (
    <aside className="developer-mode-window" aria-label="Glean Developer Mode" aria-live="polite">
      <header className="developer-mode-header">
        <div><span>LOCAL DIAGNOSTICS</span><h2>Developer Mode</h2></div>
        <button type="button" onClick={close} aria-label="Turn off Developer Mode"><CloseIcon /></button>
      </header>
      <p className="developer-mode-note">Visible only in this browser. Diagnostics stay on this device and are not sent to Glean.</p>
      <div className="developer-mode-grid">
        <section><span>Frame rate estimate</span><strong>{fps == null ? 'Measuring…' : `${fps} FPS`}</strong></section>
        <section><span>JavaScript memory</span><strong>{formatMemory(diagnostics.memory)}</strong></section>
        <section><span>Page load</span><strong>{diagnostics.pageLoadMs == null ? 'Unavailable' : `${diagnostics.pageLoadMs} ms`}</strong></section>
        <section><span>Network</span><strong>{diagnostics.connection ? `${diagnostics.connection.type}${diagnostics.connection.downlink == null ? '' : ` · ${diagnostics.connection.downlink} Mbps`}${diagnostics.connection.rtt == null ? '' : ` · ${diagnostics.connection.rtt} ms RTT`}` : 'Browser does not expose connection details'}</strong></section>
        <section><span>App API traffic this session</span><strong>{traffic.http.requests} requests · ↑ {formatBytes(traffic.http.uploaded)} · ↓ {formatBytes(traffic.http.downloaded)}</strong></section>
        <section><span>WebSocket traffic this session</span><strong>{traffic.websocket.sent} sent · {traffic.websocket.received} received · ↑ {formatBytes(traffic.websocket.uploaded)} · ↓ {formatBytes(traffic.websocket.downloaded)}</strong></section>
      </div>
      <section className="developer-mode-third-party">
        <div className="developer-mode-section-heading"><strong>Third-party resources</strong><small>{diagnostics.thirdParties.length} origins observed</small></div>
        <p>This lists external origins loaded by this page. It is not a tracker detector; some transfer sizes are hidden by browser privacy rules.</p>
        {diagnostics.thirdParties.length ? (
          <ul>{diagnostics.thirdParties.map((item) => <li key={item.origin}><span><strong>{item.origin}</strong><small>{item.count} requests{item.types.length ? ` · ${item.types.join(', ')}` : ''}</small></span><span>{formatBytes(item.bytes)}</span></li>)}</ul>
        ) : <p className="developer-mode-empty">No third-party origins observed in this page session.</p>}
      </section>
      <footer className="developer-mode-footer"><span><strong>Extensions</strong> Installed browser extensions are hidden from websites, so Glean cannot inspect them. Traffic totals cover API/WebSocket payloads only, not headers or media bytes.</span><button type="button" onClick={close}>Turn off</button></footer>
    </aside>
  );
}
