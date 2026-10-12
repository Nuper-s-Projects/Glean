import { useEffect, useState } from 'react';
import Brand from './Brand';

export default function AuthCard({ children, variant = '', brandContent = null }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const loadStats = async () => {
      try {
        const response = await fetch('/api/v1/auth/stats', { headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const next = await response.json();
        if (!cancelled && [next.online, next.total, next.servers].every(Number.isFinite)) setStats(next);
      } catch { /* Auth should remain usable if public stats are unavailable. */ }
    };
    loadStats();
    const timer = window.setInterval(loadStats, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  return (
    <main className={`auth-card ${variant}`}>
      <aside className="auth-brand-panel" aria-label="Glean community">
        <Brand />
        <div className="auth-brand-copy">
          {brandContent}
          {stats ? <div className="auth-community-stats" aria-label={`${stats.total.toLocaleString()} accounts, ${stats.servers.toLocaleString()} servers, ${stats.online.toLocaleString()} users online`}>
            <div><strong>{stats.total.toLocaleString()}</strong><span>Glean accounts</span></div>
            <div><strong>{stats.servers.toLocaleString()}</strong><span>servers</span></div>
            <div><i className="auth-online-dot" /><strong>{stats.online.toLocaleString()}</strong><span>online now</span></div>
          </div> : null}
        </div>
      </aside>
      <section className="auth-content-panel">
        {children}
      </section>
    </main>
  );
}
