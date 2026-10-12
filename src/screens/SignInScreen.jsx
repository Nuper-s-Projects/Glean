import { useState } from 'react';
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
    <AuthCard
      variant="signin-card"
      brandContent={<div className="auth-brand-intro"><h2>Welcome to Glean!</h2><p>Let’s get started by creating your account. Already been here? Welcome back.</p></div>}
    >
      <div className="auth-layout signin-layout">
        <section className="intro intro-signin">
          <h1>Sign in to Glean</h1>
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
