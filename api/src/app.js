import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { handleError, HttpError, notFound, requestId } from './middleware/http.js';
import { catalogueRouter } from './modules/catalogue/routes.js';
import { matchingRouter } from './modules/matching/routes.js';

export function createApp({ models, dataset, isReady }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId, helmet());
  app.use('/api/v1', rateLimit({
    windowMs: 60_000,
    limit: 180,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.')),
  }));

  app.get('/api/v1/health', (_req, res, next) => {
    if (!isReady()) return next(new HttpError(503, 'DATABASE_UNAVAILABLE', 'The catalogue database is unavailable.'));
    res.json({ status: 'ok', dataset });
  });

  app.use('/api/v1', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!isReady()) return next(new HttpError(503, 'DATABASE_UNAVAILABLE', 'The catalogue database is unavailable.'));
    next();
  }, catalogueRouter(models.Scheme, dataset), matchingRouter(models, dataset));

  app.use(notFound, handleError);
  return app;
}
