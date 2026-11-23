import { Link } from 'react-router';
import { dataset } from './client.js';
import { MatchExplanation } from './MatchExplanation.jsx';
import { stateName } from './regions.js';

const lifecycleLabels = { active: 'Active listing', closed: 'Closed', unknown: 'Availability unknown' };
const verificationLabels = {
  verified: 'Verified', stale: 'Stale information', under_review: 'Under review',
  disputed: 'Disputed information', unverified: 'Unverified',
};
const dateFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' });

export function formatDate(date) {
  const value = new Date(date);
  return date && Number.isFinite(value.getTime()) ? dateFormatter.format(value) : 'Unavailable';
}

export function displayLabel(value) {
  const words = value.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function scope(scheme) {
  if (scheme.nationwide) return 'Nationwide';
  return scheme.stateCodes.map(stateName).join(', ') || 'Region unspecified';
}

export function SchemeStatuses({ scheme }) {
  return (
    <div className="status-row">
      <span className={'status status-' + scheme.lifecycleStatus}>{lifecycleLabels[scheme.lifecycleStatus]}</span>
      <span className={'status status-' + scheme.verificationStatus}>
        {dataset === 'synthetic' ? 'Demo: ' : ''}{verificationLabels[scheme.verificationStatus]}
      </span>
    </div>
  );
}

export function SchemeCard({ scheme, returnTo, match }) {
  return (
    <article className="scheme-card">
      <div className="category-list">{scheme.categoryIds.map(category => <span className="category" key={category}>{displayLabel(category)}</span>)}</div>
      <h3><Link to={'/schemes/' + scheme._id} state={{ returnTo }}><span>{scheme.canonicalName}</span><span className="card-arrow" aria-hidden="true" /></Link></h3>
      <p className="card-description">{scheme.description}</p>
      <dl className="card-meta">
        <div><dt>{scheme.governmentLevel === 'central' ? 'Central scheme' : 'State scheme'}</dt><dd>{scope(scheme)}</dd></div>
        <div><dt>Benefits</dt><dd>{scheme.benefitTypes?.map(displayLabel).join(' · ') || 'See details'}</dd></div>
      </dl>
      <SchemeStatuses scheme={scheme} />
      {scheme.lastVerifiedAt && <p className="muted card-checked">Last checked {formatDate(scheme.lastVerifiedAt)}</p>}
      {match && <MatchExplanation match={match} />}
    </article>
  );
}
