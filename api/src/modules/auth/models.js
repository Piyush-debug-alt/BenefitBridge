import { Schema } from 'mongoose';
import { answersSchema } from '../matching/criteria.js';

const token = new Schema({
  hash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { _id: false });

export function createAccountModels(connection) {
  const user = new Schema({
    email: { type: String, required: true, unique: true },
    emailVerified: { type: Boolean, required: true, default: false },
    isAdministrator: { type: Boolean, default: false },
    passwordHash: { type: String, select: false },
    googleSubject: { type: String, unique: true, sparse: true, immutable: true, select: false },
    sessionVersion: { type: Number, required: true, default: 0 },
    verification: { type: token, select: false },
    recovery: { type: token, select: false },
  }, { collection: 'users', timestamps: true });
  user.index({ 'verification.hash': 1 }, { sparse: true });
  user.index({ 'recovery.hash': 1 }, { sparse: true });

  const owner = { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true };
  const session = new Schema({
    userId: owner,
    sessionIdHash: { type: String, unique: true, required: true, immutable: true },
    sessionVersion: { type: Number, required: true, immutable: true },
    expiresAt: { type: Date, required: true, expires: 0, immutable: true },
  }, { collection: 'sessions' });

  const googleAttempt = new Schema({
    tokenHash: { type: String, required: true, unique: true },
    state: { type: String, required: true },
    nonce: { type: String, required: true },
    verifier: { type: String, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  }, { collection: 'google_attempts' });

  const profile = new Schema({
    userId: { ...owner, unique: true },
    attributes: {
      type: Schema.Types.Mixed, required: true,
      validate: value => answersSchema.safeParse(value).success && Object.keys(value).length > 0,
    },
    consentAt: { type: Date, required: true },
  }, { collection: 'profiles', timestamps: true });

  const bookmark = new Schema({
    userId: owner,
    schemeId: { type: Schema.Types.ObjectId, ref: 'Scheme', required: true, immutable: true },
  }, { collection: 'bookmarks', timestamps: { createdAt: true, updatedAt: false } });
  bookmark.index({ userId: 1, schemeId: 1 }, { unique: true });
  bookmark.index({ schemeId: 1, createdAt: 1 });
  bookmark.index({ userId: 1, createdAt: -1, _id: -1 });

  return {
    User: connection.model('User', user),
    Session: connection.model('Session', session),
    GoogleAttempt: connection.model('GoogleAttempt', googleAttempt),
    Profile: connection.model('Profile', profile),
    Bookmark: connection.model('Bookmark', bookmark),
  };
}
