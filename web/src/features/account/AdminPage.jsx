import { useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthProvider.jsx';
import { useAccountResource } from './useAccountResource.js';
import { ExtractionReview } from './ExtractionReview.jsx';

function Results({ resource, children }) {
  if (resource.pending) return <p role="status">Loading…</p>;
  if (resource.error) return <div role="alert"><p>{resource.error.message}</p>
    <button className="text-link" type="button" onClick={resource.retry}>Retry</button></div>;
  return children(resource.data);
}

function Review({ id, refresh }) {
  const { request } = useAuth();
  const detail = useAccountResource('/admin/reviews/' + id);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const response = await request('/admin/reviews/' + id + '/decision', {
        method: 'POST', data: { action: form.get('action'), reason: form.get('reason') },
      });
      setMessage({ text: 'Decision saved · ' + response.status });
      detail.retry();
      refresh();
    } catch (error) {
      setMessage({ error: true, text: error.message });
    } finally {
      setBusy(false);
    }
  }
  return <section className="review-detail" aria-label="Selected case">
    <h3 ref={heading} tabIndex={-1}>Case review</h3>
    <Results resource={detail}>{data => <>
      <div className="account-actions"><span className="status">{data.review.status}</span>
        <p className="muted">{data.review.changedFields.join(', ') || data.review.errorCode}</p></div>
      {data.review.publicationError && <p role="alert">{data.review.publicationError}</p>}
      <details><summary>Evidence and previous version</summary>
        <pre className="admin-evidence" tabIndex={0} aria-label="Evidence data">{JSON.stringify(data, null, 2)}</pre>
      </details>
      {data.review.extractionId && <ExtractionReview reviewId={id} reviewStatus={data.review.status} onDecision={() => {
        detail.retry();
        refresh();
      }} />}
      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      {['pending', 'deferred'].includes(data.review.status) && (
        <form className="account-form" onSubmit={submit}>
          <label>Decision <select name="action" className="question-input">
            {data.review.normalization && <option value="approve">
              {data.review.extractionDecision?.status === 'approved' ? 'Retry approved publication'
                : data.review.extractionId ? 'Approve source without using the AI proposal' : 'Approve publication'}
            </option>}
            <option value="defer">Defer</option><option value="reject">Reject</option>
          </select></label>
          <label>Evidence or reason <textarea name="reason" className="question-input" required minLength={3} maxLength={500} /></label>
          <button className="primary-button" type="submit" disabled={busy}>Save decision</button>
        </form>
      )}
    </>}</Results>
  </section>;
}

function AdminTools() {
  const { request } = useAuth();
  const [id, setId] = useState(null);
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState(null);
  const sources = useAccountResource('/admin/sources');
  const jobs = useAccountResource('/admin/sync-jobs');
  const reviews = useAccountResource('/admin/reviews?limit=20&page=' + page + (status ? '&status=' + status : ''));

  async function enqueue(sourceId, mode) {
    try {
      const result = await request('/admin/sync/' + sourceId, { method: 'POST', data: { mode } });
      setMessage({ text: 'Queued job ' + result.jobId });
      jobs.retry();
    } catch (error) { setMessage({ error: true, text: error.message }); }
  }
  return (
    <>
      <button className="secondary-button" onClick={() => { sources.retry(); jobs.retry(); reviews.retry(); }}>Refresh administration</button>
      <div className="account-grid admin-grid">
        <section className="account-panel" aria-labelledby="sync-heading"><h2 id="sync-heading">Sources and synchronization</h2>
          {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
          <Results resource={sources}>{data => data.sources.length ? data.sources.map(source => (
            <div className="admin-entry" key={source._id}>
              <strong>{source._id}</strong>
              <div className="account-actions">
                <button className="secondary-button" onClick={() => enqueue(source._id, 'snapshot')}>Queue snapshot</button>
                {source.capabilities.incremental && (
                  <button className="secondary-button" onClick={() => enqueue(source._id, 'incremental')}>Queue incremental</button>
                )}
              </div>
            </div>
          )) : <p className="muted">No configured sources.</p>}</Results>
          <h3 className="font-semibold">Recent synchronization jobs</h3>
          <Results resource={jobs}>{data => data.items.length ? <ul className="notification-list">{data.items.map(job => (
            <li key={job._id}><div className="account-actions"><strong>{job.sourceId}</strong><span className="status">{job.status}</span></div>
              <p className="muted">{job.mode} · Attempts {job.attempts}</p>
              {job.errorCode && <p>{job.errorCode}</p>}
              {job.stats && <p>{job.stats.records} records · {job.stats.invalid} invalid · {job.stats.missing} missing</p>}
            </li>
          ))}</ul> : <p className="muted">No synchronization jobs yet.</p>}</Results>
        </section>
        <section className="account-panel" aria-labelledby="queue-heading"><h2 id="queue-heading">Review queue</h2>
          <label>Status <select className="question-input" value={status} onChange={event => {
            setStatus(event.target.value); setPage(1); setId(null);
          }}>
            <option value="">All</option>
            {['pending', 'deferred', 'approved', 'published', 'rejected', 'superseded'].map(value => (
              <option key={value}>{value}</option>
            ))}
          </select></label>
          <Results resource={reviews}>{data => (
            <>
              {data.items.length === 0 && <p>No cases on this page.</p>}
              <ul className="notification-list review-actions">{data.items.map(review => <li key={review._id} data-active={id === review._id}>
                <button className="text-link" type="button" aria-pressed={id === review._id} onClick={() => setId(review._id)}>
                  {review.externalRecordId} · {review.kind} · {review.status}
                </button>
              </li>)}</ul>
              <div className="account-actions">
                <button className="secondary-button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
                <button className="secondary-button" disabled={data.items.length < 20 || page === 1000} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            </>
          )}</Results>
          {id && <Review key={id} id={id} refresh={reviews.retry} />}
        </section>
      </div>
    </>
  );
}

export function AdminPage() {
  const { user, pending } = useAuth();
  return <section className="shell detail-shell account-shell">
    <header className="account-heading"><div><h1>Catalogue administration</h1>
      <p>Manage source imports and review evidence before publication.</p></div></header>
    {pending ? <p role="status">Checking access…</p> : user?.isAdministrator
      ? <AdminTools key={user.id} /> : <p>Administrator access is required.</p>}
  </section>;
}
