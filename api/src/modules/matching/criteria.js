import { z } from 'zod';

const yesNo = z.boolean();
const attributes = {
  age: { label: 'What is your age in years?', type: 'integer', min: 0, max: 120, schema: z.number().int().min(0).max(120) },
  currentlyStudying: { label: 'Are you currently studying?', type: 'boolean', schema: yesNo, condition: 'Currently studying' },
  ownsHome: { label: 'Do you own your home?', type: 'boolean', schema: yesNo, condition: 'Own a home' },
  hasOwnerPermission: { label: 'Do you have permission from the homeowner?', type: 'boolean', schema: yesNo, condition: 'Has permission from the homeowner' },
};

const answerSchema = Object.fromEntries(Object.entries(attributes).map(([key, definition]) => [
  key, definition.schema.optional(),
]));
export const answersSchema = z.strictObject(answerSchema);

const criterion = z.strictObject({
  attribute: z.enum(Object.keys(attributes)),
  operator: z.enum(['eq', 'atLeast', 'atMost']),
  value: z.union([z.boolean(), z.number()]),
}).superRefine(({ attribute, operator, value }, context) => {
  const definition = attributes[attribute];
  if (!definition.schema.safeParse(value).success || (definition.type === 'boolean' && operator !== 'eq')) {
    context.addIssue({ code: 'custom', path: ['value'], message: 'This operator or value is invalid for the question.' });
  }
});

const path = z.strictObject({
  complete: z.boolean(),
  conditions: z.array(criterion).min(1).max(10),
}).superRefine(({ conditions }, context) => {
  const ranges = new Map();
  for (const { attribute, operator, value } of conditions) {
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

export const eligibilitySchema = z.strictObject({
  status: z.literal('verified'),
  evidenceUrl: z.url({ protocol: /^https?$/, hostname: z.regexes.domain }).max(2048),
  pathsExhaustive: z.boolean(),
  paths: z.array(path).min(1).max(5),
});

export function questionsFor(entries) {
  const used = new Set();
  for (const { rule } of entries) {
    for (const { conditions } of rule?.paths ?? []) {
      for (const { attribute } of conditions) used.add(attribute);
    }
  }

  return Object.entries(attributes).filter(([id]) => used.has(id)).map(([id, { label, type, min, max }]) => ({
    id, label, type, ...(type === 'integer' ? { min, max } : {}),
  }));
}

export function conditionLabel({ attribute, operator, value }) {
  if (attribute === 'age') {
    if (operator === 'atLeast') return 'Age is at least ' + value;
    if (operator === 'atMost') return 'Age is at most ' + value;
    return 'Age is ' + value;
  }

  return attributes[attribute].condition + ': ' + (value ? 'yes' : 'no');
}
