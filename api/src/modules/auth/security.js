import { json } from 'express';
import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../../middleware/http.js';

const parser = json({ limit: '8kb', inflate: false });

export function jsonBody(req, res, next) {
  if (!req.is('application/json')) return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send a JSON request.'));
  parser(req, res, error => {
    if (!error) return next();
    if (error.status === 413) return next(new HttpError(413, 'BODY_TOO_LARGE', 'The request is too large.'));
    return next(new HttpError(400, 'INVALID_REQUEST', 'Send a valid JSON request.'));
  });
}

export function safeInput(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'INVALID_REQUEST', 'Check the supplied information and try again.');
  return result.data;
}

export function requireOrigin(origin) {
  return (req, _res, next) => {
    if (req.get('origin') !== origin) {
      return next(new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'This request must come from BenefitBridge.'));
    }
    next();
  };
}

export function authLimit(limit, minutes = 15) {
  return rateLimit({
    windowMs: minutes * 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.')),
  });
}
