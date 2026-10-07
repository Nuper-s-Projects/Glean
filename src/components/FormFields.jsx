import { EyeIcon } from './Icons';

export function TextField({ id, label, placeholder, value, onChange, type = 'text', autoComplete, maxLength }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        maxLength={maxLength}
      />
    </div>
  );
}

export function PasswordField({ id, label, placeholder, value, onChange, visible, onToggle, autoComplete }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-wrap">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
        />
        <button className="visibility-button" type="button" onClick={onToggle} aria-label={visible ? 'Hide password' : 'Show password'}>
          <EyeIcon hidden={visible} />
        </button>
      </div>
    </div>
  );
}

export function FormMessage({ children }) {
  return <p className={`form-message${children ? ' is-visible' : ''}`} role={children ? 'alert' : undefined} aria-live="polite">{children}</p>;
}
