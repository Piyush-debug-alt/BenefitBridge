import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { dataset, readCatalogue } from './client.js';
import { displayLabel, formatDate, SchemeStatuses, scope } from './presentation.jsx';
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
  const back = <Link className="back-link" to={{ pathname: '/', search: state?.returnTo ?? '' }}><span aria-hidden="true">←</span> Back to schemes</Link>;

  if (schemeQuery.isPending) return <div className="shell detail-shell">{back}<div role="status" className="empty-state">
    <p>Loading scheme…</p><div className="skeleton-lines" aria-hidden="true"><span /><span /><span /></div>
  </div></div>;
  if (schemeQuery.isError) {
    return (
      <section className="shell detail-shell">
        {back}
        <div className="empty-state">
          <h1>{schemeQuery.error.status === 404 ? 'Scheme unavailable' : 'Unable to load scheme'}</h1>
          <p role="alert">{schemeQuery.error.message}</p>
          {schemeQuery.error.status !== 404 && <button className="secondary-button" type="button" onClick={() => schemeQuery.refetch()}>Retry</button>}
        </div>
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
        <div className="category-list">{item.categoryIds.map(category => <span className="category" key={category}>{displayLabel(category)}</span>)}</div>
        <h1>{item.canonicalName}</h1>
        <SchemeStatuses scheme={item} />
        <p className="detail-summary">{item.description}</p>
        {item.disputedFields?.length > 0 && (
          <p className="notice" role="status">Showing the last published information. Under review: {item.disputedFields
            .map(field => field.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')}.</p>
        )}
        {item.sourceSyncInterrupted && <p className="notice" role="status">The source could not be refreshed. Showing the last published information.</p>}
        <BookmarkButton schemeId={item._id} />
      </header>
      <div className="detail-grid">
        <div className="detail-content">
          <section><h2>Benefits</h2><DetailList values={item.benefits} fallback="Benefit details unavailable." /></section>
          <section><h2>Eligibility information</h2>
            <p className={item.eligibilityText ? 'source-text' : 'notice'}>{item.eligibilityText || 'Eligibility information requires verification.'}</p>
          </section>
          <section><h2>Documents</h2><DetailList values={item.requiredDocuments} fallback="Document requirements unavailable." /></section>
          {item.variants?.length > 0 && <section><h2>State variants</h2><ul className="detail-list">
            {item.variants.map(variant => <li key={variant._id}><Link className="text-link" state={{ returnTo: state?.returnTo }} to={'/schemes/' + variant._id}>{variant.canonicalName}</Link></li>)}
          </ul></section>}
          {item.relationships?.length > 0 && <section><h2>Scheme relationships</h2><ul className="detail-list">
            {item.relationships.map(link => <li key={link.kind + link.targetId}>
              {({variant_of: 'Variant of', supplement_to: 'Supplement to', related_to: 'Related to'})[link.kind]}{' '}
              <Link className="text-link" state={{ returnTo: state?.returnTo }} to={'/schemes/' + link.targetId}>{link.name}</Link>
            </li>)}
          </ul></section>}
        </div>
        <aside className="detail-aside" aria-labelledby="sources-heading">
          <div className="application-panel">
            <h2>How to apply</h2>
            {offerLink && <>
              <p>Check requirements and follow the instructions on the official portal.</p>
              <a className="primary-button" href={item.applicationUrl}>Official application portal <span aria-hidden="true">↗</span></a>
            </>}
            {!offerLink && <p>{synthetic ? 'Applications are unavailable for fictional listings.'
              : item.lifecycleStatus === 'closed' ? 'This listing is marked closed. Check the source for announcements.'
                : 'A current application link is not available here. Check the sources below for application instructions.'}</p>}
          </div>
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
              <li key={index}>{synthetic ? <span>{label}</span> : <a className="text-link" href={url}>{label} <span aria-hidden="true">↗</span></a>}</li>
            ))}
          </ul>
        </aside>
      </div>
    </article>
  );
}
