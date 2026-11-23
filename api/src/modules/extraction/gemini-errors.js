import { ExtractionRequestError } from './gemini-budget.js';

const googleStatuses = new Set([
  'INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'UNAUTHENTICATED', 'PERMISSION_DENIED',
  'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED',
]);
const googleReasons = new Set([
  'API_KEY_INVALID', 'API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED',
  'SERVICE_DISABLED', 'ACCESS_TOKEN_TYPE_UNSUPPORTED', 'RATE_LIMIT_EXCEEDED', 'BILLING_DISABLED', 'CONSUMER_INVALID',
]);
const schemaFields = new Set([
  'responseJsonSchema', 'responseSchema', 'responseMimeType', 'thinkingConfig', 'thinkingBudget', 'thinkingLevel',
  'includeThoughts', 'maxOutputTokens', 'contents', 'systemInstruction', 'type', 'properties', 'required',
  'paths', 'conditions', 'path', 'attribute', 'operator', 'value', 'quote', 'questions', 'wording', 'unresolved',
  'reason', 'items', 'minItems', 'maxItems', 'enum', 'additionalProperties', 'anyOf', 'oneOf',
]);
const httpFailures = {
  400: ['GEMINI_REQUEST_REJECTED', 'invalid_request'],
  401: ['GEMINI_ACCESS_DENIED', 'authentication'],
  403: ['GEMINI_ACCESS_DENIED', 'permission'],
  404: ['GEMINI_MODEL_UNAVAILABLE', 'model_unavailable'],
  408: ['PROVIDER_UNAVAILABLE', 'timeout'],
  429: ['GEMINI_QUOTA_EXHAUSTED', 'quota'],
  504: ['PROVIDER_UNAVAILABLE', 'timeout'],
};
const transportCategories = {
  ENOTFOUND: 'dns', EAI_AGAIN: 'dns', EACCES: 'network_blocked', EPERM: 'network_blocked',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls', SELF_SIGNED_CERT_IN_CHAIN: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls', CERT_HAS_EXPIRED: 'tls',
  UND_ERR_CONNECT_TIMEOUT: 'timeout', UND_ERR_HEADERS_TIMEOUT: 'timeout', UND_ERR_BODY_TIMEOUT: 'timeout', ETIMEDOUT: 'timeout',
  ECONNREFUSED: 'network', ECONNRESET: 'network', EHOSTUNREACH: 'network', ENETUNREACH: 'network', UND_ERR_SOCKET: 'network',
};

function rejectedField(field) {
  if (typeof field !== 'string' || field.length > 180) return;
  const parts = field.replace(/\[([\w]+)\]/g, '.$1').replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()).split('.');
  if (parts[0] === 'generationConfig') parts.shift();
  if (!parts.length || !schemaFields.has(parts[0])) return;
  if (parts.every(part => schemaFields.has(part) || /^\d{1,4}$/.test(part))) {
    return parts.join('.');
  }
}

function requestDetails(details, message) {
  const fields = [];
  for (const detail of details) {
    if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.BadRequest' || !Array.isArray(detail.fieldViolations)) continue;
    for (const violation of detail.fieldViolations) {
      const field = rejectedField(violation?.field);
      if (field && !fields.includes(field)) fields.push(field);
      if (fields.length === 8) break;
    }
    if (fields.length === 8) break;
  }
  // Some Gemini errors return only a message. Emit a fixed label instead of its text.
  const schemaComplexity = typeof message === 'string' && /schema/i.test(message) &&
    /too many states|nesting depth|too complex|state limit/i.test(message);
  return { ...(fields.length && { rejectedFields: fields }), ...(schemaComplexity && { schemaIssue: 'complexity' }) };
}

export async function geminiHttpError(response, retryAt) {
  const httpStatus = response.status;
  const [code, category] = httpFailures[httpStatus] ?? (httpStatus >= 500
    ? ['PROVIDER_UNAVAILABLE', 'upstream_failure'] : ['GEMINI_REQUEST_REJECTED', 'http_error']);
  const payload = await response.json().catch(() => null);
  const googleStatus = payload?.error?.status;
  const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
  const googleReason = details.map(detail => detail?.reason).find(reason => googleReasons.has(reason));
  return new ExtractionRequestError(code, {
    retryable: httpStatus === 408 || httpStatus === 429 || httpStatus >= 500,
    retryAt,
    diagnostic: {
      source: 'google', category, httpStatus,
      ...(googleStatuses.has(googleStatus) && { googleStatus }),
      ...(googleReason && { googleReason }),
      ...(httpStatus === 400 && requestDetails(details, payload?.error?.message)),
    },
  });
}

export function geminiTransportError(error, signal) {
  const cause = error?.cause;
  const nested = Array.isArray(cause?.errors) ? cause.errors.map(item => item?.code) : [];
  const transportCode = [error?.code, cause?.code, ...nested].find(code =>
    typeof code === 'string' && Object.hasOwn(transportCategories, code));
  const timeout = signal?.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ||
    transportCategories[transportCode] === 'timeout';
  return new ExtractionRequestError(timeout ? 'EXTRACTION_TIMEOUT' : 'PROVIDER_UNAVAILABLE', {
    retryable: true,
    diagnostic: { source: 'transport', category: timeout ? 'timeout' : transportCategories[transportCode] ?? 'network',
      ...(transportCode && { transportCode }) },
  });
}
