import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from './AuthProvider.jsx';
import { accountRequest } from './client.js';

const titles = {
  login: 'Sign in', register: 'Create account', forgot: 'Reset password',
  resend: 'Resend verification email', verify: 'Verify email', reset: 'Choose a new password',
};
const endpoints = {
  register: '/auth/register', forgot: '/auth/password/forgot',
  resend: '/auth/email/resend', verify: '/auth/email/verify', reset: '/auth/password/reset',
};
const googleMessages = {
  failed: 'Google sign-in could not be completed. Try again.',
  'use-original-sign-in': 'This email already has a sign-in method. Sign in with the original method, or select a different Google account.',
};

export function useAuthOptions() {
  const [options, setOptions] = useState(null);
  useEffect(() => {
    const abort = new AbortController();
    accountRequest('/auth/options', { signal: abort.signal }).then(setOptions).catch(() => {});
    return () => abort.abort();
  }, []);
  return options;
}

export function AuthPage({ mode, googleStatus }) {
  const auth = useAuth();
  const options = useAuthOptions();
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => location.hash.slice(1));
  const [error, setError] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const requiresToken = mode === 'verify' || mode === 'reset';

  useEffect(() => {
    if (requiresToken && location.hash) {
      navigate(location.pathname + location.search, { replace: true });
    }
  }, [requiresToken, location.hash, location.pathname, location.search, navigate]);

  async function submit(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (requiresToken) data.token = token;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      if (mode === 'login') {
        await auth.login(data);
      } else {
        const response = await accountRequest(endpoints[mode], { method: 'POST', data });
        setMessage(response.message);
        if (mode === 'reset') await auth.refresh();
      }
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }

  const askEmail = !requiresToken;
  const askPassword = ['login', 'register', 'reset'].includes(mode);
  return (
    <section className="shell detail-shell account-shell auth-shell">
      <header className="auth-intro">
        <h1>{titles[mode]}</h1>
        {['login', 'register'].includes(mode) && <p>Save schemes, manage your eligibility profile, and choose which updates to receive.</p>}
      </header>
      <div className="account-panel">
        {Object.hasOwn(googleMessages, googleStatus) && <p role="alert">{googleMessages[googleStatus]}</p>}
        {error && <p role="alert">{error.message}</p>}
        {message && <p role="status">{message}</p>}
        {requiresToken && !token && <p role="alert">Open the full link from your email to continue.</p>}
        <form className="account-form" onSubmit={submit}>
          {askEmail && (
            <label>Email
              <input className="question-input" type="email" name="email" autoComplete="email" maxLength={254} required />
            </label>
          )}
          {askPassword && (
            <label>{mode === 'reset' ? 'New password' : 'Password'}
              <input className="question-input" type="password" name="password" required maxLength={128}
                minLength={mode === 'login' ? 1 : 12}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            </label>
          )}
          {askPassword && mode !== 'login' && <p className="muted">Use at least 12 characters.</p>}
          <button className="primary-button" disabled={busy || (requiresToken && (!token || Boolean(message)))} type="submit">
            {busy ? 'Working…' : titles[mode]}
          </button>
        </form>
        <div className="account-actions auth-links">
          {mode === 'login' && options?.googleEnabled && <a className="secondary-button" href="/api/v1/auth/google/start">Continue with Google</a>}
          {mode === 'login'
            ? <Link className="text-link" to="/account?mode=register">Create an account</Link>
            : <Link className="text-link" to="/account">Back to sign in</Link>}
          {mode === 'login' && options?.emailEnabled && <Link className="text-link" to="/account?mode=forgot">Forgot password?</Link>}
          {(mode === 'login' && options?.emailEnabled || error?.code === 'EMAIL_VERIFICATION_REQUIRED') &&
            <Link className="text-link" to="/account?mode=resend">Resend verification email</Link>}
        </div>
      </div>
    </section>
  );
}
