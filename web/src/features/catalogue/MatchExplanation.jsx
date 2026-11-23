const outcomes = {
  POTENTIAL_MATCH: 'Potential match',
  NEEDS_INFO: 'More information needed',
  KNOWN_UNMET: 'Known conditions not met',
};

const checks = {
  PASS: 'Matches',
  FAIL: 'Does not match',
  UNKNOWN: 'More information needed',
};
const outcomeText = {
  POTENTIAL_MATCH: 'Your answers align with a known eligibility pathway.',
  NEEDS_INFO: 'Some answers or verified conditions are missing.',
  KNOWN_UNMET: 'Your answers do not meet one or more known conditions.',
};

export function MatchExplanation({ match }) {
  return (
    <div className={'match-explanation match-' + match.outcome}>
      <div className="match-heading"><strong>{outcomes[match.outcome]}</strong><p>{outcomeText[match.outcome]}</p></div>
      <details>
        <summary>Why this result?</summary>
        {match.reason && <p>{match.reason}</p>}
        {match.paths.map((path, index) => (
          <div key={index}>
            {match.paths.length > 1 && <p className="match-path">Eligibility pathway {index + 1}</p>}
            <ul>
              {path.conditions.map(({ label, status }, index) => (
                <li key={index}><strong className={'check-' + status}>{checks[status]}</strong> · {label}</li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </div>
  );
}
