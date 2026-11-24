import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { extname } from 'node:path';
import { handleError, HttpError, notFound, requestId } from './middleware/http.js';
import { catalogueRouter } from './modules/catalogue/routes.js';
import { matchingRouter } from './modules/matching/routes.js';
import { readAuthConfig } from './modules/auth/config.js';
import { accountRouter } from './modules/auth/routes.js';
import { administrationRouter } from './modules/ingestion/admin-routes.js';

export function createApp({ models, dataset, isReady, auth = readAuthConfig({}, dataset), services, trustLoopbackProxy = false,
  renderDemo = false, webRoot }) {
  const app = express();
  app.disable('x-powered-by');
  if (renderDemo) app.set('trust proxy', 1);
  else if (trustLoopbackProxy) app.set('trust proxy', 'loopback');
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
    res.set('X-BenefitBridge-Dataset', dataset);
    if (!isReady()) return next(new HttpError(503, 'DATABASE_UNAVAILABLE', 'The catalogue database is unavailable.'));
    next();
  }, catalogueRouter(models.Scheme, dataset, models.SyncSource), matchingRouter(models, dataset),
  accountRouter(models, dataset, auth, services), administrationRouter(models, dataset, auth));

  if (webRoot) {
    app.use('/api', notFound);
    app.use(express.static(webRoot, { index: false, redirect: false }));
    app.use('/assets', notFound);
    app.get('/{*path}', (req, res, next) => {
      if (extname(req.path) || !req.accepts('html')) return next();
      res.sendFile('index.html', { root: webRoot, headers: { 'Cache-Control': 'no-cache' } }, error => {
        if (error) next(error);
      });
    });
  }

  app.use(notFound, handleError);
  return app;
}
