import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';
import { readConfig } from '../src/config/env.js';
import { configuredExtractionProvider, mockProvider } from '../src/modules/extraction/providers.js';
import { validateProposal } from '../src/modules/extraction/evidence.js';
import { geminiBudgetDatabase, geminiRequestBudget } from '../src/modules/extraction/gemini-budget.js';
import { parseGeminiResponse } from '../src/modules/extraction/gemini-response.js';
import { processExtractionBatch } from '../src/modules/extraction/worker.js';
import { enqueueSync, workSource } from '../src/modules/ingestion/sync.js';

const cache = fileURLToPath(new URL('../../.local/mongodb/', import.meta.url));
const evaluationFixtures = JSON.parse(await readFile(new URL('./fixtures/extraction/synthetic.json', import.meta.url), 'utf8'));
const minAge = 'Eligibility: age at least 18.';
const quote = 'age at least 18';
const proposal = {
  paths: [[{ attribute: 'age', operator: 'atLeast', value: 18, quote }]],
  questions: [{ attribute: 'age', wording: 'alternate' }], unresolved: [],
};
const reference = { field: 'eligibilityText', text: minAge, url: 'https://example.invalid/eligibility' };
const defaultEnv = { GEMINI_API_KEY: 'mock-http-test-key', GEMINI_FREE_TIER_CONFIRMED: 'true' };
const httpText = (text, finishReason = 'STOP') => Response.json({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 35, thoughtsTokenCount: 20, totalTokenCount: 155 },
});
const geminiOutput = ({ paths, ...rest } = proposal) => ({
  ...rest, conditions: paths.flatMap((conditions, index) =>
    conditions.map(condition => ({ ...condition, path: index + 1, value: String(condition.value) }))),
});
const httpProposal = value => httpText(JSON.stringify(geminiOutput(value)));
const candidateResponse = (parts, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts } }] });
const parseOutput = body => parseGeminiResponse(candidateResponse([{ text: JSON.stringify(body) }]));
const httpError = (code, headers) => Response.json({ error: { code, message: 'private provider diagnostic' } }, {
  status: code, headers,
});
const origin = 'http://127.0.0.1:5174';
const dataset = 'synthetic';
let mongo, db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { downloadDir: cache } });
  db = await connectDatabase(readConfig({ DEMO_MONGODB_URI: mongo.getUri() }, { demo: true }));
});

afterAll(async () => {
  await db?.connection.close();
  await mongo?.stop();
});

function provider(fetcher, config = {}, onUsage) {
  const values = { ...defaultEnv, ...config };
  return configuredExtractionProvider('gemini', key => values[key], { fetcher, connection: db.connection, onUsage });
}

const usageCollection = () => db.connection.getClient().db(geminiBudgetDatabase).collection('gemini_request_budget');

it('distinguishes missing, incomplete, empty and invalid JSON responses and reconstructs final text parts', () => {
  const secret = 'private-not-for-diagnostics';
  const text = JSON.stringify(geminiOutput());
  expect(parseGeminiResponse(candidateResponse([
    { text: secret, thought: true }, { text: text.slice(0, 35) }, { text: text.slice(35) },
  ]))).toEqual({ proposal });

  const failures = [
    [{}, 'candidate', '$.candidates[0]', 'missing_candidate'],
    [candidateResponse([]), 'candidate', '$.candidates[0].content.parts', 'empty_text'],
    [candidateResponse([{ text: secret, thought: true }]), 'candidate', '$.candidates[0].content.parts', 'empty_text'],
    [candidateResponse([{ text }], 'MAX_TOKENS'), 'candidate', '$.candidates[0].finishReason', 'incomplete_generation'],
    [candidateResponse([{ text: secret }]), 'json', '$.candidates[0].content.parts', 'invalid_json'],
  ];
  for (const [response, stage, field, reason] of failures) {
    const result = parseGeminiResponse(response);
    expect(result).toMatchObject({ proposal: null, outputDiagnostic: { stage, issues: [{ field, reason }] } });
    expect(JSON.stringify(result)).not.toContain(secret);
  }
  expect(parseGeminiResponse(candidateResponse([], 'MAX_TOKENS')).outputDiagnostic.finishReason).toBe('MAX_TOKENS');
});

it('reports the failing transport or mapping field without guessing missing Gemini values', () => {
  const response = geminiOutput();
  const condition = response.conditions[0];
  const modify = fields => ({ ...response, conditions: [{ ...condition, ...fields }] });
  const cases = [
    [{ ...response, questions: undefined }, 'transport_schema', '$.questions', 'missing_required_field'],
    [modify({ quote: undefined }), 'transport_schema', '$.conditions[0].quote', 'missing_required_field'],
    [modify({ operator: undefined }), 'transport_schema', '$.conditions[0].operator', 'missing_required_field'],
    [modify({ value: 18 }), 'transport_schema', '$.conditions[0].value', 'wrong_type'],
    [modify({ operator: '>=' }), 'transport_schema', '$.conditions[0].operator', 'unsupported_value'],
    [modify({ value: '18 years' }), 'condition_mapping', '$.conditions[0].value', 'invalid_value_encoding'],
    [modify({ value: '121' }), 'condition_mapping', '$.conditions[0].value', 'above_maximum'],
    [modify({ attribute: 'employed', value: 'true' }), 'condition_mapping', '$.conditions[0].operator', 'operator_requires_equality'],
    [modify({ path: 6 }), 'transport_schema', '$.conditions[0].path', 'above_maximum'],
    [{ ...response, questions: [{ attribute: 'age', wording: 'free text' }] },
      'transport_schema', '$.questions[0].wording', 'unsupported_value'],
    [{ ...response, questions: [{ attribute: 'age', wording: 'Are you currently employed?' }] },
      'transport_schema', '$.questions[0].wording', 'unsupported_value'],
    [{ ...response, questions: [{ attribute: 'dateOfBirth', wording: 'What is your age in years?' }] },
      'transport_schema', '$.questions[0].attribute', 'unsupported_value'],
    [proposal, 'transport_schema', '$.conditions', 'missing_required_field'],
    [{ ...response, conditions: Array(11).fill(condition) }, 'pathway_mapping', '$.conditions[10].path', 'too_many_conditions_in_pathway'],
  ];
  for (const [body, stage, field, reason] of cases) {
    expect(parseOutput(body)).toMatchObject({
      proposal: null, outputDiagnostic: { stage, issues: expect.arrayContaining([{ field, reason,
        ...((field === '$.questions' || field === '$.conditions') && { expected: 'array' }),
        ...((reason === 'wrong_type' || field.endsWith('.quote')) && { expected: 'string' }),
      }]) },
    });
  }
  const privateField = 'never-echo-private-field';
  const privateValue = 'never-echo-private-value';
  const extra = parseOutput({ ...response, [privateField]: privateValue });
  expect(extra.outputDiagnostic.issues).toEqual([{ field: '$', reason: 'unexpected_fields' }]);
  expect(JSON.stringify(extra)).not.toContain(privateField);
  expect(JSON.stringify(extra)).not.toContain(privateValue);
});

it.each([
  ['standard', 'standard', 'What is your age in years?'],
  ['alternate', 'alternate', 'How old are you in years?'],
  ['What is your age in years?', 'standard', 'What is your age in years?'],
  ['How old are you in years?', 'alternate', 'How old are you in years?'],
])('maps Gemini question wording %s to the approved age question', (wording, code, label) => {
  const response = geminiOutput({ ...proposal, questions: [{ attribute: 'age', wording }] });
  const parsed = parseOutput(response);
  expect(parsed).toEqual({ proposal: { ...proposal, questions: [{ attribute: 'age', wording: code }] } });
  const result = validateProposal(reference, parsed.proposal);
  expect(result).toMatchObject({
    valid: true, schemaValid: true, questions: [{ id: 'age', label }],
    rule: { questionWording: { age: code } },
  });
});

it('runs evidence checks only after schema validation and keeps question and pathway failures distinct', () => {
  const invalid = parseOutput({ ...geminiOutput(), questions: undefined });
  expect(validateProposal(reference, invalid.proposal, undefined, invalid.outputDiagnostic)).toMatchObject({
    valid: false, schemaValid: false, warnings: [{ code: 'INVALID_PROPOSAL_SCHEMA' }],
    outputDiagnostic: invalid.outputDiagnostic, evidence: [],
  });
  expect(validateProposal(reference, proposal)).toMatchObject({ valid: true, schemaValid: true, validationIssues: [] });
  expect(validateProposal(reference, { ...proposal, paths: [] }).validationIssues).toContainEqual({
    field: '$.paths', reason: 'missing_supported_conditions',
  });
  const mismatched = validateProposal(reference, {
    ...proposal, paths: [[{ ...proposal.paths[0][0], quote: 'age at least 17' }]],
  });
  expect(mismatched).toMatchObject({ valid: false, schemaValid: true });
  expect(mismatched.validationIssues).toContainEqual({ field: '$.paths[0][0].quote', reason: 'quote_not_in_source' });
  const incorrectValue = validateProposal(reference, {
    ...proposal, paths: [[{ ...proposal.paths[0][0], value: 19 }]],
  });
  expect(incorrectValue.validationIssues).toContainEqual({ field: '$.paths[0][0]', reason: 'condition_does_not_match_quote' });
  expect(validateProposal(reference, {
    ...proposal, questions: [{ attribute: 'employed', wording: 'standard' }],
  }).validationIssues).toContainEqual({ field: '$.questions[0].attribute', reason: 'question_without_condition' });
  expect(validateProposal(reference, proposal, { age: 'invented' })).toMatchObject({ schemaValid: false, valid: false });

  const grouping = validateProposal({ ...reference, text: 'Eligibility: age at least 18 and currently studying.' }, {
    ...proposal, paths: [proposal.paths[0], [{ attribute: 'currentlyStudying', operator: 'eq', value: true, quote: 'currently studying' }]],
  });
  expect(grouping).toMatchObject({ valid: false, schemaValid: true,
    warnings: [{ code: 'PATHWAYS_DO_NOT_MATCH_EVIDENCE' }],
    validationIssues: [{ field: '$.paths', reason: 'pathways_do_not_match_evidence' }],
  });
});

it.each([
  ['between 18 and 25', 'between 18 and 25', 'aged between 18 and 25'],
  ['between 18 and  25', 'between 18 and  25', 'aged between 18 and  25'],
  ['18 to 25', '18 to 25', 'aged 18 to 25'],
  ['18–25 years old', '18–25 years old', 'aged 18–25 years old'],
])('accepts complete exact range quotes for %s and rejects unsupported bounds', (phrase, lowerQuote, upperQuote) => {
  const fixture = evaluationFixtures.cases.find(({ id }) => id === 'age-range-and-study');
  const input = { ...reference, text: fixture.text.replace('between 18 and 25', phrase) };
  const fullQuote = 'be aged ' + phrase;
  const quotes = [lowerQuote, upperQuote, 'currently studying'];
  const paths = fixture.expectedPaths.map(path => path.map(([attribute, operator, value], index) => ({
    attribute, operator, value, quote: quotes[index],
  })));
  const parsed = parseOutput(geminiOutput({ paths, questions: [], unresolved: [] }));
  const result = validateProposal(input, parsed.proposal);
  expect(result).toMatchObject({ schemaValid: true, valid: fixture.expectedApproval, validationIssues: [] });
  expect(result.evidence[0].slice(0, 2).map(condition => condition.quote)).toEqual([fullQuote, fullQuote]);
  expect(result.proposal.paths).toEqual(paths);

  for (const changed of [{ value: 26 }, { quote: '25' }, { quote: phrase.replace('25', '26') }]) {
    const draft = structuredClone(parsed.proposal);
    Object.assign(draft.paths[0][1], changed);
    expect(validateProposal(input, draft)).toMatchObject({ schemaValid: true, valid: false });
  }
  expect(validateProposal({ ...input, text: input.text.replace('must be', 'must usually be') }, parsed.proposal))
    .toMatchObject({ schemaValid: true, valid: false, warnings: expect.arrayContaining([
      expect.objectContaining({ code: 'AMBIGUOUS_LOGIC_OR_CONDITION' }),
    ]) });
});

it('keeps the frozen ambiguous minimum unresolved and rejects unknown Gemini reason codes', () => {
  const fixture = evaluationFixtures.cases.find(({ id }) => id === 'ambiguous-minimum');
  const input = { ...reference, text: fixture.text };
  const quote = 'age usually at least 18';
  const output = geminiOutput({ paths: fixture.expectedPaths, questions: [], unresolved: [{ quote, reason: 'ambiguous' }] });
  const parsed = parseOutput(output);
  const result = validateProposal(input, parsed.proposal);
  expect(result).toMatchObject({ schemaValid: true, valid: fixture.expectedApproval, evidence: [], questions: [],
    warnings: expect.arrayContaining([{ code: 'UNRESOLVED_MODEL_CONDITION', quote, reason: 'ambiguous' }]),
  });
  expect(result).not.toHaveProperty('rule');
  expect(parseOutput({ ...output, unresolved: [{ quote, reason: 'not-a-reason-code' }] })).toEqual({
    proposal: null, outputDiagnostic: { stage: 'transport_schema', issues: [
      { field: '$.unresolved[0].reason', reason: 'unsupported_value' },
    ] },
  });
});

it('selects only configured free-tier candidates, with explicit confirmation and mocked SDK requests', async () => {
  const onUsage = vi.fn();
  const fetcher = vi.fn(async () => httpProposal());
  expect(configuredExtractionProvider('off')).toBeNull();
  expect(configuredExtractionProvider('mock')).toBe(mockProvider);
  expect(() => provider(fetcher, { GEMINI_FREE_TIER_CONFIRMED: 'false' })).toThrow('GEMINI_CONFIG_REQUIRED');
  expect(() => provider(fetcher, { GEMINI_MODEL: 'gemini-paid-other' })).toThrow('GEMINI_CONFIG_REQUIRED');
  expect(() => provider(fetcher, { GEMINI_DAILY_REQUEST_LIMIT: '0' })).toThrow('GEMINI_CONFIG_REQUIRED');
  expect(fetcher).not.toHaveBeenCalled();

  const gemini = provider(fetcher, {}, onUsage);
  expect(gemini.accepts({ dataset: 'authorized', sourceId: 'pib-scheme-pilot', field: 'eligibilityText' })).toBe(false);
  const approved = provider(fetcher, { GEMINI_ALLOWED_SOURCE_IDS: 'public-scheme-source' });
  expect(approved.accepts({ dataset: 'authorized', sourceId: 'public-scheme-source', field: 'eligibilityText' })).toBe(true);
  expect(approved.accepts({ dataset: 'authorized', sourceId: 'public-scheme-source', field: 'description' })).toBe(false);
  expect(await gemini.extract({ text: minAge, signal: AbortSignal.timeout(5000) })).toEqual(proposal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
  expect(new Headers(init.headers).get('x-goog-api-key')).toBe(defaultEnv.GEMINI_API_KEY);
  const payload = JSON.parse(init.body);
  expect(payload.contents).toEqual([{ role: 'user', parts: [{ text: minAge }] }]);
  expect(payload.generationConfig).toEqual({
    maxOutputTokens: 2048,
    responseMimeType: 'application/json',
    responseJsonSchema: {
      type: 'object', required: ['conditions', 'questions', 'unresolved'],
      properties: {
        conditions: {
          type: 'array', items: { type: 'object', required: ['path', 'attribute', 'operator', 'value', 'quote'],
            properties: { path: { type: 'integer' }, attribute: { type: 'string' }, operator: { type: 'string' },
              value: { type: 'string' }, quote: { type: 'string' } } },
        },
        questions: {
          type: 'array', items: { type: 'object', required: ['attribute', 'wording'],
            properties: { attribute: { type: 'string' }, wording: { type: 'string', enum: ['standard', 'alternate'] } } },
        },
        unresolved: {
          type: 'array', items: { type: 'object', required: ['quote', 'reason'],
            properties: { quote: { type: 'string' }, reason: { type: 'string', enum: ['unsupported', 'ambiguous'] } } },
        },
      },
    },
  });
  expect(payload).not.toHaveProperty('tools');
  expect(onUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 35, thinkingTokens: 20, totalTokens: 155 });
  expect(validateProposal(reference, proposal).questions[0].label).toBe('How old are you in years?');
  expect(validateProposal(reference, proposal, { age: 'standard' }).questions[0].label).toBe('What is your age in years?');

  const fallback = provider(fetcher, { GEMINI_MODEL: 'gemini-3.5-flash-lite' });
  await fallback.extract({ text: minAge });
  expect(fetcher.mock.lastCall[0]).toContain('/models/gemini-3.5-flash-lite:generateContent');
});

it('rejects malformed, truncated, invented and unsupported output and sanitizes provider errors', async () => {
  await usageCollection().deleteMany({});
  const timer = new AbortController();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(httpText('unfinished JSON'))
    .mockResolvedValueOnce(httpText(JSON.stringify(geminiOutput()), 'MAX_TOKENS'))
    .mockResolvedValueOnce(httpProposal({ ...proposal, paths: [[{ ...proposal.paths[0][0], value: '18 years' }]] }))
    .mockResolvedValueOnce(httpProposal({ ...proposal, paths: [[{ ...proposal.paths[0][0], value: 35 }]] }))
    .mockResolvedValueOnce(httpError(503))
    .mockResolvedValueOnce(httpError(404))
    .mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      timer.abort(new DOMException('test timeout', 'TimeoutError'));
    }));
  const gemini = provider(fetcher);
  expect(await gemini.extract({ text: minAge })).toBeNull();
  expect(await gemini.extract({ text: minAge })).toBeNull();
  const wrongType = await gemini.extract({ text: minAge });
  expect(validateProposal(reference, wrongType).schemaValid).toBe(false);
  const invented = await gemini.extract({ text: minAge });
  expect(validateProposal(reference, invented)).toMatchObject({
    valid: false, warnings: expect.arrayContaining([expect.objectContaining({ code: 'UNSUPPORTED_OR_INVENTED_PROPOSAL' })]),
  });
  const condition = 'possess a district certificate';
  expect(validateProposal({ ...reference, text: minAge + ' Applicants must ' + condition + '.' }, {
    ...proposal, unresolved: [{ quote: condition, reason: 'unsupported' }],
  }).warnings).toContainEqual({ code: 'UNRESOLVED_MODEL_CONDITION', quote: condition, reason: 'unsupported' });
  await expect(gemini.extract({ text: minAge })).rejects.toMatchObject({
    message: 'PROVIDER_UNAVAILABLE', retryable: true,
  });
  await expect(gemini.extract({ text: minAge })).rejects.toMatchObject({
    message: 'GEMINI_MODEL_UNAVAILABLE', retryable: false,
  });
  await expect(gemini.extract({ text: minAge, signal: timer.signal })).rejects.toMatchObject({
    message: 'EXTRACTION_TIMEOUT', retryable: true,
  });
  expect(fetcher).toHaveBeenCalledTimes(7);
});

it('preserves safe HTTP diagnostics without exposing error messages, metadata, or network details', async () => {
  await usageCollection().deleteMany({});
  const fetcher = vi.fn();
  const gemini = provider(fetcher);
  const cases = [
    [400, 'invalid_request', 'INVALID_ARGUMENT'],
    [401, 'authentication', 'UNAUTHENTICATED'],
    [403, 'permission', 'PERMISSION_DENIED'],
    [404, 'model_unavailable', 'NOT_FOUND'],
    [503, 'upstream_failure', 'UNAVAILABLE'],
    [429, 'quota', 'RESOURCE_EXHAUSTED'],
  ];
  for (const [status, category, googleStatus] of cases) {
    fetcher.mockResolvedValueOnce(Response.json({ error: {
      code: status, status: googleStatus, message: 'private response with ' + defaultEnv.GEMINI_API_KEY,
      details: [{ reason: 'PRIVATE_UNRECOGNIZED_REASON', metadata: { credential: defaultEnv.GEMINI_API_KEY } },
        ...(status === 400 ? [{
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{
            field: 'generation_config.response_json_schema.properties[paths].items.items.properties[value].type',
            description: 'private description with ' + defaultEnv.GEMINI_API_KEY,
          }, { field: 'generationConfig.' + defaultEnv.GEMINI_API_KEY }],
        }] : [])],
    } }, { status }));
    const error = await gemini.extract({ text: minAge }).catch(value => value);
    expect(error.diagnostic).toEqual({
      source: 'google', category, httpStatus: status, googleStatus,
      ...(status === 400 && { rejectedFields: ['responseJsonSchema.properties.paths.items.items.properties.value.type'] }),
    });
    expect(String(error)).not.toContain('private response');
    expect(JSON.stringify(error)).not.toContain(defaultEnv.GEMINI_API_KEY);
  }
  expect(fetcher).toHaveBeenCalledTimes(cases.length);
  await usageCollection().deleteOne({ _id: 'cooldown' });
  fetcher.mockResolvedValueOnce(Response.json({ error: {
    status: 'INVALID_ARGUMENT', message: 'The response schema has too many states. ' + defaultEnv.GEMINI_API_KEY,
  } }, { status: 400 }));
  await expect(gemini.extract({ text: minAge })).rejects.toMatchObject({
    code: 'GEMINI_REQUEST_REJECTED', diagnostic: { httpStatus: 400, schemaIssue: 'complexity' },
  });
  fetcher.mockRejectedValueOnce(new TypeError('private network detail', {
    cause: Object.assign(new Error('private DNS detail'), { code: 'ENOTFOUND' }),
  }));
  await expect(gemini.extract({ text: minAge })).rejects.toMatchObject({
    code: 'PROVIDER_UNAVAILABLE', diagnostic: { source: 'transport', category: 'dns', transportCode: 'ENOTFOUND' },
  });
  fetcher.mockResolvedValueOnce(new Response('{malformed', { headers: { 'Content-Type': 'application/json' } }));
  await expect(gemini.extract({ text: minAge })).rejects.toMatchObject({
    code: 'GEMINI_INVALID_RESPONSE', diagnostic: { source: 'google', category: 'invalid_response', httpStatus: 200 },
  });
});

it('rebuilds AND/OR pathways and enforces local bounds on the flatter transport response', async () => {
  await usageCollection().deleteMany({});
  const text = 'Eligibility: either age at least 18 and currently studying or reside in MH.';
  const draft = {
    paths: [
      [{ attribute: 'age', operator: 'atLeast', value: 18, quote },
        { attribute: 'currentlyStudying', operator: 'eq', value: true, quote: 'currently studying' }],
      [{ attribute: 'residentState', operator: 'eq', value: 'MH', quote: 'reside in MH' }],
    ],
    questions: [], unresolved: [],
  };
  const valid = geminiOutput(draft);
  const badPath = { ...valid, conditions: [{ ...valid.conditions[0], path: 6 }] };
  const overlongPath = { ...valid, conditions: Array(11).fill(valid.conditions[0]) };
  const wrongType = { ...valid, conditions: [{ ...valid.conditions[0], value: 18 }] };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(httpText(JSON.stringify(valid)))
    .mockResolvedValueOnce(httpText(JSON.stringify(badPath)))
    .mockResolvedValueOnce(httpText(JSON.stringify(overlongPath)))
    .mockResolvedValueOnce(httpText(JSON.stringify(wrongType)));
  const gemini = provider(fetcher);
  expect(await gemini.extract({ text })).toEqual(draft);
  expect(validateProposal({ ...reference, text }, draft).valid).toBe(true);
  for (let i = 0; i < 3; i++) expect(await gemini.extract({ text })).toBeNull();
});

it('distinguishes local request-budget storage errors before sending data to Google', async () => {
  const fetcher = vi.fn();
  const collection = { findOne: vi.fn().mockRejectedValue(new Error('private database detail')) };
  const connection = { getClient: () => ({ db: () => ({ collection: () => collection }) }) };
  const gemini = configuredExtractionProvider('gemini', name => defaultEnv[name], { connection, fetcher });
  await expect(gemini.extract({ text: minAge })).rejects.toMatchObject({
    message: 'GEMINI_BUDGET_STORAGE_FAILED', diagnostic: { source: 'application', category: 'budget_storage' },
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it('shares a durable daily allowance across workers and honors a quota cooldown without dispatching another call', async () => {
  await usageCollection().deleteMany({});
  const date = Date.parse('2026-11-22T12:00:00Z');
  const first = geminiRequestBudget(db.connection, 3, () => date);
  const second = geminiRequestBudget(db.connection, 3, () => date);
  const claims = await Promise.allSettled([first.reserve(), second.reserve(), first.reserve(), second.reserve()]);
  expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(3);
  expect(claims.find(result => result.status === 'rejected').reason).toMatchObject({ code: 'GEMINI_DAILY_LIMIT', deferred: true });
  await expect(geminiRequestBudget(db.connection, 3, () => date + 86_400_000).reserve()).resolves.toBeUndefined();

  const fetcher = vi.fn(async () => httpError(429, { 'Retry-After': '120' }));
  const gemini = provider(fetcher);
  await expect(gemini.extract({ text: minAge })).rejects.toMatchObject({
    code: 'GEMINI_QUOTA_EXHAUSTED', retryable: true, retryAt: expect.any(Date),
  });
  const stored = await usageCollection().findOne({ _id: 'cooldown' });
  expect(stored.retryAt.getTime() - Date.now()).toBeGreaterThan(110_000);
  await expect(provider(fetcher).extract({ text: minAge })).rejects.toMatchObject({
    code: 'GEMINI_QUOTA_COOLDOWN', deferred: true, retryAt: stored.retryAt,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('stages mocked Gemini proposals, retries transient failures, publishes only approved evidence, and caches replays', async () => {
  await usageCollection().deleteMany({});
  const input = JSON.parse(await readFile(new URL('./fixtures/synthetic/extraction-snapshot.json', import.meta.url), 'utf8'));
  const eligibilityUrl = reference.url.replace('example.invalid', 'extraction.example.invalid');
  const record = { ...input.records[0], eligibilityText: minAge,
    sourceRefs: [...input.records[0].sourceRefs, { url: eligibilityUrl, label: 'Eligibility conditions' }] };
  const metadata = { ...input.source, evidenceOrigins: [input.source.baseUrl] };
  const adapter = (changed, checkpoint, complete = true) => ({
    metadata, incremental: true,
    async page() {
      const updatedAt = changed.eligibilityText === minAge ? '2026-11-01T00:00:00Z' : '2026-11-02T00:00:00Z';
      return { records: [{ record: changed, updatedAt, fieldProvenance: {
        eligibilityText: [eligibilityUrl],
      } }], nextCursor: null, ...(complete && { checkpoint }) };
    },
  });
  const fetcher = vi.fn().mockResolvedValueOnce(httpError(503))
    .mockResolvedValueOnce(httpError(429, { 'Retry-After': '120' }))
    .mockImplementation(async () => httpProposal());
  const gemini = provider(fetcher);
  const { models } = db;
  async function sync(feed) {
    await enqueueSync(models, dataset, metadata.id, 'incremental');
    return workSource(models, dataset, feed, { extractionProvider: gemini });
  }
  const initial = adapter(record, 'first');
  // A failed feed can stage evidence, but it cannot send that evidence to Gemini.
  expect((await sync(adapter(record, 'ignored', false))).status).toBe('failed');
  expect(await processExtractionBatch(models, dataset, metadata.id, gemini)).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await sync(initial)).status).toBe('succeeded');
  await models.EligibilityExtraction.updateMany({}, { $set: { availableAt: new Date(0) } });
  expect(await processExtractionBatch(models, dataset, metadata.id, gemini)).toBe(1);
  const attempt = await models.EligibilityExtraction.findOne({ provider: 'gemini' }).lean();
  expect(attempt).toMatchObject({ status: 'queued', attempts: 1, errorCode: 'PROVIDER_UNAVAILABLE',
    failureDiagnostic: { source: 'google', category: 'upstream_failure', httpStatus: 503 } });
  await models.EligibilityExtraction.updateOne({ _id: attempt._id }, { $set: { availableAt: new Date(0) } });
  expect(await processExtractionBatch(models, dataset, metadata.id, gemini)).toBe(1);
  const limited = await models.EligibilityExtraction.findById(attempt._id).lean();
  expect(limited).toMatchObject({ status: 'queued', attempts: 2, errorCode: 'GEMINI_QUOTA_EXHAUSTED' });
  expect(limited.availableAt.getTime()).toBeGreaterThan(Date.now());
  await models.EligibilityExtraction.updateOne({ _id: attempt._id }, { $set: { availableAt: new Date(0) } });
  expect(await processExtractionBatch(models, dataset, metadata.id, gemini)).toBe(0);
  expect(await models.EligibilityExtraction.findById(attempt._id).lean()).toMatchObject({
    status: 'queued', attempts: 2, errorCode: 'GEMINI_QUOTA_COOLDOWN',
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await usageCollection().deleteOne({ _id: 'cooldown' });
  await models.EligibilityExtraction.updateOne({ _id: attempt._id }, { $set: { availableAt: new Date(0) } });
  expect(await processExtractionBatch(models, dataset, metadata.id, gemini)).toBe(1);
  expect(await models.SchemeRuleVersion.countDocuments()).toBe(0);
  const app = createApp({ models, dataset, isReady: () => true });
  const admin = request.agent(app);
  const credentials = { email: 'gemini-reviewer@example.test', password: 'test-only-reviewer-password' };
  await admin.post('/api/v1/auth/register').set('Origin', origin).send(credentials).expect(202);
  await models.User.updateOne({ email: credentials.email }, { $set: { isAdministrator: true } });
  await admin.post('/api/v1/auth/login').set('Origin', origin).send(credentials).expect(200);
  const review = await models.ReviewCase.findOne({ externalRecordId: record.externalRecordId }).lean();
  const path = '/api/v1/admin/reviews/' + review._id + '/extraction';
  const draft = (await admin.get(path).expect(200)).body;
  expect(draft.preview).toMatchObject({ valid: true, evidence: [[{ url: eligibilityUrl, quote }]] });
  expect((await request(app).get('/api/v1/schemes').expect(200)).body.items).toEqual([]);
  await admin.post(path + '/decision').set('Origin', origin)
    .send({ action: 'approve', reason: 'Compared the exact source clause and questionnaire wording' }).expect(200);
  expect(await models.SchemeRuleVersion.countDocuments()).toBe(0);
  expect((await workSource(models, dataset, initial)).reviewed).toBe(1);
  const published = await models.Scheme.findOne({ sourceId: metadata.id }).lean();
  const rule = await models.SchemeRuleVersion.findOne({ schemeVersionId: published.currentVersionId }).lean();
  expect(rule.extractionProvenance.provider).toBe('gemini');
  const guest = request(app);
  const schemeId = String(published._id);
  const questions = (await guest.get('/api/v1/questions').query({ schemeIds: schemeId }).expect(200)).body.questions;
  expect(questions).toMatchObject([{ id: 'age', label: 'How old are you in years?' }]);
  const match = await guest.post('/api/v1/matches/evaluate').send({ schemeIds: [schemeId], answers: { age: 18 } }).expect(200);
  expect(match.body.results[0].outcome).toBe('POTENTIAL_MATCH');
  expect((await sync(initial)).status).toBe('succeeded');
  await processExtractionBatch(models, dataset, metadata.id, gemini);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(await models.EligibilityExtraction.countDocuments({ provider: 'gemini' })).toBe(1);

  const revision = adapter({ ...record, eligibilityText: 'Eligibility: age at least 19.' }, 'revision');
  fetcher.mockImplementationOnce(async () => httpProposal({
    ...proposal, paths: [[{ ...proposal.paths[0][0], value: 19, quote: 'age at least 19' }]],
  }));
  expect((await sync(revision)).status).toBe('succeeded');
  await processExtractionBatch(models, dataset, metadata.id, gemini);
  const update = await models.ReviewCase.findOne({ status: 'pending', externalRecordId: record.externalRecordId }).lean();
  const sourceReviewPath = '/api/v1/admin/reviews/' + update._id;
  const updatePath = sourceReviewPath + '/extraction/decision';
  expect(await models.EligibilityExtraction.findById(update.extractionId).lean()).toMatchObject({ status: 'ready' });
  expect((await workSource(models, dataset, revision)).reviewed).toBe(0);
  expect(await models.SchemeRuleVersion.countDocuments()).toBe(1);
  expect(String((await models.Scheme.findById(schemeId)).currentVersionId)).toBe(String(published.currentVersionId));
  await admin.post(updatePath).set('Origin', origin)
    .send({ action: 'approve', reason: 'Existing rule replacement requires confirmation' }).expect(409);
  await admin.post(updatePath).set('Origin', origin)
    .send({ action: 'reject', reason: 'Keep the validated age requirement at 18' }).expect(200);
  await admin.post(updatePath).set('Origin', origin)
    .send({ action: 'approve', reason: 'Rejected proposals cannot be approved', replaceExistingRule: true }).expect(409);
  await workSource(models, dataset, revision);
  expect(String((await models.Scheme.findById(schemeId)).currentVersionId)).toBe(String(published.currentVersionId));
  expect(await models.SchemeRuleVersion.countDocuments()).toBe(1);
  expect((await guest.get('/api/v1/questions').query({ schemeIds: schemeId }).expect(200)).body.questions).toEqual([]);
  await admin.post(sourceReviewPath + '/decision').set('Origin', origin)
    .send({ action: 'reject', reason: 'Keep the verified source version' }).expect(200);
  expect((await workSource(models, dataset, revision)).reviewed).toBe(1);
  const afterRejection = await guest.post('/api/v1/matches/evaluate')
    .send({ schemeIds: [schemeId], answers: { age: 18 } }).expect(200);
  expect(afterRejection.body.results[0].outcome).toBe('POTENTIAL_MATCH');
  expect(fetcher).toHaveBeenCalledTimes(4);
});

function runGeminiEvaluation(program) {
  return promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], {
    env: { ...process.env, ...defaultEnv, GEMINI_MODEL: 'gemini-3.1-flash-lite',
      GEMINI_DAILY_REQUEST_LIMIT: '10', MONGODB_URI: mongo.getUri(), MONGODB_DATABASE: 'benefitbridge_eval' },
    windowsHide: true,
  });
}

it.each([
  ['minimum-age', 0, true], ['minimum-age', 0, false], ['ambiguous-minimum', 4, false],
])('scores the %s fixture at offset %i from one mocked response (valid response: %s)', async (id, offset, valid) => {
  await usageCollection().deleteMany({});
  const runner = new URL('../../scripts/evaluate-extraction.mjs', import.meta.url);
  const content = valid ? geminiOutput({
    ...proposal, questions: [{ attribute: 'age', wording: 'How old are you in years?' }],
  }) : { ...geminiOutput({ ...proposal, paths: [] }), questions: undefined };
  const output = { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(content) }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 35, totalTokenCount: 135 } };
  const program = `
    import assert from 'node:assert/strict';
    let requests = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(++requests, 1);
      assert.equal(new URL(url).hostname, 'generativelanguage.googleapis.com');
      assert.equal(JSON.parse(init.body).contents[0].parts[0].text, ${JSON.stringify(evaluationFixtures.cases[offset].text)});
      return Response.json(${JSON.stringify(output)});
    };
    process.argv.push('evaluate-extraction.mjs', '--provider=gemini', '--live', '--limit=1', '--offset=${offset}');
    await import(${JSON.stringify(runner.href)});
    assert.equal(requests, 1);
  `;
  const run = runGeminiEvaluation(program);
  const { stdout } = valid ? await run : await run.catch(error => {
    expect(error.code).toBe(1);
    return error;
  });
  const result = JSON.parse(stdout);
  if (valid) {
    expect(result.gemini).toMatchObject({ fixtures: 1, matched: 1, exactPathways: 1,
      questionSetsCorrect: 1, proposedQuestionSetsCorrect: 1 });
    expect(result.gemini.cases[0]).toMatchObject({
      id: 'minimum-age', proposedPaths: result.mock.cases[0].expectedPaths, usage: { totalTokens: 135 },
    });
  } else {
    expect(result.gemini).toMatchObject({ fixtures: 1, matched: 0, schemaValid: 0, questionSetsCorrect: 0, requestFailures: 0 });
    expect(result.gemini.cases[0]).toMatchObject({
      id, warnings: ['INVALID_PROPOSAL_SCHEMA'], usage: { totalTokens: 135 },
      outputDiagnostic: { stage: 'transport_schema', issues: [{ field: '$.questions', reason: 'missing_required_field', expected: 'array' }] },
    });
  }
  expect(result.mock).toMatchObject({ fixtures: 1, matched: evaluationFixtures.cases[offset].expectedPaths.flat().length });
  expect((await usageCollection().findOne({ _id: new Date().toISOString().slice(0, 10) })).requests).toBe(1);
});

it('stops the manual batch on HTTP 429 and excludes the failed request from quality scores', async () => {
  await usageCollection().deleteMany({});
  const runner = new URL('../../scripts/evaluate-extraction.mjs', import.meta.url);
  const program = `
    import assert from 'node:assert/strict';
    let requests = 0;
    globalThis.fetch = async () => {
      ++requests;
      return Response.json({ error: { status: 'RESOURCE_EXHAUSTED' } }, { status: 429 });
    };
    process.argv.push('evaluate-extraction.mjs', '--provider=gemini', '--live', '--limit=4');
    await import(${JSON.stringify(runner.href)});
    assert.equal(requests, 1);
  `;
  const { code, stdout, stderr } = await runGeminiEvaluation(program).catch(error => error);
  expect(code).toBe(1);
  expect(stderr).toBe('');
  const { gemini, mock } = JSON.parse(stdout);
  expect(gemini).toMatchObject({ fixtures: 1, responsesEvaluated: 0, requestFailures: 1,
    supportedConditionPrecision: null, supportedConditionRecall: null, blockedForReview: 0, cases: [{
      id: 'minimum-age', errorCode: 'GEMINI_QUOTA_EXHAUSTED', diagnostic: { httpStatus: 429 }, usage: null,
    }],
  });
  expect(gemini.cases[0]).not.toHaveProperty('schemaValid');
  expect(mock).toMatchObject({ fixtures: 0, responsesEvaluated: 0 });
});

it('keeps malformed Gemini output in review and requires a verified correction before approval', async () => {
  await usageCollection().deleteMany({});
  const input = JSON.parse(await readFile(new URL('./fixtures/synthetic/extraction-snapshot.json', import.meta.url), 'utf8'));
  const metadata = { ...input.source, id: 'gemini-invalid-review', evidenceOrigins: [input.source.baseUrl] };
  const record = { ...input.records[0], externalRecordId: 'gemini-invalid-draft', eligibilityText: minAge };
  const adapter = { metadata, incremental: true, async page() {
    return { records: [{ record, updatedAt: '2026-11-01T00:00:00Z' }], nextCursor: null, checkpoint: 'one' };
  } };
  const fetcher = vi.fn(async () => httpText(JSON.stringify({ ...geminiOutput(), questions: undefined })));
  const gemini = provider(fetcher);
  const { models } = db;
  await enqueueSync(models, dataset, metadata.id, 'incremental');
  expect((await workSource(models, dataset, adapter, { extractionProvider: gemini })).status).toBe('succeeded');
  expect(await processExtractionBatch(models, dataset, metadata.id, gemini)).toBe(1);
  expect(await processExtractionBatch(models, dataset, metadata.id, gemini)).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const review = await models.ReviewCase.findOne({ sourceId: metadata.id }).lean();
  const job = await models.EligibilityExtraction.findById(review.extractionId).lean();
  expect(job).toMatchObject({ status: 'review_required', result: {
    schemaValid: false, outputDiagnostic: { stage: 'transport_schema', issues: [{ field: '$.questions', reason: 'missing_required_field' }] },
  } });
  const app = createApp({ models, dataset, isReady: () => true });
  const admin = request.agent(app);
  const credentials = { email: 'gemini-fix-reviewer@example.test', password: 'test-only-reviewer-password' };
  await admin.post('/api/v1/auth/register').set('Origin', origin).send(credentials).expect(202);
  await models.User.updateOne({ email: credentials.email }, { $set: { isAdministrator: true } });
  await admin.post('/api/v1/auth/login').set('Origin', origin).send(credentials).expect(200);
  const path = '/api/v1/admin/reviews/' + review._id + '/extraction';
  const preview = (await admin.get(path).expect(200)).body.preview;
  expect(preview.outputDiagnostic).toEqual(job.result.outputDiagnostic);
  await admin.post(path + '/decision').set('Origin', origin).send({ action: 'approve', reason: 'Attempted before correction' }).expect(422);
  const corrected = await admin.post(path + '/validate').set('Origin', origin).send({ proposal }).expect(200);
  expect(corrected.body).toMatchObject({ valid: true, schemaValid: true, validationIssues: [] });
  expect(await models.Scheme.countDocuments({ sourceId: metadata.id })).toBe(0);
});
