import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';
import { readConfig } from '../src/config/env.js';
import { readAuthConfig } from '../src/modules/auth/config.js';
import { tokenHash } from '../src/modules/auth/session.js';
import { importFixture } from '../src/modules/ingestion/import-fixture.js';
import { readFixture } from '../src/modules/ingestion/file-adapter.js';

const origin = 'http://127.0.0.1:5174';
const password = 'test-passphrase-long';
const cache = fileURLToPath(new URL('../../.local/mongodb/', import.meta.url));
const fixturePath = new URL('./fixtures/synthetic/catalogue.json', import.meta.url);

let mongo, database, models, app, publishedScheme;

function withOrigin(req, trusted = origin) {
  return req.set('Origin', trusted);
}

function cookieOf(response, name = 'bb_session_demo') {
  return response.headers['set-cookie']?.find(value => value.startsWith(name + '='))?.split(';')[0];
}

async function createUser(client, email) {
  await withOrigin(client.post('/api/v1/auth/register')).send({ email, password }).expect(202);
  return withOrigin(client.post('/api/v1/auth/login')).send({ email, password }).expect(200);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { downloadDir: cache } });
  const config = readConfig({ DEMO_MONGODB_URI: mongo.getUri() }, { demo: true });
  database = await connectDatabase(config);
  models = database.models;
  await importFixture(models, 'synthetic', await readFixture(fixturePath, 'synthetic'));
  publishedScheme = await models.Scheme.findOne({ dataset: 'synthetic', publicationStatus: 'published' });
  app = createApp({ models, dataset: 'synthetic', isReady: () => true });
});

afterAll(async () => {
  await database?.connection.close();
  await mongo?.stop();
});

describe('email/password and server-side sessions', () => {
  it('hashes passwords, normalizes emails, rejects bad credentials and revokes rotated or logged-out tokens', async () => {
    const api = request(app);
    const registration = await withOrigin(api.post('/api/v1/auth/register'))
      .send({ email: '  Alice@example.test  ', password }).expect(202);
    const duplicate = await withOrigin(api.post('/api/v1/auth/register'))
      .send({ email: 'alice@example.test', password }).expect(202);
    expect(registration.body).toEqual(duplicate.body);
    expect(await models.User.countDocuments({ email: 'alice@example.test' })).toBe(1);
    const user = await models.User.findOne({ email: 'alice@example.test' }).select('+passwordHash');
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(password);

    const wrong = await withOrigin(api.post('/api/v1/auth/login'))
      .send({ email: 'alice@example.test', password: 'invalid-password' }).expect(401);
    const absent = await withOrigin(api.post('/api/v1/auth/login'))
      .send({ email: 'absent@example.test', password }).expect(401);
    expect(wrong.body.message).toBe(absent.body.message);

    const login = await withOrigin(api.post('/api/v1/auth/login')).send({ email: user.email, password }).expect(200);
    expect(login.body).toEqual({ user: { id: user.id, email: user.email, emailVerified: false } });
    const header = login.headers['set-cookie'][0];
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Secure');
    const original = cookieOf(login);
    const token = original.split('=')[1];
    const stored = await models.Session.findOne({ userId: user.id });
    expect(stored.sessionIdHash).toBe(tokenHash(token));
    expect(login.headers['cache-control']).toBe('no-store');

    const rotated = await withOrigin(api.post('/api/v1/auth/login')).set('Cookie', original)
      .send({ email: user.email, password }).expect(200);
    const current = cookieOf(rotated);
    expect(current).not.toBe(original);
    await api.get('/api/v1/me').set('Cookie', original).expect(401);
    await api.get('/api/v1/me').set('Cookie', current).expect(200);
    await withOrigin(api.post('/api/v1/auth/logout')).set('Cookie', current).expect(204);
    await api.get('/api/v1/me').set('Cookie', current).expect(401);
  });

  it('rejects missing and expired sessions and requires the trusted origin on mutations', async () => {
    const api = request(app);
    const session = cookieOf(await createUser(api, 'expired@example.test'));
    await api.get('/api/v1/me/profile').expect(401);
    await api.get('/api/v1/me/bookmarks').expect(401);
    await api.put('/api/v1/me/profile').set('Cookie', session)
      .send({ attributes: { age: 25 }, consent: true }).expect(403);
    await withOrigin(api.post('/api/v1/auth/logout'), 'https://other.example.test').set('Cookie', session).expect(403);
    await api.get('/api/v1/me').set('Cookie', session).expect(200);
    const hash = tokenHash(session.split('=')[1]);
    await models.Session.collection.updateOne({ sessionIdHash: hash }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await api.get('/api/v1/me').set('Cookie', session).expect(401);
    await withOrigin(api.delete('/api/v1/me/profile')).set('Cookie', session).expect(401);
  });

  it('throttles repeated credential attempts and requires HTTPS configuration in production', async () => {
    const isolated = request(createApp({ models, dataset: 'synthetic', isReady: () => true }));
    for (let index = 0; index < 15; index++) {
      await withOrigin(isolated.post('/api/v1/auth/login'))
        .send({ email: 'rate@example.test', password }).expect(401);
    }
    await withOrigin(isolated.post('/api/v1/auth/login'))
      .send({ email: 'rate@example.test', password }).expect(429);
    expect(() => readAuthConfig({ NODE_ENV: 'production' })).toThrow(/HTTPS/);
    expect(readAuthConfig({ APP_ORIGIN: 'https://benefits.example.test' }).sessionCookie).toMatch(/^__Host-/);
  });
});

describe('profile and bookmark authorization', () => {
  it('requires explicit consent and scopes profile and bookmarks to the current user', async () => {
    const api = request(app);
    const first = cookieOf(await createUser(api, 'owner@example.test'));
    const second = cookieOf(await createUser(api, 'other@example.test'));
    const { id } = publishedScheme;

    await withOrigin(api.put('/api/v1/me/profile')).set('Cookie', first)
      .send({ attributes: { age: 27 }, consent: false }).expect(400);
    await withOrigin(api.put('/api/v1/me/profile')).set('Cookie', first)
      .send({ attributes: { age: 27, unknown: true }, consent: true }).expect(400);
    const saved = await withOrigin(api.put('/api/v1/me/profile')).set('Cookie', first)
      .send({ attributes: { age: 27, ownsHome: false }, consent: true }).expect(200);
    expect(saved.body.profile).toMatchObject({ attributes: { age: 27, ownsHome: false } });
    expect(saved.body.profile.consentAt).toBeTruthy();

    const empty = await api.get('/api/v1/me/profile').set('Cookie', second).expect(200);
    expect(empty.body.profile).toBeNull();
    await withOrigin(api.delete('/api/v1/me/profile')).set('Cookie', second).expect(204);
    const firstUser = await api.get('/api/v1/me').set('Cookie', first).expect(200);
    await withOrigin(api.put('/api/v1/me/profile')).set('Cookie', second)
      .send({ userId: firstUser.body.user.id, attributes: { age: 44 }, consent: true }).expect(400);
    const edited = await withOrigin(api.put('/api/v1/me/profile')).set('Cookie', first)
      .send({ attributes: { age: 28 }, consent: true }).expect(200);
    expect(edited.body.profile.attributes).toEqual({ age: 28 });
    await withOrigin(api.delete('/api/v1/me/profile')).set('Cookie', first).expect(204);
    expect((await api.get('/api/v1/me/profile').set('Cookie', first)).body.profile).toBeNull();

    await withOrigin(api.post('/api/v1/me/bookmarks')).set('Cookie', first).send({ schemeId: id }).expect(200);
    await withOrigin(api.post('/api/v1/me/bookmarks')).set('Cookie', first).send({ schemeId: id }).expect(200);
    await withOrigin(api.post('/api/v1/me/bookmarks')).set('Cookie', first)
      .send({ schemeId: '000000000000000000000042' }).expect(404);
    await withOrigin(api.delete('/api/v1/me/bookmarks/' + id)).set('Cookie', second).expect(204);
    expect((await api.get('/api/v1/me/bookmarks').set('Cookie', second)).body.items).toEqual([]);
    expect((await api.get('/api/v1/me/bookmarks').set('Cookie', first)).body.items)
      .toEqual([{ schemeId: id, name: publishedScheme.canonicalName }]);
    await withOrigin(api.delete('/api/v1/me/bookmarks/' + id)).set('Cookie', first).expect(204);
    expect((await api.get('/api/v1/me/bookmarks').set('Cookie', first)).body.items).toEqual([]);
  });
});

describe('Google OpenID Connect', () => {
  it('binds OAuth to a short-lived cookie and state, rejects reused or unverified attempts, and prevents email-only linking', async () => {
    const auth = readAuthConfig({ DEMO_GOOGLE_CLIENT_ID: 'test-id', DEMO_GOOGLE_CLIENT_SECRET: 'test-secret' }, 'synthetic');
    const google = {
      start: vi.fn(async attempt => 'https://accounts.google.com/o/oauth2/v2/auth?state=' + attempt.state),
      finish: vi.fn(async () => ({ sub: 'verified-google-subject', email: 'google@example.test', email_verified: true })),
    };
    const api = request(createApp({ models, dataset: 'synthetic', isReady: () => true, auth, services: { google } }));
    const start = () => api.get('/api/v1/auth/google/start').expect(302);
    const callback = (started, changeState = false) => {
      const state = new URL(started.headers.location).searchParams.get('state');
      return api.get('/api/v1/auth/google/callback').set('Cookie', cookieOf(started, 'bb_google_demo'))
        .query({ state: changeState ? 'a'.repeat(43) : state, code: 'fake-code' }).expect(303);
    };

    const rejected = await callback(await start(), true);
    expect(rejected.headers.location).toContain('google=failed');
    expect(google.finish).not.toHaveBeenCalled();

    const started = await start();
    const signedIn = await callback(started);
    expect(signedIn.headers.location).toBe(origin + '/account');
    expect(google.finish.mock.lastCall[1]).toMatchObject(google.start.mock.lastCall[0]);
    expect((await api.get('/api/v1/me').set('Cookie', cookieOf(signedIn))).body.user.email).toBe('google@example.test');
    expect((await callback(started)).headers.location).toContain('google=failed');

    google.finish.mockResolvedValueOnce({ sub: 'unverified-guid', email: 'unverified@example.test', email_verified: false });
    expect((await callback(await start())).headers.location).toContain('google=failed');
    await withOrigin(api.post('/api/v1/auth/register')).send({ email: 'existing@example.test', password }).expect(202);
    google.finish.mockResolvedValueOnce({ sub: 'unlinked-subject', email: 'existing@example.test', email_verified: true });
    const collision = await callback(await start());
    expect(collision.headers.location).toContain('google=use-original-sign-in');
    expect(cookieOf(collision)).toBeUndefined();
    expect(await models.User.countDocuments({ googleSubject: 'unlinked-subject' })).toBe(0);

    google.finish.mockResolvedValueOnce({ sub: 'verified-google-subject', email: 'changed@example.test', email_verified: true });
    const returning = await callback(await start());
    expect((await api.get('/api/v1/me').set('Cookie', cookieOf(returning))).body.user.email).toBe('google@example.test');
  });
});

describe('email verification and recovery', () => {
  it('requires mailbox verification, consumes one-time links, and invalidates previous sessions after password reset', async () => {
    const secureOrigin = 'https://benefits.example.test';
    const auth = readAuthConfig({
      DEMO_APP_ORIGIN: secureOrigin, DEMO_SMTP_URL: 'smtp://127.0.0.1:1025',
      DEMO_MAIL_FROM: 'noreply@example.test',
    }, 'synthetic');
    const mailer = { send: vi.fn() };
    const api = request(createApp({ models, dataset: 'synthetic', isReady: () => true, auth, services: { mailer } }));
    const post = path => withOrigin(api.post('/api/v1' + path), secureOrigin);
    const email = 'mail@example.test';
    await post('/auth/register').send({ email, password }).expect(202);
    await post('/auth/login').send({ email, password }).expect(403);
    const verification = new URL(mailer.send.mock.lastCall[2]);
    expect(verification.pathname + verification.search).toBe('/account?mode=verify');
    const token = verification.hash.slice(1);
    await post('/auth/email/verify').send({ token }).expect(200);
    await post('/auth/email/verify').send({ token }).expect(400);

    const signIn = await post('/auth/login').send({ email, password }).expect(200);
    expect(signIn.headers['set-cookie'][0]).toContain('Secure');
    const cookie = cookieOf(signIn, '__Host-bb_session_demo');
    await post('/auth/password/forgot').send({ email }).expect(202);
    const reset = new URL(mailer.send.mock.lastCall[2]);
    const data = { token: reset.hash.slice(1), password: 'updated-test-passphrase' };
    await post('/auth/password/reset').send(data).expect(200);
    await post('/auth/password/reset').send(data).expect(400);
    await api.get('/api/v1/me').set('Cookie', cookie).expect(401);
    await post('/auth/login').send({ email, password: data.password }).expect(200);
  });
});
