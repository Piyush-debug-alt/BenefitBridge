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

export function MatchExplanation({ match }) {
  return (
    <div className="match-explanation">
      <span className={'status match-' + match.outcome}>{outcomes[match.outcome]}</span>
      <details>
        <summary>Why this result?</summary>
        {match.reason && <p>{match.reason}</p>}
        {match.paths.map((path, index) => (
          <div key={index}>
            {match.paths.length > 1 && <p className="match-path">Eligibility pathway {index + 1}</p>}
            <ul>
              {path.conditions.map(({ label, status }, index) => (
                <li key={index}><strong>{checks[status]}</strong> · {label}</li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </div>
  );
}
