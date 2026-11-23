import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { readConfig } from '../api/src/config/env.js';
import { configuredExtractionProvider, extractProposal, mockProvider } from '../api/src/modules/extraction/providers.js';
import { validateProposal } from '../api/src/modules/extraction/evidence.js';
import { ExtractionRequestError, geminiBudgetDatabase } from '../api/src/modules/extraction/gemini-budget.js';

const manualGeminiLimit = 5;
const fixtures = JSON.parse(await readFile(new URL('../api/test/fixtures/extraction/synthetic.json', import.meta.url), 'utf8'));
if (fixtures.dataset !== 'synthetic') throw new Error('Evaluation accepts only the independently labeled synthetic fixture.');

const key = JSON.stringify;
const pathKey = paths => key(paths.map(path => key(path.map(condition => key(condition)).sort())).sort());
const round = value => Math.round(value * 1000) / 1000;
const ratio = (numerator, denominator) => denominator ? round(numerator / denominator) : null;
const questionSet = paths => [...new Set(paths.flat().map(([attribute]) => attribute))].sort();

async function evaluate(provider, examples, usage) {
  const totals = { proposed: 0, matched: 0, expected: 0, schemaValid: 0, questionSetsCorrect: 0,
    reviewableQuestionSetsCorrect: 0, proposedQuestionSetsCorrect: 0, exactPathways: 0,
    eligibleForHumanApproval: 0, blockedForReview: 0, dispositionCorrect: 0, requestFailures: 0 };
  const cases = [];
  const timings = [];
  for (const fixture of examples) {
    const start = performance.now();
    const beforeUsage = usage?.length;
    const expectedQuestions = questionSet(fixture.expectedPaths);
    let extraction;
    try {
      extraction = await extractProposal(provider, {
        text: fixture.text,
        ...(provider.timeoutMs && { signal: AbortSignal.timeout(provider.timeoutMs) }),
      });
    } catch (error) {
      const failure = error instanceof ExtractionRequestError
        ? { errorCode: error.code, ...(error.diagnostic && { diagnostic: error.diagnostic }) }
        : { errorCode: 'PROVIDER_UNAVAILABLE' };
      totals.requestFailures++;
      timings.push(performance.now() - start);
      cases.push({ id: fixture.id, expectedPaths: fixture.expectedPaths, expectedQuestions,
        expectedApproval: fixture.expectedApproval, processingMs: round(timings.at(-1)), ...failure,
        ...(usage && { usage: null }),
      });
      break;
    }
    const result = validateProposal({
      text: fixture.text, field: 'eligibilityText', url: 'https://evaluation.example.invalid/' + fixture.id,
    }, extraction?.proposal, undefined, extraction?.outputDiagnostic);
    timings.push(performance.now() - start);
    const proposedPaths = result.proposal.paths.map(path => path.map(({ attribute, operator, value }) => [attribute, operator, value]));
    const proposed = new Set(proposedPaths.flat().map(condition => key(condition)));
    const expected = new Set(fixture.expectedPaths.flat().map(condition => key(condition)));
    const matched = [...proposed].filter(value => expected.has(value)).length;
    const proposedQuestions = provider.id === 'mock' ? questionSet(proposedPaths)
      : [...new Set(result.proposal.questions?.map(question => question.attribute))].sort();
    const actualQuestions = result.valid ? result.questions.map(({ id }) => id).sort() : [];
    const questionsCorrect = result.schemaValid &&
      key(actualQuestions) === key(fixture.expectedApproval ? expectedQuestions : []);
    totals.proposed += proposed.size;
    totals.matched += matched;
    totals.expected += expected.size;
    totals.schemaValid += Number(result.schemaValid);
    totals.questionSetsCorrect += Number(questionsCorrect);
    totals.reviewableQuestionSetsCorrect += Number(fixture.expectedApproval && result.valid && questionsCorrect);
    totals.proposedQuestionSetsCorrect += Number(result.schemaValid && key(proposedQuestions) === key(expectedQuestions));
    totals.exactPathways += Number(result.schemaValid && pathKey(proposedPaths) === pathKey(fixture.expectedPaths));
    totals[result.valid ? 'eligibleForHumanApproval' : 'blockedForReview']++;
    totals.dispositionCorrect += Number(result.valid === fixture.expectedApproval);
    cases.push({
      id: fixture.id, proposedPaths, expectedPaths: fixture.expectedPaths, proposedQuestions, expectedQuestions,
      eligibleForHumanApproval: result.valid, expectedApproval: fixture.expectedApproval, schemaValid: result.schemaValid,
      warnings: result.warnings.map(item => item.code), processingMs: round(timings.at(-1)),
      ...(result.outputDiagnostic && { outputDiagnostic: result.outputDiagnostic }),
      ...(result.validationIssues.length && { validationIssues: result.validationIssues }),
      ...(usage && { usage: usage.length > beforeUsage ? usage.at(-1) : null }),
    });
  }
  timings.sort((a, b) => a - b);
  const percentile = fraction => timings.length ? round(timings[Math.ceil(timings.length * fraction) - 1]) : null;
  return {
    provider: provider.id, version: provider.version, fixtures: cases.length,
    responsesEvaluated: cases.length - totals.requestFailures, ...totals,
    supportedConditionPrecision: ratio(totals.matched, totals.proposed),
    supportedConditionRecall: ratio(totals.matched, totals.expected),
    unsupportedOrInventedRate: ratio(totals.proposed - totals.matched, totals.proposed),
    totalMs: round(timings.reduce((sum, value) => sum + value, 0)),
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), cases,
  };
}

let connection;
try {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { provider: { type: 'string', default: 'mock' },
    limit: { type: 'string' }, offset: { type: 'string', default: '0' }, live: { type: 'boolean', default: false } } });
  const isGemini = values.provider === 'gemini';
  const max = isGemini ? manualGeminiLimit : fixtures.cases.length;
  const offset = Number(values.offset);
  const limit = values.limit === undefined ? (isGemini ? 1 : max - offset) : Number(values.limit);
  if (!['mock', 'gemini'].includes(values.provider) || values.live !== isGemini ||
      !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 ||
      limit > max || offset + limit > fixtures.cases.length) {
    throw new ExtractionRequestError('Use --provider=mock or --provider=gemini --live with a valid --offset and --limit (Gemini maximum 5).');
  }
  const examples = fixtures.cases.slice(offset, offset + limit);
  if (!isGemini) {
    console.log(JSON.stringify(await evaluate(mockProvider, examples), null, 2));
  } else {
    connection = mongoose.createConnection(readConfig(process.env).uri, {
      dbName: geminiBudgetDatabase, autoIndex: false, serverSelectionTimeoutMS: 5000,
    });
    await connection.asPromise();
    const usage = [];
    const provider = configuredExtractionProvider('gemini', name => process.env[name], {
      connection, onUsage: metrics => usage.push(metrics),
    });
    const gemini = await evaluate(provider, examples, usage);
    const mock = await evaluate(mockProvider, examples.slice(0, gemini.responsesEvaluated));
    console.log(JSON.stringify({ dataset: 'synthetic', gemini, mock }, null, 2));
    if (gemini.requestFailures || gemini.schemaValid !== gemini.fixtures) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof ExtractionRequestError ? error.code : 'Extraction evaluation setup failed.');
  process.exitCode = 1;
} finally {
  await connection?.close();
}
