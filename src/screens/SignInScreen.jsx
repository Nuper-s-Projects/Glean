import { useEffect, useState } from 'react';
import AuthCard from '../components/AuthCard';
import { PasswordField, TextField, FormMessage } from '../components/FormFields';
import { signIn } from '../app/storage';
import { ROUTES } from '../app/routes';
import { USERNAME_INPUT_MAX_LENGTH } from '../app/username';

export default function SignInScreen({ goTo, onAuthenticated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const loadStats = () => fetch('/api/v1/auth/stats', { headers: { Accept: 'application/json' } })
      .then((response) => response.ok ? response.json() : null)
      .then((next) => { if (!cancelled && next && Number.isFinite(next.online) && Number.isFinite(next.total)) setStats(next); })
      .catch(() => {});
    loadStats();
    const timer = window.setInterval(loadStats, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  function update(setter) {
    return (value) => {
      setter(value);
      setMessage('');
    };
  }

  async function submit(event) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setMessage('Enter your username and password to continue.');
      return;
    }
    setIsSubmitting(true);
    try {
      onAuthenticated(await signIn(username, password));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthCard variant="signin-card">
      <div className="auth-layout signin-layout">
        <section className="intro intro-signin">
          <h1>Sign in to Glean</h1>
          <p>Use your Glean account to continue.</p>
          {stats ? <div className="auth-community-stats" aria-label={`${stats.online} users online, ${stats.total} total users`}><span><i className="auth-online-dot" />{stats.online.toLocaleString()} online</span><b>—</b><span>{stats.total.toLocaleString()} total users</span></div> : null}
        </section>
        <form className="auth-form" onSubmit={submit} noValidate>
          <TextField
            id="signin-username"
            label="Username"
            placeholder="Enter your username"
            value={username}
            onChange={update(setUsername)}
            autoComplete="username"
            maxLength={USERNAME_INPUT_MAX_LENGTH}
          />
          <PasswordField
            id="signin-password"
            label="Password"
            placeholder="Enter your password"
            value={password}
            onChange={update(setPassword)}
            visible={visible}
            onToggle={() => setVisible((current) => !current)}
            autoComplete="current-password"
          />
          <FormMessage>{message}</FormMessage>
          <div className="form-actions signin-actions">
            <button className="secondary-button" type="button" onClick={() => goTo(ROUTES.SIGN_UP)}>Create account</button>
            <button className="primary-button" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Signing in…' : 'Sign in'}</button>
          </div>
        </form>
      </div>
    </AuthCard>
  );
}
