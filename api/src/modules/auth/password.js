import argon2 from 'argon2';
import { z } from 'zod';
import { HttpError } from '../../middleware/http.js';
import { authLimit, jsonBody, safeInput } from './security.js';
import { newToken, publicUser, tokenHash, tokenPattern } from './session.js';

export const emailSchema = z.string().trim().max(254).pipe(z.email()).transform(value => value.toLowerCase());
const loginPassword = z.string().min(1).max(128);
const newPassword = loginPassword.min(12);
const credentials = z.strictObject({ email: emailSchema, password: loginPassword });
const registration = credentials.extend({ password: newPassword });
const emailInput = z.strictObject({ email: emailSchema });
const code = z.string().regex(tokenPattern);
const hashPassword = password => argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

function createCode(lifetimeMinutes) {
  const value = newToken();
  return { value, record: { hash: tokenHash(value), expiresAt: new Date(Date.now() + lifetimeMinutes * 60_000) } };
}

export function mountPasswordRoutes(router, { User }, config, sessions, origin, mailer) {
  const loginLimit = authLimit(15);
  const registrationLimit = authLimit(10);
  const emailLimit = authLimit(10);
  let fallbackHash;
  const mailReady = Boolean(mailer);
  const ensureMail = () => {
    if (!mailReady) throw new HttpError(503, 'EMAIL_UNAVAILABLE', 'Email verification and recovery are unavailable here.');
  };

  function sendLink(email, purpose, value) {
    const link = config.origin + '/account?mode=' + purpose + '#' + value;
    void Promise.resolve().then(() => mailer.send(email, purpose, link)).catch(() => {
      console.error('Identity email delivery failed.');
    });
  }

  router.post('/auth/register', registrationLimit, origin, jsonBody, async (req, res) => {
    const { email, password } = safeInput(registration, req.body);
    if (!config.allowUnverifiedEmail) ensureMail();

    const verification = mailReady ? createCode(60) : null;
    const passwordHash = await hashPassword(password);
    try {
      await User.create({ email, passwordHash, verification: verification?.record });
      if (verification) sendLink(email, 'verify', verification.value);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    res.status(202).json({ message: mailReady ? 'If registration is available for this email, you’ll receive a verification link.' : 'Registration submitted. You can now try signing in.' });
  });

  router.post('/auth/login', loginLimit, origin, jsonBody, async (req, res) => {
    const { email, password } = safeInput(credentials, req.body);
    const user = await User.findOne({ email }).select('+passwordHash').lean();
    fallbackHash ??= hashPassword(newToken());
    const stored = user?.passwordHash ?? await fallbackHash;
    const correct = await argon2.verify(stored, password);
    if (!correct || !user?.passwordHash) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    if (!user.emailVerified && !config.allowUnverifiedEmail) {
      throw new HttpError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email before signing in.');
    }

    await sessions.issue(req, res, user);
    res.json({ user: publicUser(user) });
  });

  for (const [endpoint, purpose, field, minutes] of [
    ['/auth/email/resend', 'verify', 'verification', 60],
    ['/auth/password/forgot', 'reset', 'recovery', 20],
  ]) {
    router.post(endpoint, emailLimit, origin, jsonBody, async (req, res) => {
      const { email } = safeInput(emailInput, req.body);
      ensureMail();
      const { value, record } = createCode(minutes);
      const user = await User.findOneAndUpdate({
        email, passwordHash: { $exists: true }, emailVerified: purpose === 'reset',
      }, { $set: { [field]: record } });
      if (user) sendLink(email, purpose, value);
      res.status(202).json({ message: 'If the account can receive this email, we’ll send a link.' });
    });
  }

  router.post('/auth/email/verify', emailLimit, origin, jsonBody, async (req, res) => {
    const { token } = safeInput(z.strictObject({ token: code }), req.body);
    const user = await User.findOneAndUpdate({
      'verification.hash': tokenHash(token), 'verification.expiresAt': { $gt: new Date() },
    }, { $set: { emailVerified: true }, $unset: { verification: 1 } });
    if (!user) throw new HttpError(400, 'INVALID_LINK', 'This link is invalid or expired.');
    res.json({ message: 'Email verified. You can now sign in.' });
  });

  router.post('/auth/password/reset', emailLimit, origin, jsonBody, async (req, res) => {
    const { token, password } = safeInput(z.strictObject({ token: code, password: newPassword }), req.body);
    const recoveryHash = tokenHash(token);
    const owner = await User.exists({ 'recovery.hash': recoveryHash, 'recovery.expiresAt': { $gt: new Date() } });
    if (!owner) throw new HttpError(400, 'INVALID_LINK', 'This link is invalid or expired.');
    const passwordHash = await hashPassword(password);
    const user = await User.findOneAndUpdate({
      _id: owner._id, 'recovery.hash': recoveryHash, 'recovery.expiresAt': { $gt: new Date() },
    }, { $set: { passwordHash }, $unset: { recovery: 1 }, $inc: { sessionVersion: 1 } });
    if (!user) throw new HttpError(400, 'INVALID_LINK', 'This link is invalid or expired.');
    res.json({ message: 'Password updated. Sign in with your new password.' });
  });
}
