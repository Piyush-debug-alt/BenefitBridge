import { z } from 'zod';

const yesNo = z.boolean();
const attributes = {
  age: { label: 'What is your age in years?', type: 'integer', min: 0, max: 120, schema: z.number().int().min(0).max(120) },
  annualIncome: { label: 'What is your annual income in rupees?', type: 'integer', min: 0, max: 1_000_000_000, schema: z.number().int().min(0).max(1_000_000_000) },
  residentState: { label: 'What is your two-letter state or union territory code (for example, MH)?', type: 'state', schema: z.string().regex(/^[A-Za-z]{2}$/).transform(value => value.toUpperCase()) },
  currentlyStudying: { label: 'Are you currently studying?', type: 'boolean', schema: yesNo, condition: 'Currently studying' },
  employed: { label: 'Are you currently employed?', type: 'boolean', schema: yesNo, condition: 'Currently employed' },
  ownsHome: { label: 'Do you own your home?', type: 'boolean', schema: yesNo, condition: 'Own a home' },
  hasOwnerPermission: { label: 'Do you have permission from the homeowner?', type: 'boolean', schema: yesNo, condition: 'Has permission from the homeowner' },
};

const alternateLabels = {
  age: 'How old are you in years?',
  annualIncome: 'How much income do you receive per year in rupees?',
  residentState: 'Which state or union territory do you live in (two-letter code, such as MH)?',
  currentlyStudying: 'Are you enrolled as a student right now?',
  employed: 'Do you currently have a job?',
  ownsHome: 'Are you a homeowner?',
  hasOwnerPermission: 'Has the homeowner given you permission?',
};

const answerSchema = Object.fromEntries(Object.entries(attributes).map(([key, definition]) => [
  key, definition.schema.optional(),
]));
export const answersSchema = z.strictObject(answerSchema);

export const eligibilityCondition = z.strictObject({
  attribute: z.enum(Object.keys(attributes)),
  operator: z.enum(['eq', 'atLeast', 'atMost']),
  value: z.union([z.boolean(), z.number(), z.string().max(2)]),
}).superRefine(({ attribute, operator, value }, context) => {
  const definition = attributes[attribute];
  const result = definition.schema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ ...issue, path: ['value', ...issue.path] });
  }
  if (definition.type !== 'integer' && operator !== 'eq') {
    context.addIssue({ code: 'custom', path: ['operator'], message: 'This question requires equality.',
      params: { reason: 'operator_requires_equality' } });
  }
}).transform(condition => ({ ...condition, value: attributes[condition.attribute].schema.parse(condition.value) }));

const path = z.strictObject({
  complete: z.boolean(),
  conditions: z.array(eligibilityCondition).min(1).max(10),
}).superRefine(({ conditions }, context) => {
  const ranges = new Map();
  const choices = new Map();
  for (const { attribute, operator, value } of conditions) {
    if (typeof value !== 'number') {
      if (choices.has(attribute) && choices.get(attribute) !== value) {
        context.addIssue({ code: 'custom', path: ['conditions'], message: 'Conditions in one pathway contradict each other.' });
        return;
      }
      choices.set(attribute, value);
      continue;
    }
    const previous = ranges.get(attribute) ?? { min: -Infinity, max: Infinity };
    const number = Number(value);
    const min = operator === 'atMost' ? previous.min : Math.max(previous.min, number);
    const max = operator === 'atLeast' ? previous.max : Math.min(previous.max, number);
    if (min > max) {
      context.addIssue({ code: 'custom', path: ['conditions'], message: 'Conditions in one pathway contradict each other.' });
      return;
    }
    ranges.set(attribute, { min, max });
  }
});

export const questionWordingCodeSchema = z.enum(['standard', 'alternate']);
export const questionWordingSchema = z.partialRecord(z.enum(Object.keys(attributes)), questionWordingCodeSchema);

export const eligibilitySchema = z.strictObject({
  status: z.literal('verified'),
  evidenceUrl: z.url({ protocol: /^https?$/, hostname: z.regexes.domain }).max(2048),
  pathsExhaustive: z.boolean(),
  paths: z.array(path).min(1).max(5),
  questionWording: questionWordingSchema.optional(),
}).superRefine((rule, context) => {
  const used = new Set(rule.paths.flatMap(path => path.conditions.map(condition => condition.attribute)));
  if (Object.keys(rule.questionWording ?? {}).some(attribute => !used.has(attribute))) {
    context.addIssue({ code: 'custom', path: ['questionWording'], message: 'Questions must map to conditions in the rule.' });
  }
});

export function questionsFor(entries) {
  const used = new Map();
  for (const { rule } of entries) {
    for (const { conditions } of rule?.paths ?? []) {
      for (const { attribute } of conditions) {
        if (!used.has(attribute)) used.set(attribute, new Set());
        used.get(attribute).add(rule.questionWording?.[attribute] ?? 'standard');
      }
    }
  }

  return questionDefinitions().filter(({ id }) => used.has(id)).map(question => {
    const variants = used.get(question.id);
    return variants.size === 1 && variants.has('alternate')
      ? { ...question, label: alternateLabels[question.id] } : question;
  });
}

export function wordingOptions() {
  return Object.fromEntries(questionDefinitions().map(({ id, label }) => [id, { standard: label, alternate: alternateLabels[id] }]));
}

export function questionDefinitions() {
  return Object.entries(attributes).map(([id, { label, type, min, max }]) => ({
    id, label, type, ...(type === 'integer' ? { min, max } : {}),
  }));
}

export function conditionLabel({ attribute, operator, value }) {
  if (attribute === 'residentState') return 'Lives in ' + value;
  if (attribute === 'age' || attribute === 'annualIncome') {
    const prefix = attribute === 'age' ? 'Age is ' : 'Annual income is ';
    const comparison = operator === 'atLeast' ? 'at least ' : operator === 'atMost' ? 'at most ' : '';
    return prefix + comparison + value + (attribute === 'annualIncome' ? ' rupees' : '');
  }

  return attributes[attribute].condition + ': ' + (value ? 'yes' : 'no');
}
