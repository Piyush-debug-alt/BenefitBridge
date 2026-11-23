import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { formatDate } from '../catalogue/presentation.jsx';
import { Question, readAnswers } from '../catalogue/PersonalizePanel.jsx';
import { AuthPage } from './AuthPage.jsx';
import { useAuth } from './AuthProvider.jsx';
import { useAccountResource } from './useAccountResource.js';

function ResourceStatus({ resource, label }) {
  if (resource.pending) return <p role="status">Loading {label}…</p>;
  if (!resource.error) return null;
  return (
    <div role="alert">
      <p>{resource.error.message}</p>
      <button className="text-link" type="button" onClick={resource.retry}>Retry</button>
    </div>
  );
}

function ProfilePanel({ answers, useAnswers }) {
  const { request } = useAuth();
  const profileResource = useAccountResource('/me/profile');
  const [draft, setDraft] = useState(null);
  const [revision, setRevision] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState('');
  const { profile, questions } = profileResource.data ?? {};

  function setFields(values) {
    setDraft(values);
    setRevision(value => value + 1);
  }

  async function save(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const attributes = readAnswers(form, questions);
    setError(null);
    setMessage('');
    if (!Object.keys(attributes).length) {
      setError(new Error('Answer at least one question to save a profile.'));
      return;
    }

    setBusy(true);
    try {
      const { profile } = await request('/me/profile', {
        method: 'PUT', data: { attributes, consent: new FormData(form).has('consent') },
      });
      profileResource.update({ profile, questions });
      setFields(null);
      setMessage('Profile saved.');
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await request('/me/profile', { method: 'DELETE' });
      profileResource.update({ profile: null, questions });
      setFields(null);
      setConfirmDelete(false);
      setMessage('Saved profile deleted.');
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-panel" aria-labelledby="profile-heading">
      <div><h2 id="profile-heading">Questionnaire profile</h2><p className="muted">Save answers with your consent so you can reuse them in search.</p></div>
      <ResourceStatus resource={profileResource} label="profile" />
      {error && <p role="alert">{error.message}</p>}
      {message && <p role="status">{message}</p>}
      {questions && (
        <>
          <p>{profile ? 'Saved with consent on ' + formatDate(profile.consentAt) + '.' : 'You have no saved profile.'}</p>
          {answers && Object.keys(answers).length > 0 && (
            <button className="text-link" type="button" disabled={busy}
              onClick={() => setFields(answers)}>Copy current questionnaire answers</button>
          )}
          <form className="account-form" key={revision} onSubmit={save}>
            {questions.map(question => (
              <Question key={question.id} question={question} answer={(draft ?? profile?.attributes)?.[question.id]} />
            ))}
            <label className="consent-check">
              <input name="consent" type="checkbox" required />
              <span>I agree to save these answers in my BenefitBridge account.</span>
            </label>
            <div className="account-actions">
              <button className="primary-button" type="submit" disabled={busy}>Save profile</button>
              {profile && (
                <button className="secondary-button" type="button" disabled={busy}
                  onClick={() => useAnswers(profile.attributes)}>Use saved answers in search</button>
              )}
            </div>
          </form>
          {profile && !confirmDelete && (
            <button className="text-link" type="button" disabled={busy}
              onClick={() => setConfirmDelete(true)}>Delete saved profile</button>
          )}
          {profile && confirmDelete && (
            <div className="account-actions" role="group" aria-label="Confirm saved profile deletion">
              <button className="secondary-button" type="button" disabled={busy} onClick={remove}>Confirm profile deletion</button>
              <button className="text-link" type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function BookmarksPanel() {
  const { request } = useAuth();
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const list = useAccountResource('/me/bookmarks?page=' + page);

  async function remove(id) {
    setBusy(true);
    setError(null);
    try {
      await request('/me/bookmarks/' + id, { method: 'DELETE' });
      if (page > 1 && list.data.items.length === 1) setPage(page - 1);
      else list.retry();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-panel" aria-labelledby="bookmarks-heading">
      <h2 id="bookmarks-heading">Bookmarks</h2>
      <ResourceStatus resource={list} label="bookmarks" />
      {error && <p role="alert">{error.message}</p>}
      {list.data?.items.length === 0 && <p className="muted">No bookmarks on this page.</p>}
      {list.data?.items.length > 0 && (
        <ul className="bookmark-list">
          {list.data.items.map(({ schemeId, name }) => (
            <li key={schemeId}>
              {name ? <Link className="text-link" to={'/schemes/' + schemeId}>{name}</Link> : <span>Scheme unavailable</span>}
              <button className="secondary-button" type="button" disabled={busy}
                aria-label={'Remove bookmark: ' + (name ?? 'Scheme unavailable')}
                onClick={() => remove(schemeId)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {list.data && (list.data.totalPages > 1 || page > 1) && (
        <nav className="account-actions" aria-label="Bookmark pages">
          <button className="secondary-button" type="button" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <button className="secondary-button" type="button" disabled={busy || page >= list.data.totalPages} onClick={() => setPage(page + 1)}>Next</button>
        </nav>
      )}
    </section>
  );
}

export function AccountPage({ answers, setAnswers }) {
  const { user, pending, error: sessionError, logout } = useAuth();
  const { search } = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(search);
  const requestedMode = params.get('mode');
  const mode = ['register', 'forgot', 'resend', 'verify', 'reset'].includes(requestedMode) ? requestedMode : 'login';
  const [logoutError, setLogoutError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    setLogoutError(null);
    try {
      await logout();
    } catch (error) {
      setLogoutError(error);
    } finally {
      setBusy(false);
    }
  }

  if (pending) return <section className="shell detail-shell"><p role="status">Checking your session…</p></section>;
  if (!user || ['verify', 'reset'].includes(mode)) {
    return (
      <>
        {sessionError && <p className="shell account-error" role="alert">{sessionError.message}</p>}
        <AuthPage key={mode} mode={mode} googleStatus={params.get('google')} />
      </>
    );
  }

  return (
    <section className="shell detail-shell account-shell" key={user.id}>
      <header className="account-heading">
        <div><h1>Your account</h1><p>{user.email}</p>{!user.emailVerified && <span className="status status-unverified">Email unverified</span>}</div>
        <button className="secondary-button" type="button" disabled={busy} onClick={signOut}>Sign out</button>
      </header>
      {logoutError && <p role="alert">{logoutError.message}</p>}
      <div className="account-grid">
        <ProfilePanel answers={answers} useAnswers={values => { setAnswers(values); navigate('/'); }} />
        <BookmarksPanel />
      </div>
    </section>
  );
}
