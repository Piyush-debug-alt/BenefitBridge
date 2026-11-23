import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { dataset, readCatalogue } from './client.js';
import { formatDate, SchemeStatuses, scope } from './presentation.jsx';
import { BookmarkButton } from '../account/BookmarkButton.jsx';

function DetailList({ values, fallback }) {
  return values.length
    ? <ul className="detail-list">{values.map((value, index) => <li key={index}>{value}</li>)}</ul>
    : <p>{fallback}</p>;
}

export function SchemePage() {
  const { schemeId } = useParams();
  const { state } = useLocation();
  const schemeQuery = useQuery({
    queryKey: ['scheme', schemeId],
    queryFn: ({ signal }) => readCatalogue('/schemes/' + encodeURIComponent(schemeId), signal),
  });
  const back = <Link className="text-link" to={{ pathname: '/', search: state?.returnTo ?? '' }}>Back to schemes</Link>;

  if (schemeQuery.isPending) return <div className="shell detail-shell">{back}<p role="status">Loading scheme…</p></div>;
  if (schemeQuery.isError) {
    return (
      <section className="shell detail-shell">
        {back}
        <h1>{schemeQuery.error.status === 404 ? 'Scheme unavailable' : 'Unable to load scheme'}</h1>
        <p role="alert">{schemeQuery.error.message}</p>
      </section>
    );
  }

  const { item } = schemeQuery.data;
  const synthetic = dataset === 'synthetic';
  const offerLink = !synthetic && item.lifecycleStatus === 'active' && item.applicationUrl;
  return (
    <article className="shell detail-shell">
      {back}
      <header className="detail-intro">
        <p className="category">{item.categoryIds.join(' · ')}</p>
        <h1>{item.canonicalName}</h1>
        <SchemeStatuses scheme={item} />
        <p>{item.description}</p>
        {item.disputedFields?.length > 0 && (
          <p role="status">Showing the last published information. Under review: {item.disputedFields
            .map(field => field.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')}.</p>
        )}
        {item.sourceSyncInterrupted && <p role="status">The source could not be refreshed. Showing the last published information.</p>}
        <BookmarkButton schemeId={item._id} />
      </header>
      <div className="detail-grid">
        <div className="detail-content">
          <section><h2>Benefits</h2><DetailList values={item.benefits} fallback="Benefit details unavailable." /></section>
          <section><h2>Eligibility information</h2><p>{item.eligibilityText || 'Eligibility information requires verification.'}</p></section>
          <section><h2>Documents</h2><DetailList values={item.requiredDocuments} fallback="Document requirements unavailable." /></section>
          {item.variants?.length > 0 && <section><h2>State variants</h2><ul className="detail-list">
            {item.variants.map(variant => <li key={variant._id}><Link to={'/schemes/' + variant._id}>{variant.canonicalName}</Link></li>)}
          </ul></section>}
          {item.relationships?.length > 0 && <section><h2>Scheme relationships</h2><ul className="detail-list">
            {item.relationships.map(link => <li key={link.kind + link.targetId}>
              {({variant_of: 'Variant of', supplement_to: 'Supplement to', related_to: 'Related to'})[link.kind]}{' '}
              <Link to={'/schemes/' + link.targetId}>{link.name}</Link>
            </li>)}
          </ul></section>}
        </div>
        <aside className="detail-aside" aria-labelledby="sources-heading">
          <h2 id="sources-heading">Scheme and sources</h2>
          <dl>
            <dt>Issuer</dt><dd>{item.issuer}</dd>
            <dt>Scope</dt><dd>{scope(item)}</dd>
            <dt>Last checked</dt><dd>{formatDate(item.lastVerifiedAt)}</dd>
            <dt>Last imported</dt><dd>{formatDate(item.lastSyncedAt)}</dd>
            {item.applicationDeadline && <><dt>Application deadline</dt><dd>{formatDate(item.applicationDeadline)}</dd></>}
          </dl>
          <ul className="source-list">
            {item.sourceRefs.map(({ label, url }, index) => (
              <li key={index}>{synthetic ? <span>{label}</span> : <a className="text-link" href={url}>{label}</a>}</li>
            ))}
          </ul>
          {offerLink && <a className="primary-button" href={item.applicationUrl}>Official application portal</a>}
          {synthetic && <p className="muted">Applications are unavailable for fictional listings.</p>}
        </aside>
      </div>
    </article>
  );
}
