import { useState } from 'react';
import AuthCard from '../components/AuthCard';
import { FormMessage, TextField } from '../components/FormFields';
import { setUsername } from '../app/storage';
import { normalizeUsername, USERNAME_INPUT_MAX_LENGTH, USERNAME_RULES_MESSAGE } from '../app/username';

export default function UsernameScreen({ onAuthenticated }) {
  const [username, setUsernameValue] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      setMessage(USERNAME_RULES_MESSAGE);
      return;
    }

    setIsSubmitting(true);
    try {
      onAuthenticated(await setUsername(normalizedUsername));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthCard variant="username-card">
      <div className="auth-layout username-layout">
        <section className="intro intro-username">
          <h1>Choose your<br />username</h1>
          <p>This is how people will<br />find you in Glean.</p>
        </section>
        <form className="auth-form" onSubmit={submit} noValidate>
          <TextField
            id="username"
            label="Username"
            placeholder="yourname"
            value={username}
            onChange={(value) => {
              setUsernameValue(value);
              setMessage('');
            }}
            autoComplete="username"
            maxLength={USERNAME_INPUT_MAX_LENGTH}
          />
          <FormMessage>{message}</FormMessage>
          <div className="form-actions username-actions">
            <button className="primary-button" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Saving…' : 'Continue'}</button>
          </div>
        </form>
      </div>
    </AuthCard>
  );
}
