import { z } from 'zod';
import { eligibilityCondition, eligibilitySchema, questionDefinitions, questionsFor, questionWordingCodeSchema, questionWordingSchema, wordingOptions } from '../matching/criteria.js';
import { schemaIssues } from './validation-diagnostics.js';

const attribute = z.enum(questionDefinitions().map(question => question.id));
export const conditionWire = z.strictObject({
  attribute, operator: z.enum(['eq', 'atLeast', 'atMost']),
  value: z.union([z.string().max(2), z.number(), z.boolean()]), quote: z.string().min(1).max(4000),
});
const conditionInput = conditionWire.transform(({ quote, ...condition }, context) => {
  const result = eligibilityCondition.safeParse(condition);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue(issue);
    return z.NEVER;
  }
  return { ...result.data, quote };
});

const paths = condition => z.array(z.array(condition).min(1).max(10)).max(5);
export const unresolvedReasonSchema = z.enum(['unsupported', 'ambiguous']);
export const proposalWireSchema = z.strictObject({
  paths: paths(conditionWire),
  questions: z.array(z.strictObject({ attribute, wording: questionWordingCodeSchema })).max(7).optional(),
  unresolved: z.array(z.strictObject({
    quote: z.string().min(1).max(4000), reason: unresolvedReasonSchema,
  })).max(10).optional(),
});
export const proposalSchema = proposalWireSchema.extend({ paths: paths(conditionInput) });

const compare = { 'at least': 'atLeast', 'at most': 'atMost', 'equal to': 'eq' };
const ageRange = /^(?:age(?:\s+is)?|aged)\s+(?<bounds>(?:(?<min>\d{1,3})(?:\s+(?:to|through)\s+|\s*[-–—]\s*)(?<max>\d{1,3})|between\s+(?<betweenMin>\d{1,3})\s+and\s+(?<betweenMax>\d{1,3}))(?:\s+years(?:\s+old)?)?)$/i;

function parseClause(quote) {
  const clause = quote.replace(/^(?:be |have (?:an? )?)/i, '').trim();
  const add = (attribute, operator, value) => ({ attribute, operator, value, quote });
  const range = ageRange.exec(clause)?.groups;
  if (range) return [add('age', 'atLeast', Number(range.min ?? range.betweenMin)), add('age', 'atMost', Number(range.max ?? range.betweenMax))];
  const age = /^(?:age(?: is)?|aged) (at least|at most|equal to) (\d{1,3})(?: years(?: old)?)?$/i.exec(clause);
  if (age) return [add('age', compare[age[1].toLowerCase()], Number(age[2]))];
  const income = /^annual income (?:is )?(at least|at most|equal to) (?:INR |₹)([\d,]+)$/i.exec(clause);
  if (income && /^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})$/.test(income[2])) {
    return [add('annualIncome', compare[income[1].toLowerCase()], Number(income[2].replaceAll(',', '')))];
  }
  const state = /^(?:reside in|live in|resident of) ([A-Z]{2})$/i.exec(clause);
  if (state) return [add('residentState', 'eq', state[1].toUpperCase())];

  const booleans = [
    ['currentlyStudying', /^(?:currently studying|a current student)$/i, /^(?:not currently studying|not a current student)$/i],
    ['employed', /^(?:currently )?employed$/i, /^(?:not (?:currently )?employed|unemployed)$/i],
    ['ownsHome', /^(?:own a home|a homeowner)$/i, /^(?:do not own a home|not a homeowner)$/i],
    ['hasOwnerPermission', /^(?:(?:have )?homeowner permission|permission from the homeowner)$/i, /^no homeowner permission$/i],
  ];
  for (const [attribute, yes, no] of booleans) {
    if (yes.test(clause)) return [add(attribute, 'eq', true)];
    if (no.test(clause)) return [add(attribute, 'eq', false)];
  }
  return [];
}

export function analyzeSource(text) {
  const warnings = [];
  const sentences = text.split(/[.!?;\r\n]+/).map(value => value.trim()).filter(Boolean);
  let paths = [[]];
  let recognized = 0;
  for (const sentence of sentences) {
    if (/\b(?:ignore|override|disregard)\b.{0,50}\b(?:instruction|prompt|rule|previous|system)|\b(?:you are|return json|system prompt|call a tool|add a condition)\b/i.test(sentence)) {
      warnings.push({ code: 'INSTRUCTION_LIKE_TEXT', quote: sentence });
      continue;
    }
    const eligibility = /^(?:eligibility:\s*|applicants must\s+)(.+)$/i.exec(sentence);
    if (!eligibility) {
      warnings.push({ code: 'UNCLASSIFIED_SOURCE_TEXT', quote: sentence });
      continue;
    }
    recognized++;
    const statement = eligibility[1];
    if (/[()]/.test(statement) || /\b(?:may|usually|unless|exceptions?|and\/or|approximately|about|normally|preferably)\b/i.test(statement) ||
        (/\sor\s/i.test(statement) && !/^either\b/i.test(statement))) {
      warnings.push({ code: 'AMBIGUOUS_LOGIC_OR_CONDITION', quote: sentence });
      continue;
    }
    const branches = statement.replace(/^either\s+/i, '').split(/\s*,?\s+or\s+/i);
    if (/^either\b/i.test(statement) && branches.length < 2) {
      warnings.push({ code: 'AMBIGUOUS_LOGIC_OR_CONDITION', quote: sentence });
      continue;
    }

    // The conjunction can have extra whitespace, including inside an age range.
    const groups = branches.map(branch => branch.split(/\s*,?\s+and\s+(?![\s\d])/i).flatMap(quote => {
      const condition = parseClause(quote.trim());
      if (!condition.length) warnings.push({ code: 'UNSUPPORTED_CONDITION', quote: quote.trim() });
      return condition;
    }));
    if (paths.length * groups.length > 5) {
      warnings.push({ code: 'COMPLEX_ALTERNATIVES', quote: sentence });
      continue;
    }
    paths = paths.flatMap(path => groups.map(group => [...path, ...group]));
  }
  if (!recognized) warnings.push({ code: 'NO_EXPLICIT_ELIGIBILITY' });
  const candidates = paths.filter(path => path.length).map(path => [...new Map(
    path.map(condition => [conditionKey(condition), condition]),
  ).values()]);
  if (candidates.some(path => path.length > 10)) warnings.push({ code: 'TOO_MANY_CONDITIONS' });
  return { paths: candidates.map(path => path.slice(0, 10)), warnings };
}

const conditionKey = condition => JSON.stringify([condition.attribute, condition.operator, condition.value, condition.quote]);
const pathKey = path => JSON.stringify(path.map(conditionKey).sort());
const ruleKey = paths => JSON.stringify(paths.map(pathKey).sort());

function ageRangeQuotes(sourceConditions) {
  const aliases = new Map();
  for (const condition of sourceConditions) {
    if (condition.attribute !== 'age') continue;
    const clause = condition.quote.replace(/^be /i, '');
    const range = ageRange.exec(clause)?.groups;
    if (!range) continue;
    for (const quote of [clause, range.bounds]) {
      const key = conditionKey({ ...condition, quote });
      const previous = aliases.get(key);
      // A shorter quote must identify a single complete source clause.
      aliases.set(key, previous === undefined || previous === condition.quote ? condition.quote : null);
    }
  }
  return aliases;
}

export function comparableRule(rule) {
  return rule ? JSON.stringify([rule.pathsExhaustive, rule.paths.map(path => JSON.stringify([
    path.complete, path.conditions.map(condition => JSON.stringify([
      condition.attribute, condition.operator, condition.value,
    ])).sort(),
  ])).sort()]) : null;
}

function invalidDraft(validationIssues, outputDiagnostic) {
  return {
    valid: false, schemaValid: false, warnings: [{ code: 'INVALID_PROPOSAL_SCHEMA' }],
    proposal: { paths: [] }, questions: [], evidence: [], validationIssues,
    ...(outputDiagnostic && { outputDiagnostic }),
  };
}

export function validateProposal(input, raw, wording, outputDiagnostic) {
  if (outputDiagnostic) return invalidDraft([], outputDiagnostic);
  if (Array.isArray(raw?.paths)) {
    if (raw.paths.length > 5) return invalidDraft([{ field: '$.paths', reason: 'above_maximum' }]);
    const oversized = raw.paths.findIndex(path => Array.isArray(path) && path.length > 10);
    if (oversized !== -1) return invalidDraft([{ field: '$.paths[' + oversized + ']', reason: 'above_maximum' }]);
  }
  const result = proposalSchema.safeParse(raw);
  const wordingInput = wording === undefined ? {} : wording;
  const wordingResult = questionWordingSchema.safeParse(wordingInput);
  if (!result.success || !wordingResult.success) return invalidDraft([
    ...(!result.success ? schemaIssues(result.error, raw) : []),
    ...(!wordingResult.success ? schemaIssues(wordingResult.error, wordingInput, ['questionWording']) : []),
  ]);

  const source = analyzeSource(input.text);
  const warnings = [...source.warnings];
  const validationIssues = [];
  const proposal = result.data;
  const suggestions = proposal.questions ?? [];
  const suggestedWording = Object.fromEntries(suggestions.map(({ attribute, wording }) => [attribute, wording]));
  const chosenWording = { ...suggestedWording, ...wordingResult.data };
  const attributesUsed = new Set(proposal.paths.flat().map(condition => condition.attribute));
  const seen = new Set();
  for (const [index, { attribute }] of suggestions.entries()) {
    if (!attributesUsed.has(attribute) || seen.has(attribute)) {
      validationIssues.push({ field: '$.questions[' + index + '].attribute',
        reason: seen.has(attribute) ? 'duplicate_question' : 'question_without_condition' });
    }
    seen.add(attribute);
  }
  if (validationIssues.length) {
    warnings.push({ code: 'UNSUPPORTED_QUESTION_SUGGESTION' });
  }
  for (const [index, { quote, reason }] of (proposal.unresolved ?? []).entries()) {
    const knownQuote = input.text.includes(quote);
    warnings.push(knownQuote ? { code: 'UNRESOLVED_MODEL_CONDITION', quote, reason }
      : { code: 'UNSUPPORTED_OR_INVENTED_PROPOSAL' });
    validationIssues.push({ field: '$.unresolved[' + index + '].quote',
      reason: knownQuote ? 'condition_requires_manual_review' : 'quote_not_in_source' });
  }
  const sourceConditions = source.paths.flat();
  const sourceKeys = new Set(sourceConditions.map(conditionKey));
  const rangeQuotes = ageRangeQuotes(sourceConditions);
  const proposed = new Set();
  const validatedPaths = proposal.paths.map((path, pathIndex) => path.map((condition, conditionIndex) => {
    const originalKey = conditionKey(condition);
    const fullQuote = sourceKeys.has(originalKey) ? undefined : rangeQuotes.get(originalKey);
    const cited = fullQuote ? { ...condition, quote: fullQuote } : condition;
    const key = conditionKey(cited);
    proposed.add(key);
    if (sourceKeys.has(key)) return cited;
    warnings.push({ code: 'UNSUPPORTED_OR_INVENTED_PROPOSAL', quote: condition.quote });
    const field = '$.paths[' + pathIndex + '][' + conditionIndex + ']';
    const exactQuote = sourceConditions.some(sourceCondition => sourceCondition.quote === condition.quote);
    validationIssues.push(exactQuote ? { field, reason: 'condition_does_not_match_quote' }
      : { field: field + '.quote', reason: input.text.includes(condition.quote) ? 'quote_is_not_a_recognized_clause' : 'quote_not_in_source' });
    return condition;
  }));
  if ([...sourceKeys].some(key => !proposed.has(key))) {
    warnings.push({ code: 'MISSING_SUPPORTED_CONDITIONS' });
    validationIssues.push({ field: '$.paths', reason: 'missing_supported_conditions' });
  }
  if (ruleKey(source.paths) !== ruleKey(validatedPaths)) {
    warnings.push({ code: 'PATHWAYS_DO_NOT_MATCH_EVIDENCE' });
    validationIssues.push({ field: '$.paths', reason: 'pathways_do_not_match_evidence' });
  }

  const ruleDraft = {
    status: 'verified',
    evidenceUrl: input.url,
    pathsExhaustive: true,
    paths: proposal.paths.map(path => ({
      complete: true,
      conditions: path.map(({ quote, ...condition }) => condition),
    })),
    ...(Object.keys(chosenWording).length && { questionWording: chosenWording }),
  };
  const rule = eligibilitySchema.safeParse(ruleDraft);
  if (proposal.paths.length && !rule.success) {
    warnings.push({ code: 'CONTRADICTORY_OR_INVALID_RULE' });
    validationIssues.push(...schemaIssues(rule.error, ruleDraft));
  }
  const labels = wordingOptions();
  const questions = rule.success ? questionsFor([{ rule: rule.data }]).map(question => ({
    ...question, wording: labels[question.id], optional: true,
  })) : [];
  const evidence = validatedPaths.map(path => path.map(condition => ({
    ...condition, url: input.url, field: input.field,
  })));
  return {
    valid: warnings.length === 0 && rule.success,
    schemaValid: true,
    warnings,
    validationIssues,
    proposal,
    questions,
    evidence,
    ...(warnings.length === 0 && rule.success && { rule: rule.data }),
  };
}
