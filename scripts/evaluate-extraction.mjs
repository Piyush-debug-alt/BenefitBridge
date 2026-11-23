import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { mockProvider } from '../api/src/modules/extraction/providers.js';
import { validateProposal } from '../api/src/modules/extraction/evidence.js';

const fixtures = JSON.parse(await readFile(new URL('../api/test/fixtures/extraction/synthetic.json', import.meta.url), 'utf8'));
if (fixtures.dataset !== 'synthetic') throw new Error('Evaluation accepts only the isolated synthetic fixture.');

const totals = { proposed: 0, matched: 0, expected: 0, schemaValid: 0, questionSetsCorrect: 0,
  exactPathways: 0, eligibleForHumanApproval: 0, blockedForReview: 0, dispositionCorrect: 0 };
const cases = [];
const timings = [];
const key = condition => JSON.stringify(condition);
const pathKey = paths => JSON.stringify(paths.map(path => JSON.stringify(path.map(key).sort())).sort());

for (const fixture of fixtures.cases) {
  const start = performance.now();
  const raw = await mockProvider.extract({ text: fixture.text });
  const result = validateProposal({
    text: fixture.text, field: 'eligibilityText', url: 'https://evaluation.example.invalid/' + fixture.id,
  }, raw);
  timings.push(performance.now() - start);
  const paths = result.proposal.paths.map(path => path.map(({ attribute, operator, value }) => [attribute, operator, value]));
  const proposed = new Set(paths.flat().map(key));
  const expected = new Set(fixture.expectedPaths.flat().map(key));
  const matched = [...proposed].filter(value => expected.has(value)).length;
  const expectedQuestions = fixture.expectedApproval ? [...new Set(fixture.expectedPaths.flat().map(([attribute]) => attribute))] : [];
  const actualQuestions = result.valid ? result.questions.map(({ id }) => id) : [];
  const questionsCorrect = key(actualQuestions.sort()) === key(expectedQuestions.sort());
  totals.proposed += proposed.size;
  totals.matched += matched;
  totals.expected += expected.size;
  totals.schemaValid += Number(result.schemaValid);
  totals.questionSetsCorrect += Number(questionsCorrect);
  totals.exactPathways += Number(pathKey(paths) === pathKey(fixture.expectedPaths));
  totals[result.valid ? 'eligibleForHumanApproval' : 'blockedForReview']++;
  totals.dispositionCorrect += Number(result.valid === fixture.expectedApproval);
  cases.push({ id: fixture.id, proposed: proposed.size, expected: expected.size, matched,
    eligibleForHumanApproval: result.valid, warnings: result.warnings.map(item => item.code) });
}
timings.sort((a, b) => a - b);
const round = value => Math.round(value * 1000) / 1000;
console.log(JSON.stringify({
  provider: mockProvider.id, version: mockProvider.version, fixtures: fixtures.cases.length, ...totals,
  supportedConditionPrecision: round(totals.matched / totals.proposed),
  supportedConditionRecall: round(totals.matched / totals.expected),
  unsupportedOrInventedRate: round((totals.proposed - totals.matched) / totals.proposed),
  totalMs: round(timings.reduce((sum, value) => sum + value, 0)),
  p50Ms: round(timings[Math.ceil(timings.length / 2) - 1]),
  p95Ms: round(timings[Math.ceil(timings.length * 0.95) - 1]),
  cases,
}, null, 2));
