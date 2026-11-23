import { Router } from 'express';
import { createGoogleProvider, mountGoogleRoutes } from './google.js';
import { createMailer } from './mailer.js';
import { mountPasswordRoutes } from './password.js';
import { requireOrigin } from './security.js';
import { createSessions, publicUser } from './session.js';
import { mountAccountRoutes } from '../account/routes.js';
import { mountNotificationRoutes } from '../notifications/routes.js';

export function accountRouter(models, dataset, config, services = {}) {
  const router = Router();
  const sessions = createSessions(models, config);
  const origin = requireOrigin(config.origin);
  const google = config.google && (services.google ?? createGoogleProvider(config.google));
  const mailer = config.smtp && (services.mailer ?? createMailer(config.smtp));

  router.get('/auth/options', (_req, res) => {
    res.json({ googleEnabled: Boolean(google), emailEnabled: Boolean(mailer), localRegistration: config.allowUnverifiedEmail });
  });
  mountPasswordRoutes(router, models, config, sessions, origin, mailer);
  mountGoogleRoutes(router, models, config, sessions, google);
  router.post('/auth/logout', origin, async (req, res) => {
    await sessions.logout(req, res);
    res.sendStatus(204);
  });

  router.use('/me', sessions.requireUser);
  router.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));
  mountAccountRoutes(router, models, dataset, origin);
  mountNotificationRoutes(router, models, origin);
  return router;
}
