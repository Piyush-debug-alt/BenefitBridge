import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from './AuthProvider.jsx';
import { useAccountResource } from './useAccountResource.js';

function SignedInBookmark({ schemeId }) {
  const { request } = useAuth();
  const path = '/me/bookmarks/' + schemeId;
  const resource = useAccountResource(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const bookmarked = resource.data.bookmarked;
      if (bookmarked) await request(path, { method: 'DELETE' });
      else await request('/me/bookmarks', { method: 'POST', data: { schemeId } });
      resource.update({ bookmarked: !bookmarked });
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bookmark-actions">
      {resource.pending && <p role="status">Checking bookmark…</p>}
      {resource.error && <button className="text-link" type="button" onClick={resource.retry}>Retry loading bookmark</button>}
      {error && <p role="alert">{error.message}</p>}
      {resource.data && <button className="secondary-button" type="button" disabled={busy} onClick={toggle}>
        {resource.data.bookmarked ? 'Remove bookmark' : 'Bookmark scheme'}
      </button>}
    </div>
  );
}

export function BookmarkButton({ schemeId }) {
  const { user, pending } = useAuth();
  if (pending) return null;
  if (!user) return <p className="bookmark-actions"><Link className="text-link" to="/account">Sign in to bookmark</Link></p>;
  return <SignedInBookmark key={user.id + ':' + schemeId} schemeId={schemeId} />;
}
