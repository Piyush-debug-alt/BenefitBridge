import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../../middleware/http.js';

export const tokenPattern = /^[a-zA-Z0-9_-]{43}$/;
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = value => createHash('sha256').update(value).digest('hex');
const lifetimeMs = 7 * 24 * 60 * 60 * 1000;

export const publicUser = user => ({
  id: String(user._id), email: user.email, emailVerified: user.emailVerified,
  ...(user.isAdministrator && { isAdministrator: true }),
});

export function cookieOptions(config) {
  return { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' };
}

export function readToken(req, name) {
  const matches = (req.get('cookie') ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(name + '='));
  const token = matches.length === 1 ? matches[0].slice(name.length + 1) : '';
  return tokenPattern.test(token) ? token : null;
}

export function createSessions({ User, Session }, config) {
  async function revoke(req) {
    const previous = readToken(req, config.sessionCookie);
    if (previous) await Session.deleteOne({ sessionIdHash: tokenHash(previous) });
  }

  return {
    async issue(req, res, user) {
      await revoke(req);
      const value = newToken();
      await Session.create({
        userId: user._id, sessionIdHash: tokenHash(value), sessionVersion: user.sessionVersion,
        expiresAt: new Date(Date.now() + lifetimeMs),
      });
      res.cookie(config.sessionCookie, value, { ...cookieOptions(config), maxAge: lifetimeMs });
    },
    async logout(req, res) {
      await revoke(req);
      res.clearCookie(config.sessionCookie, cookieOptions(config));
    },
    async requireUser(req, _res, next) {
      const value = readToken(req, config.sessionCookie);
      const session = value && await Session.findOne({
        sessionIdHash: tokenHash(value), expiresAt: { $gt: new Date() },
      }).lean();
      const user = session && await User.findOne({
        _id: session.userId, sessionVersion: session.sessionVersion,
      }).select('email emailVerified isAdministrator').lean();
      if (!user || (!user.emailVerified && !config.allowUnverifiedEmail)) {
        throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
      }

      req.user = user;
      next();
    },
  };
}
