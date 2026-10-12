import { useState } from 'react';
import AuthCard from '../components/AuthCard';
import { FormMessage, PasswordField, TextField } from '../components/FormFields';
import { createAccount } from '../app/storage';
import { ROUTES } from '../app/routes';
import { normalizeUsername, USERNAME_INPUT_MAX_LENGTH, USERNAME_RULES_MESSAGE } from '../app/username';

export default function SignUpScreen({ goTo, onAuthenticated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
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
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      setMessage(USERNAME_RULES_MESSAGE);
      return;
    }
    if (password.length < 10) {
      setMessage('Your password must be at least 10 characters.');
      return;
    }
    if (password !== confirmation) {
      setMessage('Your passwords do not match.');
      return;
    }
    setIsSubmitting(true);
    try {
      onAuthenticated(await createAccount(normalizedUsername, password));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthCard
      variant="signup-card"
      brandContent={<div className="auth-brand-intro"><h2>Welcome to Glean!</h2><p>Let’s get started by creating your account. Already been here? Welcome back.</p></div>}
    >
      <div className="auth-layout signup-layout">
        <section className="intro intro-signup">
          <h1>Create your<br />Glean account</h1>
        </section>
        <form className="auth-form" onSubmit={submit} noValidate>
          <TextField
            id="signup-username"
            label="Username"
            placeholder="Choose a username"
            value={username}
            onChange={update(setUsername)}
            autoComplete="username"
            maxLength={USERNAME_INPUT_MAX_LENGTH}
          />
          <PasswordField
            id="signup-password"
            label="Password"
            placeholder="Create a password"
            value={password}
            onChange={update(setPassword)}
            visible={visible}
            onToggle={() => setVisible((current) => !current)}
            autoComplete="new-password"
          />
          <TextField
            id="signup-confirmation"
            label="Confirm password"
            placeholder="Confirm your password"
            value={confirmation}
            onChange={update(setConfirmation)}
            type={visible ? 'text' : 'password'}
            autoComplete="new-password"
          />
          <FormMessage>{message}</FormMessage>
          <div className="form-actions signup-bottom">
            <p className="account-switch">Already have an account? <button type="button" onClick={() => goTo(ROUTES.SIGN_IN)}>Sign in</button></p>
            <button className="primary-button" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Creating…' : 'Create Account'}</button>
          </div>
        </form>
      </div>
    </AuthCard>
  );
}
