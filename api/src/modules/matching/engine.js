import { conditionLabel } from './criteria.js';

function evaluateCondition(condition, answers) {
  const answer = answers[condition.attribute];
  const label = conditionLabel(condition);
  if (answer === undefined) return { label, status: 'UNKNOWN' };

  let passes = answer === condition.value;
  if (condition.operator === 'atLeast') passes = answer >= condition.value;
  if (condition.operator === 'atMost') passes = answer <= condition.value;
  return { label, status: passes ? 'PASS' : 'FAIL' };
}

function evaluatePath({ complete, conditions }, answers) {
  const checks = conditions.map(condition => evaluateCondition(condition, answers));
  if (!complete) checks.push({ label: 'Additional conditions require source verification', status: 'UNKNOWN' });

  const status = checks.some(check => check.status === 'FAIL') ? 'FAIL'
    : checks.every(check => check.status === 'PASS') ? 'PASS' : 'UNKNOWN';
  return { status, conditions: checks };
}

export function evaluateScheme(rule, answers) {
  if (!rule) {
    return { outcome: 'NEEDS_INFO', reason: 'Eligibility information requires verification.', paths: [] };
  }

  const paths = rule.paths.map(path => evaluatePath(path, answers));
  if (paths.some(path => path.status === 'PASS')) return { outcome: 'POTENTIAL_MATCH', paths };
  if (rule.pathsExhaustive && paths.every(path => path.status === 'FAIL')) {
    return { outcome: 'KNOWN_UNMET', paths };
  }
  return {
    outcome: 'NEEDS_INFO',
    ...(!rule.pathsExhaustive && { reason: 'Other ways to qualify may require source verification.' }),
    paths,
  };
}

export function rankMatches(entries, answers) {
  const groups = { POTENTIAL_MATCH: [], NEEDS_INFO: [], KNOWN_UNMET: [] };
  for (const { schemeId, rule } of entries) {
    const result = evaluateScheme(rule, answers);
    groups[result.outcome].push({ schemeId, ...result });
  }
  return Object.values(groups).flat();
}
