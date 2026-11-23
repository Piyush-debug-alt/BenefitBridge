import * as client from 'openid-client';
import { z } from 'zod';
import { HttpError } from '../../middleware/http.js';
import { emailSchema } from './password.js';
import { authLimit } from './security.js';
import { cookieOptions, newToken, readToken, tokenHash } from './session.js';

const lifetime = 10 * 60_000;
const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: emailSchema,
  email_verified: z.literal(true),
});

export function createGoogleProvider(google) {
  let discovery;
  function configuration() {
    discovery ??= client.discovery(new URL('https://accounts.google.com'), google.clientId, {
      client_secret: google.clientSecret,
      redirect_uris: [google.redirectUri],
    }, client.ClientSecretPost(google.clientSecret)).then(config => {
      client.enableNonRepudiationChecks(config);
      return config;
    }).catch(error => {
      discovery = undefined;
      throw error;
    });
    return discovery;
  }

  return {
    async start(attempt) {
      return client.buildAuthorizationUrl(await configuration(), {
        redirect_uri: google.redirectUri,
        scope: 'openid email',
        code_challenge: await client.calculatePKCECodeChallenge(attempt.verifier),
        code_challenge_method: 'S256',
        nonce: attempt.nonce,
        state: attempt.state,
      });
    },
    async finish(url, attempt) {
      const tokenSet = await client.authorizationCodeGrant(await configuration(), url, {
        pkceCodeVerifier: attempt.verifier, expectedState: attempt.state, expectedNonce: attempt.nonce,
      });
      return tokenSet.claims();
    },
  };
}

async function userFromGoogle(User, { sub, email }) {
  const linked = await User.findOne({ googleSubject: sub });
  if (linked) return linked;
  try {
    // Create the email and stable Google subject atomically. An existing email belongs to its original sign-in method.
    return await User.create({ googleSubject: sub, email, emailVerified: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    return User.findOne({ googleSubject: sub });
  }
}

export function mountGoogleRoutes(router, { GoogleAttempt, User }, config, sessions, google) {
  const limit = authLimit(30);
  router.get('/auth/google/start', limit, async (req, res) => {
    if (!google) throw new HttpError(503, 'GOOGLE_UNAVAILABLE', 'Google sign-in is unavailable here.');
    if (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site'))) {
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Start Google sign-in from BenefitBridge.');
    }
    const value = newToken();
    const attempt = { state: newToken(), verifier: newToken(), nonce: newToken() };
    let target;
    try {
      target = await google.start(attempt);
    } catch {
      throw new HttpError(503, 'GOOGLE_UNAVAILABLE', 'Google sign-in is temporarily unavailable.');
    }
    await GoogleAttempt.create({ ...attempt, tokenHash: tokenHash(value), expiresAt: new Date(Date.now() + lifetime) });
    res.cookie(config.googleCookie, value, { ...cookieOptions(config), maxAge: lifetime });
    res.redirect(302, String(target));
  });

  router.get('/auth/google/callback', limit, async (req, res) => {
    const fail = () => res.redirect(303, config.origin + '/account?google=failed');
    if (!google) return fail();

    const value = readToken(req, config.googleCookie);
    res.clearCookie(config.googleCookie, cookieOptions(config));
    const url = new URL(config.google.redirectUri);
    url.search = new URL(req.originalUrl, config.origin).search;
    const state = url.searchParams.get('state');
    if (!value || url.searchParams.getAll('state').length !== 1 || !state || state.length !== 43) return fail();

    const attempt = await GoogleAttempt.findOneAndDelete({
      tokenHash: tokenHash(value), state, expiresAt: { $gt: new Date() },
    }).lean();
    if (!attempt) return fail();

    let identity;
    try {
      identity = claimsSchema.parse(await google.finish(url, attempt));
    } catch {
      return fail();
    }

    const user = await userFromGoogle(User, identity);
    if (!user) return res.redirect(303, config.origin + '/account?google=use-original-sign-in');
    await sessions.issue(req, res, user);
    res.redirect(303, config.origin + '/account');
  });
}
