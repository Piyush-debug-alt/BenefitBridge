import { z } from 'zod';
import { eligibilityCondition, eligibilitySchema, questionsFor, questionWordingSchema, wordingOptions } from '../matching/criteria.js';

const conditionInput = z.strictObject({
  attribute: z.string().max(40), operator: z.enum(['eq', 'atLeast', 'atMost']),
  value: z.union([z.string().max(2), z.number(), z.boolean()]), quote: z.string().min(1).max(4000),
}).transform(({ quote, ...condition }, context) => {
  const result = eligibilityCondition.safeParse(condition);
  if (!result.success) {
    context.addIssue({ code: 'custom', message: 'Unsupported condition.' });
    return z.NEVER;
  }
  return { ...result.data, quote };
});

export const proposalSchema = z.strictObject({
  paths: z.array(z.array(conditionInput).min(1).max(10)).max(5),
});

const compare = { 'at least': 'atLeast', 'at most': 'atMost', 'equal to': 'eq' };

function parseClause(quote) {
  const clause = quote.replace(/^(?:be |have (?:an? )?)/i, '').trim();
  const add = (attribute, operator, value) => ({ attribute, operator, value, quote });
  const range = /^(?:age(?: is)?|aged) (?:(\d{1,3}) (?:to|through) (\d{1,3})|between (\d{1,3}) and (\d{1,3}))(?: years(?: old)?)?$/i.exec(clause);
  if (range) return [add('age', 'atLeast', Number(range[1] ?? range[3])), add('age', 'atMost', Number(range[2] ?? range[4]))];
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

    const groups = branches.map(branch => branch.split(/\s*,?\s+and\s+(?!\d)/i).flatMap(quote => {
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

export function comparableRule(rule) {
  return rule ? JSON.stringify([rule.pathsExhaustive, rule.paths.map(path => JSON.stringify([
    path.complete, path.conditions.map(condition => JSON.stringify([
      condition.attribute, condition.operator, condition.value,
    ])).sort(),
  ])).sort()]) : null;
}

export function validateProposal(input, raw, wording = {}) {
  const source = analyzeSource(input.text);
  const warnings = [...source.warnings];
  const bounded = Array.isArray(raw?.paths) && raw.paths.length <= 5 &&
    raw.paths.every(path => Array.isArray(path) && path.length <= 10);
  const result = bounded ? proposalSchema.safeParse(raw) : { success: false };
  const wordingResult = questionWordingSchema.safeParse(wording);
  if (!result.success || !wordingResult.success) warnings.push({ code: 'INVALID_PROPOSAL_SCHEMA' });
  const proposal = result.data ?? { paths: [] };
  const sourceKeys = new Set(source.paths.flat().map(conditionKey));
  const proposed = new Set();
  for (const condition of proposal.paths.flat()) {
    const key = conditionKey(condition);
    proposed.add(key);
    if (!sourceKeys.has(key)) warnings.push({ code: 'UNSUPPORTED_OR_INVENTED_PROPOSAL', quote: condition.quote });
  }
  if ([...sourceKeys].some(key => !proposed.has(key))) warnings.push({ code: 'MISSING_SUPPORTED_CONDITIONS' });
  if (ruleKey(source.paths) !== ruleKey(proposal.paths)) warnings.push({ code: 'PATHWAYS_DO_NOT_MATCH_EVIDENCE' });

  const rule = eligibilitySchema.safeParse({
    status: 'verified',
    evidenceUrl: input.url,
    pathsExhaustive: true,
    paths: proposal.paths.map(path => ({
      complete: true,
      conditions: path.map(({ quote, ...condition }) => condition),
    })),
    ...(Object.keys(wordingResult.data ?? {}).length && { questionWording: wordingResult.data }),
  });
  if (proposal.paths.length && !rule.success) warnings.push({ code: 'CONTRADICTORY_OR_INVALID_RULE' });
  const labels = wordingOptions();
  const questions = rule.success ? questionsFor([{ rule: rule.data }]).map(question => ({
    ...question, wording: labels[question.id], optional: true,
  })) : [];
  const evidence = proposal.paths.map(path => path.map(condition => ({
    ...condition, url: input.url, field: input.field,
  })));
  return {
    valid: warnings.length === 0 && rule.success,
    schemaValid: result.success,
    warnings,
    proposal,
    questions,
    evidence,
    ...(warnings.length === 0 && rule.success && { rule: rule.data }),
  };
}
