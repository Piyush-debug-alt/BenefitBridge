import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';
import { readConfig } from '../src/config/env.js';
import { readFixture } from '../src/modules/ingestion/file-adapter.js';
import { importFixture } from '../src/modules/ingestion/import-fixture.js';
import { publishDemoNew, publishDemoUpdate } from '../src/modules/notifications/demo-publication.js';
import { processNotificationBatch } from '../src/modules/notifications/worker.js';

const origin = 'http://127.0.0.1:5174';
const base = '/api/v1';
const password = 'dev-test-passphrase';
const cache = fileURLToPath(new URL('../../.local/mongodb/', import.meta.url));
const fixturePath = new URL('./fixtures/synthetic/catalogue.json', import.meta.url);
let mongo, database, models, app, fixture;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { downloadDir: cache } });
  database = await connectDatabase(readConfig({ DEMO_MONGODB_URI: mongo.getUri() }, { demo: true }));
  models = database.models;
  app = createApp({ models, dataset: 'synthetic', isReady: () => true });
  fixture = await readFixture(fixturePath, 'synthetic');
  await importFixture(models, 'synthetic', fixture);
  expect((await processNotificationBatch(models, 'synthetic')).failed).toBe(0);
});

afterAll(async () => {
  await database?.connection.close();
  await mongo?.stop();
});

async function user(email) {
  const client = request.agent(app);
  const mutate = (method, path, data, from = origin) => client[method](base + path).set('Origin', from).send(data);
  await mutate('post', '/auth/register', { email, password }).expect(202);
  await mutate('post', '/auth/login', { email, password }).expect(200);
  return { mutate, get: path => client.get(base + path) };
}

const prefs = '/me/notification-preferences';
const inbox = '/me/notifications';
const both = { bookmarkUpdates: true, profileMatches: true };
const bothOff = { bookmarkUpdates: false, profileMatches: false };

it('delivers opted-in in-app alerts, holds disputed revisions, deduplicates retries, and protects inbox ownership', async () => {
  const [owner, nonmatch, muted, late] = await Promise.all([
    user('owner@example.test'), user('nonmatch@example.test'), user('muted@example.test'), user('late@example.test'),
  ]);
  await request(app).get(base + inbox).expect(401);
  await request(app).get(base + prefs).expect(401);
  expect((await owner.get(prefs)).body.preferences).toEqual(bothOff);
  await owner.mutate('put', prefs, both, 'https://other.example.test').expect(403);
  await owner.mutate('put', prefs, { ...both, email: true }).expect(400);
  expect((await owner.mutate('put', prefs, both).expect(200)).body.preferences).toEqual(both);
  await nonmatch.mutate('put', prefs, both).expect(200);
  await muted.mutate('put', prefs, both).expect(200);
  const scheme = await models.Scheme.findOne({ externalRecordId: 'learning-grant' });
  for (const person of [owner, muted]) {
    await person.mutate('post', '/me/bookmarks', { schemeId: scheme.id }).expect(200);
  }
  for (const [person, currentlyStudying] of [[owner, true], [nonmatch, false], [muted, true], [late, true]]) {
    await person.mutate('put', '/me/profile', { consent: true, attributes: { age: 27, currentlyStudying } }).expect(200);
  }

  expect(await publishDemoNew(models)).toEqual({ published: 1, skipped: 0 });
  expect(await publishDemoUpdate(models)).toEqual({ published: 1, skipped: 0 });
  expect(await publishDemoNew(models)).toEqual({ published: 0, skipped: 1 });
  expect(await publishDemoUpdate(models)).toEqual({ published: 0, skipped: 1 });
  expect(await importFixture(models, 'synthetic', fixture)).toEqual({ published: 0, skipped: 13 });

  await muted.mutate('put', prefs, bothOff).expect(200);
  await late.mutate('put', prefs, both).expect(200);
  await models.Scheme.updateOne({ _id: scheme._id }, { $set: { verificationStatus: 'disputed' } });
  expect(await processNotificationBatch(models, 'authorized')).toEqual({ processed: 0, failed: 0 });
  expect(await processNotificationBatch(models, 'synthetic')).toEqual({ processed: 1, failed: 0 });

  const first = (await owner.get(inbox).expect(200)).body;
  expect(first.unread).toBe(1);
  expect(first.items.map(item => item.type)).toEqual(['profile_match']);
  expect(first.items[0]).not.toHaveProperty('userId');
  expect(first.items[0]).not.toHaveProperty('attributes');
  for (const person of [nonmatch, muted, late]) expect((await person.get(inbox).expect(200)).body.items).toEqual([]);

  const profileNotification = first.items[0]._id;
  await nonmatch.mutate('patch', inbox + '/' + profileNotification, { read: true }).expect(404);
  await owner.mutate('patch', inbox + '/' + profileNotification, { read: 'true' }).expect(400);
  await owner.mutate('patch', inbox + '/' + profileNotification, { read: true }).expect(200);
  expect((await owner.get(inbox)).body.unread).toBe(0);

  await models.Scheme.updateOne({ _id: scheme._id }, { $set: { verificationStatus: 'verified' } });
  await models.ChangeEvent.updateMany({ completedAt: null }, { $set: { availableAt: new Date(0) } });
  expect(await processNotificationBatch(models, 'synthetic')).toEqual({ processed: 1, failed: 0 });
  const update = (await owner.get(inbox + '?limit=1&page=1').expect(200)).body;
  expect(update.totalPages).toBe(2);
  expect(update.items[0].type).toBe('bookmark_update');

  const newScheme = await models.Scheme.findOne({ externalRecordId: 'demo-campus-materials' });
  await models.ChangeEvent.updateMany({
    $or: [{ type: 'bookmark_update' }, { versionId: newScheme.currentVersionId }],
  }, { $unset: { completedAt: 1 }, $set: { availableAt: new Date(0) } });
  const batches = await Promise.all([processNotificationBatch(models, 'synthetic'), processNotificationBatch(models, 'synthetic')]);
  expect(batches.every(batch => batch.failed === 0)).toBe(true);
  expect(await models.Notification.countDocuments()).toBe(2);
  expect((await owner.get(inbox)).body.unread).toBe(1);
  await owner.mutate('patch', inbox + '/' + profileNotification, { read: false }).expect(200);
  expect((await owner.get(inbox)).body.unread).toBe(2);
});
