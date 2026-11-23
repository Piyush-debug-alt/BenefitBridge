import { Link } from 'react-router';
import { dataset } from './client.js';
import { MatchExplanation } from './MatchExplanation.jsx';

const lifecycleLabels = { active: 'Active', closed: 'Closed', unknown: 'Availability unknown' };
const verificationLabels = {
  verified: 'Verified', stale: 'Stale information', under_review: 'Under review',
  disputed: 'Disputed information', unverified: 'Unverified',
};
const dateFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' });

export function formatDate(date) {
  return date ? dateFormatter.format(new Date(date)) : 'Unavailable';
}

export function scope(scheme) {
  if (scheme.nationwide) return 'Nationwide';
  return scheme.stateCodes.join(', ') || 'Region unspecified';
}

export function SchemeStatuses({ scheme }) {
  return (
    <div className="status-row">
      <span className={'status status-' + scheme.lifecycleStatus}>{lifecycleLabels[scheme.lifecycleStatus]}</span>
      <span className={'status status-' + scheme.verificationStatus}>
        {dataset === 'synthetic' ? 'Example: ' : ''}{verificationLabels[scheme.verificationStatus]}
      </span>
    </div>
  );
}

export function SchemeCard({ scheme, returnTo, match }) {
  return (
    <article className="scheme-card">
      <p className="category">{scheme.categoryIds.join(' · ')}</p>
      <h3><Link to={'/schemes/' + scheme._id} state={{ returnTo }}>{scheme.canonicalName}</Link></h3>
      <p className="card-description">{scheme.description}</p>
      <div className="card-meta">
        <span>{scope(scheme)}</span>
        <span>{scheme.governmentLevel === 'central' ? 'Central' : 'State'}</span>
        <span>Last checked {formatDate(scheme.lastVerifiedAt)}</span>
      </div>
      <SchemeStatuses scheme={scheme} />
      {match && <MatchExplanation match={match} />}
    </article>
  );
}
