import { questionDefinitions } from '../matching/criteria.js';

const fields = new Set([
  'conditions', 'paths', 'path', 'attribute', 'operator', 'value', 'quote',
  'questions', 'wording', 'unresolved', 'reason', 'questionWording',
  'status', 'evidenceUrl', 'pathsExhaustive', 'complete',
  ...questionDefinitions().map(question => question.id),
]);
const types = new Set(['array', 'object', 'string', 'number', 'int', 'boolean']);
const reasons = {
  invalid_type: 'wrong_type',
  invalid_value: 'unsupported_value',
  invalid_format: 'invalid_format',
  unrecognized_keys: 'unexpected_fields',
  invalid_union: 'wrong_type',
  invalid_key: 'unsupported_field',
  too_small: 'below_minimum',
  too_big: 'above_maximum',
};

export function schemaIssues(error, input, prefix = []) {
  return error.issues.slice(0, 8).map(issue => {
    const field = [...prefix, ...issue.path].reduce((path, part) => {
      if (Number.isSafeInteger(part) && part >= 0) return path + '[' + part + ']';
      return path + '.' + (fields.has(part) ? part : '*');
    }, '$');
    const value = issue.path.reduce((object, part) => object != null && Object.hasOwn(object, part)
      ? object[part] : undefined, input);
    const reason = value === undefined && ['invalid_type', 'invalid_value', 'invalid_union'].includes(issue.code)
      ? 'missing_required_field'
      : issue.params?.reason === 'operator_requires_equality' ? 'operator_requires_equality'
        : reasons[issue.code] ?? 'invalid_for_rule';
    return { field, reason, ...(types.has(issue.expected) && { expected: issue.expected }) };
  });
}
