import { z } from 'zod';
import { conditionWire, proposalWireSchema } from './evidence.js';
import { eligibilityCondition, questionWordingCodeSchema, wordingOptions } from '../matching/criteria.js';
import { schemaIssues } from './validation-diagnostics.js';

const approvedQuestionWording = wordingOptions();

function canonicalizeQuestionWording(question) {
  const attribute = question?.attribute;
  if (typeof attribute !== 'string' || !Object.hasOwn(approvedQuestionWording, attribute)) return question;
  const labels = approvedQuestionWording[attribute];
  const code = questionWordingCodeSchema.options.find(option => labels[option] === question.wording);
  return code ? { ...question, wording: code } : question;
}

const transportSchema = z.strictObject({
  conditions: z.array(conditionWire.extend({
    path: z.number().int().min(1).max(5),
    value: z.string(),
  })).max(50),
  questions: z.preprocess(value => Array.isArray(value) ? value.map(canonicalizeQuestionWording) : value,
    proposalWireSchema.shape.questions.unwrap()),
  unresolved: proposalWireSchema.shape.unresolved.unwrap(),
});
const finishReasons = new Set([
  'MAX_TOKENS', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
  'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'CONTINUATION', 'OTHER',
]);

function failure(stage, issues, finishReason) {
  return { proposal: null, outputDiagnostic: {
    stage, issues, ...(finishReasons.has(finishReason) && { finishReason }),
  } };
}

function conditionValue(attribute, value) {
  if (attribute === 'residentState') return value;
  if (attribute === 'age' || attribute === 'annualIncome') return /^\d{1,10}$/.test(value) ? Number(value) : undefined;
  if (value === 'true' || value === 'false') return value === 'true';
}

export function parseGeminiResponse(response) {
  const candidate = response.candidates?.[0];
  if (!candidate) return failure('candidate', [{ field: '$.candidates[0]', reason: 'missing_candidate' }]);
  if (candidate.finishReason !== 'STOP') {
    return failure('candidate', [{ field: '$.candidates[0].finishReason',
      reason: candidate.finishReason ? 'incomplete_generation' : 'missing_finish_reason' }], candidate.finishReason);
  }
  // Match the SDK's text-part concatenation without logging names from non-text parts.
  const textField = '$.candidates[0].content.parts';
  const parts = candidate.content?.parts ?? [];
  if (!Array.isArray(parts)) return failure('candidate', [{ field: textField, reason: 'wrong_type', expected: 'array' }]);
  const text = parts.filter(part => typeof part?.text === 'string' && part.thought !== true).map(part => part.text).join('');
  if (!text.trim()) return failure('candidate', [{ field: textField, reason: 'empty_text' }]);
  if (text.length > 32_000) return failure('candidate', [{ field: textField, reason: 'text_too_large' }]);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return failure('json', [{ field: textField, reason: 'invalid_json' }]);
  }
  const decoded = transportSchema.safeParse(raw);
  if (!decoded.success) return failure('transport_schema', schemaIssues(decoded.error, raw));

  const { conditions, questions, unresolved } = decoded.data;
  const pathways = new Map();
  for (const [index, { path, value, quote, ...condition }] of conditions.entries()) {
    const converted = conditionValue(condition.attribute, value);
    if (converted === undefined) {
      return failure('condition_mapping', [{ field: '$.conditions[' + index + '].value', reason: 'invalid_value_encoding' }]);
    }
    const candidate = { ...condition, value: converted };
    const typed = eligibilityCondition.safeParse(candidate);
    if (!typed.success) return failure('condition_mapping', schemaIssues(typed.error, candidate, ['conditions', index]));
    const group = pathways.get(path) ?? [];
    if (group.length === 10) {
      return failure('pathway_mapping', [{ field: '$.conditions[' + index + '].path', reason: 'too_many_conditions_in_pathway' }]);
    }
    group.push({ ...typed.data, quote });
    pathways.set(path, group);
  }
  const paths = [...pathways].sort(([left], [right]) => left - right).map(([, group]) => group);
  return { proposal: { paths, questions, unresolved } };
}
