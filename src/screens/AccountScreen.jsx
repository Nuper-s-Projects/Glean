import { useEffect } from 'react';
import AuthCard from '../components/AuthCard';
import { formatCreatedDate, signOut } from '../app/storage';
import { ROUTES } from '../app/routes';

export default function AccountScreen({ account, authReady, goTo, onSignedOut }) {

  useEffect(() => {
    if (authReady && !account) goTo(ROUTES.SIGN_UP);
  }, [account, authReady, goTo]);

  if (!account) {
    return null;
  }

  async function handleSignOut() {
    await signOut();
    onSignedOut();
  }

  return (
    <AuthCard variant="account-card">
      <div className="account-page">
        <section className="account-heading">
          <h1>Welcome to Glean</h1>
          <p>Your account is ready.</p>
        </section>
        <section className="account-details" aria-label="Account details">
          <div className="detail-row">
            <span className="detail-label">Glean email</span>
            <span className="detail-value">{account.email}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Password</span>
            <span className="detail-value password-value">
              <span>••••••••</span>
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Created on</span>
            <span className="detail-value">{formatCreatedDate(account.createdAt)}</span>
          </div>
        </section>
        <div className="account-actions">
          <button className="primary-button" type="button" onClick={handleSignOut}>Sign out</button>
        </div>
      </div>
    </AuthCard>
  );
}
