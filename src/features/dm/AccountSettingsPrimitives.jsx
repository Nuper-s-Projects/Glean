import { useState } from 'react';

export function SettingIcon({ name }) {
  const paths = {
    profile: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
    privacy: <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />,
    security: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    notifications: <><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3ZM10 21h4" /></>,
    accessibility: <><circle cx="12" cy="4" r="1.5" /><path d="M5 9h14M12 7v7m0 0-4 7m4-7 4 7" /></>,
    device: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    key: <><circle cx="8" cy="8" r="4" /><path d="m11 11 9 9m-4-4 3-3m-6 0 3-3" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  };
  return <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.info}</svg>;
}

export function SettingsSection({ title, description, children, className = '', id }) {
  return <section className={`settings-section ${className}`} aria-labelledby={id}>
    <div className="settings-section-copy"><h2 id={id}>{title}</h2>{description ? <p>{description}</p> : null}</div>
    <div className="settings-section-controls">{children}</div>
  </section>;
}

export function SettingsField({ label, id, hint, children }) {
  return <div className="settings-field"><label htmlFor={id}>{label}</label>{children}{hint ? <small>{hint}</small> : null}</div>;
}

export function SettingsSwitch({ label, hint, checked, busy, onChange }) {
  return <label className="settings-switch-row">
    <span><strong>{label}</strong>{hint ? <small>{hint}</small> : null}</span>
    <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={busy} onChange={event => onChange(event.target.checked)} />
  </label>;
}

export function SettingsPassword({ id, label, value, onChange, autoComplete = 'current-password', minLength, required = true }) {
  const [visible, setVisible] = useState(false);
  return <SettingsField id={id} label={label}>
    <div className="settings-password">
      <input id={id} className="settings-input" type={visible ? 'text' : 'password'} value={value} onChange={event => onChange(event.target.value)} autoComplete={autoComplete} minLength={minLength} maxLength={256} required={required} />
      <button type="button" aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`} aria-pressed={visible} onClick={() => setVisible(current => !current)}><SettingIcon name="eye" /></button>
    </div>
  </SettingsField>;
}

export function SettingsNotice({ children, error = false }) {
  if (!children) return null;
  return <p className={`settings-feedback${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</p>;
}
