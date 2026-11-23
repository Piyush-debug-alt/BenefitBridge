import { describe, expect, it } from 'vitest';
import { answersSchema, eligibilitySchema, questionsFor } from '../src/modules/matching/criteria.js';
import { evaluateScheme, rankMatches } from '../src/modules/matching/engine.js';

const check = (attribute, operator, value) => ({ attribute, operator, value });
const age = check('age', 'atLeast', 18);
const student = check('currentlyStudying', 'eq', true);
const path = (...conditions) => ({ complete: true, conditions });
const rule = (...paths) => ({
  status: 'verified',
  evidenceUrl: 'https://demo.example.invalid/criteria',
  pathsExhaustive: true,
  paths,
});

describe('matching engine', () => {
  it('distinguishes passing, failing and unanswered conditions in the same pathway', () => {
    const result = evaluateScheme(rule(path(age, student, check('ownsHome', 'eq', true))), {
      age: 18, currentlyStudying: false,
    });
    expect(result.outcome).toBe('KNOWN_UNMET');
    expect(result.paths[0].conditions.map(check => check.status)).toEqual(['PASS', 'FAIL', 'UNKNOWN']);
  });

  it('accepts a verified alternative and keeps another unanswered alternative possible', () => {
    const alternatives = rule(path(age), path(check('hasOwnerPermission', 'eq', true)));
    expect(evaluateScheme(alternatives, { age: 17, hasOwnerPermission: true }).outcome).toBe('POTENTIAL_MATCH');
    expect(evaluateScheme(alternatives, { age: 17 }).outcome).toBe('NEEDS_INFO');
    expect(evaluateScheme(alternatives, { age: 17, hasOwnerPermission: false }).outcome).toBe('KNOWN_UNMET');
  });

  it('explains missing or incomplete eligibility without fabricating conditions', () => {
    expect(evaluateScheme(undefined, {}).paths).toEqual([]);
    expect(evaluateScheme(rule({ ...path(age), complete: false }), { age: 18 })).toMatchObject({
      outcome: 'NEEDS_INFO',
      paths: [{ conditions: [{ status: 'PASS' }, { status: 'UNKNOWN' }] }],
    });
    expect(evaluateScheme({ ...rule(path(age)), pathsExhaustive: false }, { age: 17 }).outcome).toBe('NEEDS_INFO');
  });

  it('deduplicates questions and keeps original relevance order inside each outcome', () => {
    const entries = [
      { schemeId: 'unknown' },
      { schemeId: 'first-match', rule: rule(path(age)) },
      { schemeId: 'unmet', rule: rule(path(student)) },
      { schemeId: 'second-match', rule: rule(path(age)) },
    ];
    expect(questionsFor(entries).map(question => question.id)).toEqual(['age', 'currentlyStudying']);
    expect(rankMatches(entries, { age: 18, currentlyStudying: false }).map(result => result.schemeId))
      .toEqual(['first-match', 'second-match', 'unknown', 'unmet']);
  });
});

describe('matching validation', () => {
  it('rejects contradictions, unsupported criteria and invalid values', () => {
    expect(eligibilitySchema.safeParse(rule(path(age, check('age', 'atMost', 17)))).success).toBe(false);
    expect(eligibilitySchema.safeParse(rule(path(check('ownsHome', 'atLeast', true)))).success).toBe(false);
    expect(eligibilitySchema.safeParse(rule(path(check('identityNumber', 'eq', 1)))).success).toBe(false);
    expect(answersSchema.safeParse({ age: '18' }).success).toBe(false);
    expect(answersSchema.safeParse({ age: 121 }).success).toBe(false);
  });
});
