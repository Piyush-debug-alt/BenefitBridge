import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export function requestId(req, res, next) {
  req.requestId = randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
}

export function validate(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Check the supplied parameters.', parsed.error.issues.map(issue => ({
      field: issue.path.join('.'),
      message: issue.message,
    })));
  }
  return parsed.data;
}

export function notFound(_req, _res, next) {
  next(new HttpError(404, 'NOT_FOUND', 'This resource could not be found.'));
}

export function handleError(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (!(error instanceof HttpError)) {
    console.error('Unhandled API error', { requestId: req.requestId, name: error.name });
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'The server could not complete this request.',
      requestId: req.requestId,
    });
  }

  return res.status(error.status).json({
    code: error.code,
    message: error.message,
    details: error.details,
    requestId: req.requestId,
  });
}
