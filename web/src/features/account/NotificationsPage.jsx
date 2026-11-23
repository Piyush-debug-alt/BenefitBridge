import { useState } from 'react';
import { Link } from 'react-router';
import { formatDate } from '../catalogue/presentation.jsx';
import { useAuth } from './AuthProvider.jsx';
import { useAccountResource } from './useAccountResource.js';

function Status({ resource, label }) {
  if (resource.pending) return <p role="status">Loading {label}…</p>;
  if (!resource.error) return null;
  return <p role="alert">{resource.error.message}{' '}
    <button className="text-link" type="button" onClick={resource.retry}>Retry</button>
  </p>;
}

function Preferences() {
  const { request } = useAuth();
  const resource = useAccountResource('/me/notification-preferences');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(null);

  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setMessage(null);
    try {
      resource.update(await request('/me/notification-preferences', {
        method: 'PUT',
        data: { bookmarkUpdates: form.has('bookmarkUpdates'), profileMatches: form.has('profileMatches') },
      }));
      setMessage({ text: 'Notification preferences saved.' });
    } catch (error) {
      setMessage({ error: true, text: error.message });
    } finally {
      setPending(false);
    }
  }

  const settings = resource.data?.preferences;
  return (
    <section className="account-panel" aria-labelledby="preferences-heading">
      <h2 id="preferences-heading">Notification preferences</h2>
      <Status resource={resource} label="preferences" />
      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      {settings && (
        <form className="account-form" onSubmit={save}>
          <label className="consent-check">
            <input name="bookmarkUpdates" type="checkbox" defaultChecked={settings.bookmarkUpdates} disabled={pending} />
            Verified updates to bookmarked schemes
          </label>
          <label className="consent-check">
            <input name="profileMatches" type="checkbox" defaultChecked={settings.profileMatches} disabled={pending} />
            New schemes that may match my saved profile
          </label>
          <button className="primary-button" type="submit" disabled={pending}>Save preferences</button>
        </form>
      )}
    </section>
  );
}

function Inbox() {
  const { request } = useAuth();
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const resource = useAccountResource('/me/notifications?page=' + page);
  const data = resource.data;

  async function toggle(item) {
    setPending(true);
    setError(null);
    try {
      const read = !item.readAt;
      const { readAt } = await request('/me/notifications/' + item._id, { method: 'PATCH', data: { read } });
      resource.update({
        ...data,
        unread: Math.max(0, data.unread + (read ? -1 : 1)),
        items: data.items.map(entry => entry._id === item._id ? { ...entry, readAt } : entry),
      });
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="account-panel" aria-labelledby="inbox-heading">
      <div className="account-actions">
        <h2 id="inbox-heading">Inbox</h2>
        <button className="text-link" type="button" disabled={pending || resource.pending} onClick={resource.retry}>Refresh notifications</button>
      </div>
      <Status resource={resource} label="notifications" />
      {error && <p role="alert">{error.message}</p>}
      {data && <p role="status">{data.unread} unread</p>}
      {data?.items.length === 0 && <p>No notifications yet.</p>}
      {data?.items.length > 0 && (
        <ul className="notification-list">
          {data.items.map(item => (
            <li key={item._id}>
              <p className="notification-title">{item.type === 'bookmark_update' ? 'Verified scheme update' : 'Potential profile match'}</p>
              <Link className="text-link" to={'/schemes/' + item.schemeId}>{item.schemeName}</Link>
              <p className="muted">{formatDate(item.createdAt)} · {item.readAt ? 'Read' : 'Unread'}</p>
              <button className="secondary-button" type="button" disabled={pending} onClick={() => toggle(item)}>
                {item.readAt ? 'Mark unread' : 'Mark read'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {data && (data.totalPages > 1 || page > 1) && (
        <nav className="account-actions" aria-label="Notification pages">
          <button className="secondary-button" type="button" disabled={pending || page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <button className="secondary-button" type="button" disabled={pending || page >= data.totalPages} onClick={() => setPage(page + 1)}>Next</button>
        </nav>
      )}
    </section>
  );
}

export function NotificationsPage() {
  const { user, pending } = useAuth();
  return (
    <section className="shell detail-shell account-shell" key={user?.id}>
      <h1>Notifications</h1>
      {pending && <p role="status">Checking your session…</p>}
      {!pending && !user && <Link className="text-link" to="/account">Sign in to view notifications</Link>}
      {user && <div className="account-grid"><Inbox /><Preferences /></div>}
    </section>
  );
}
