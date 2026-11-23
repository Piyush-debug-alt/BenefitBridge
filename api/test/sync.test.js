import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';
import { readConfig } from '../src/config/env.js';
import { FeedError, fileAdapter, httpAdapter, withRetry } from '../src/modules/ingestion/adapters.js';
import { enqueueSync, workSource } from '../src/modules/ingestion/sync.js';
import { decideReview } from '../src/modules/ingestion/publication.js';
import { processNotificationBatch } from '../src/modules/notifications/worker.js';

const cache = fileURLToPath(new URL('../../.local/mongodb/', import.meta.url));
const fixture = name => new URL('./fixtures/synthetic/sync-' + name + '.json', import.meta.url);
const dataset = 'synthetic';
const origin = 'http://127.0.0.1:5174';
const base = '/api/v1';
let mongo, db, models, app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { downloadDir: cache } });
  db = await connectDatabase(readConfig({ DEMO_MONGODB_URI: mongo.getUri() }, { demo: true }));
  models = db.models;
  app = createApp({ models, dataset, isReady: () => true });
});
afterAll(async () => {
  await db?.connection.close();
  await mongo?.stop();
});

async function user(email, administrator) {
  const agent = request.agent(app);
  const data = { email, password: 'test-only-long-password' };
  await agent.post(base + '/auth/register').set('Origin', origin).send(data).expect(202);
  if (administrator) await models.User.updateOne({ email }, { $set: { isAdministrator: true } });
  await agent.post(base + '/auth/login').set('Origin', origin).send(data).expect(200);
  return agent;
}

it('stages snapshots, authorizes review, publishes versioned variants, and distinguishes missing records from closure', async () => {
  const file = await fileAdapter(fixture('snapshot'), dataset);
  await enqueueSync(models, dataset, file.metadata.id, 'snapshot');
  expect((await workSource(models, dataset, file)).status).toBe('succeeded');
  expect(await models.Scheme.countDocuments()).toBe(0);
  expect(await models.ReviewCase.countDocuments({ status: 'pending' })).toBe(2);

  const admin = await user('reviewer@example.test', true);
  const ordinary = await user('reader@example.test', false);
  await request(app).get(base + '/admin/reviews').expect(401);
  await ordinary.get(base + '/admin/reviews').expect(403);
  const { items } = (await admin.get(base + '/admin/reviews').expect(200)).body;
  const parent = items.find(item => item.externalRecordId === 'm5-study');
  const variant = items.find(item => item.externalRecordId === 'm5-study-mh');
  const decision = (item, action = 'approve', actor = admin, from = origin) => actor
    .post(base + '/admin/reviews/' + item._id + '/decision').set('Origin', from).send({ action, reason: 'Checked fictional source evidence' });
  await decision(parent, 'approve', ordinary).expect(403);
  await decision(parent, 'approve', admin, 'https://other.invalid').expect(403);
  const evidence = (await admin.get(base + '/admin/reviews/' + parent._id).expect(200)).body.provenance;
  expect(evidence.permittedReference).toMatch(/m5-study$/);
  expect(evidence).not.toHaveProperty('permittedOriginal');

  await decision(parent).expect(200);
  await workSource(models, dataset, file);
  await ordinary.put(base + '/me/profile').set('Origin', origin)
    .send({ attributes: { age: 27 }, consent: true }).expect(200);
  await ordinary.put(base + '/me/notification-preferences').set('Origin', origin)
    .send({ bookmarkUpdates: true, profileMatches: true }).expect(200);
  await decision(variant).expect(200);
  await workSource(models, dataset, file);
  const published = await models.Scheme.findOne({ externalRecordId: 'm5-study' });
  const child = await models.Scheme.findOne({ externalRecordId: 'm5-study-mh' });
  const variantRule = await models.SchemeRuleVersion.findOne({ schemeId: child._id });
  await ordinary.post(base + '/me/bookmarks').set('Origin', origin).send({ schemeId: published.id }).expect(200);
  const getParent = () => request(app).get(base + '/schemes/' + published.id).expect(200);
  expect((await getParent()).body.item.variants[0]._id).toBe(child.id);
  expect(variantRule.rule.paths[0].conditions[0].value).toBe(18);

  const update = await fileAdapter(fixture('update'), dataset);
  await enqueueSync(models, dataset, update.metadata.id, 'snapshot');
  expect((await workSource(models, dataset, update)).status).toBe('succeeded');
  const changed = await models.ReviewCase.findOne({ kind: 'candidate', status: 'pending', externalRecordId: 'm5-study' });
  const underReview = (await getParent()).body.item;
  expect(underReview.disputedFields).toEqual(expect.arrayContaining(['benefits', 'applicationDeadline']));
  expect(underReview.benefits).toEqual(['Fictional study materials']);
  expect(await models.ChangeEvent.countDocuments({ type: 'bookmark_update' })).toBe(0);
  await decision(changed).expect(200);
  await workSource(models, dataset, update);
  expect((await getParent()).body.item.applicationDeadline).toBe('2026-12-31');
  expect(await models.SchemeVersion.countDocuments({ schemeId: published._id })).toBe(2);
  expect(await models.ChangeEvent.countDocuments({ type: 'bookmark_update' })).toBe(1);
  expect(String((await models.SchemeRuleVersion.findOne({ schemeId: child._id }))._id)).toBe(String(variantRule._id));
  expect((await processNotificationBatch(models, dataset)).failed).toBe(0);
  expect((await ordinary.get(base + '/me/notifications').expect(200)).body.items.map(item => item.type).sort())
    .toEqual(['bookmark_update', 'profile_match']);

  // Replaying the older file leaves the newer material version in place.
  await enqueueSync(models, dataset, file.metadata.id, 'snapshot');
  await workSource(models, dataset, file);
  expect((await getParent()).body.item.applicationDeadline).toBe('2026-12-31');
  expect(await models.SchemeVersion.countDocuments({ schemeId: published._id })).toBe(2);

  const firstObservation = (await file.page({ cursor: null })).records[0];
  const verifiedObservation = (await update.page({ cursor: null })).records[0];
  const delta = (record, checkpoint) => ({ ...file, incremental: true, async page() {
    return { records: [record], nextCursor: null, checkpoint };
  } });
  await enqueueSync(models, dataset, file.metadata.id, 'incremental');
  await workSource(models, dataset, delta({ ...firstObservation, updatedAt: verifiedObservation.updatedAt }, 'conflict'));
  expect((await getParent()).body.item.verificationStatus).toBe('disputed');
  await enqueueSync(models, dataset, file.metadata.id, 'incremental');
  await workSource(models, dataset, delta({ ...verifiedObservation, updatedAt: '2026-10-03T00:00:00Z' }, 'reconfirmed'));
  expect((await getParent()).body.item.verificationStatus).toBe('verified');
  expect(await models.ReviewCase.countDocuments({ kind: 'conflict', status: 'superseded', schemeId: published._id })).toBe(1);

  const empty = { ...file, async page() { return { records: [], snapshotKey: 'empty-snapshot', nextCursor: null, complete: false }; } };
  await enqueueSync(models, dataset, file.metadata.id, 'snapshot');
  expect((await workSource(models, dataset, empty)).status).toBe('failed');
  expect((await getParent()).body.item.verificationStatus).toBe('verified');
  expect((await getParent()).body.item.sourceSyncInterrupted).toBe(true);

  const complete = { ...empty, async page() { return { records: [], snapshotKey: 'empty-snapshot', nextCursor: null, complete: true }; } };
  await enqueueSync(models, dataset, file.metadata.id, 'snapshot');
  await workSource(models, dataset, complete);
  const missing = await models.ReviewCase.findOne({ externalRecordId: 'm5-study', kind: 'missing' });
  await decision(missing).expect(400);
  const stillVisible = (await getParent()).body.item;
  expect(stillVisible.lifecycleStatus).toBe('active');
  expect(stillVisible.verificationStatus).toBe('under_review');

  const evidencePage = await update.page({ cursor: null });
  const closed = { ...evidencePage.records[0], updatedAt: '2026-10-04T00:00:00Z' };
  closed.record = { ...closed.record, lifecycleStatus: 'closed' };
  closed.closureEvidence = closed.record.sourceRefs[0].url;
  const closureFeed = { ...file, incremental: true, async page() {
    return { records: [closed], nextCursor: null, checkpoint: 'closure-confirmed' };
  } };
  await enqueueSync(models, dataset, file.metadata.id, 'incremental');
  await workSource(models, dataset, closureFeed);
  const closing = await models.ReviewCase.findOne({ externalRecordId: 'm5-study', status: 'pending',
    'normalization.record.lifecycleStatus': 'closed' });
  expect((await getParent()).body.item.lifecycleStatus).toBe('active');
  const beforeClosure = await models.SchemeVersion.findOne({ schemeId: published._id, versionNo: 2 }).lean();
  await models.SchemeVersion.create({
    schemeId: published._id, versionNo: 3, recordHash: 'interrupted-reservation',
    sourceRecordId: beforeClosure.sourceRecordId, fields: beforeClosure.fields,
    fieldProvenance: beforeClosure.fieldProvenance, publishedAt: new Date(),
  });
  await decision(closing).expect(200);
  await workSource(models, dataset, closureFeed);
  expect((await getParent()).body.item.lifecycleStatus).toBe('closed');
  const current = await models.Scheme.findById(published.id);
  expect((await models.SchemeVersion.findById(current.currentVersionId)).versionNo).toBe(4);
});

it('replays interrupted paging without checkpoint loss and retries transient HTTP responses', async () => {
  const file = await fileAdapter(fixture('snapshot'), dataset);
  const info = { ...file.metadata, id: 'retry-source', retentionPolicy: 'permitted_original' };
  const sample = (await file.page({ cursor: null })).records[0];
  const pause = vi.fn(async () => {});
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'Retry-After': '1' } }))
    .mockResolvedValueOnce(Response.json({ records: [], nextCursor: null, checkpoint: 'probe' }));
  const http = httpAdapter({ endpoint: 'https://sync.example.invalid/feed', metadata: info,
    authorization: 'test-provider-token', incremental: true, requestIntervalMs: 0, fetcher });
  await withRetry(() => http.page({ mode: 'incremental', checkpoint: 'before', cursor: null }), { sleep: pause });
  expect(pause).toHaveBeenCalledWith(1000);
  expect(fetcher.mock.lastCall[0].searchParams.get('checkpoint')).toBe('before');

  const job = await enqueueSync(models, dataset, info.id, 'incremental');
  const adapter = { metadata: info, incremental: true, async page({ cursor }) {
    if (cursor) throw new FeedError('PROVIDER_UNAVAILABLE', true);
    return { records: [sample], nextCursor: 'second' };
  } };
  const failed = await workSource(models, dataset, adapter, { sleep: pause });
  expect(failed.status).toBe('queued');
  expect((await models.SyncSource.findById(info.id)).checkpoint).toBeUndefined();
  expect((await models.SyncJob.findById(job.id)).errorCode).toBe('PROVIDER_UNAVAILABLE');
  const partialReview = await models.ReviewCase.findOne({ sourceId: info.id, kind: 'candidate' });
  await expect(decideReview(models, partialReview, 'approve', undefined, 'This job is incomplete'))
    .rejects.toMatchObject({ code: 'REVIEW_REQUIRES_COMPLETED_SYNC' });

  await models.SyncJob.updateOne({ _id: job._id }, { $set: {
    status: 'running', leaseUntil: new Date(0), lease: 'interrupted-worker',
  } });
  const recovered = { ...adapter, async page({ cursor }) {
    if (cursor) return { records: [{ record: { externalRecordId: 'bad' } }], nextCursor: null, checkpoint: 'recovered' };
    return { records: [sample], nextCursor: 'second' };
  } };
  expect((await workSource(models, dataset, recovered)).status).toBe('succeeded');
  const stored = await models.SyncJob.findById(job.id);
  expect(stored).toMatchObject({ attempts: 2, checkpointAfter: 'recovered', stats: { invalid: 1, pages: 2 } });
  expect(await models.ReviewCase.countDocuments({ sourceId: info.id })).toBe(2);
  const raw = await models.SourceRecord.findOne({ sourceId: info.id }).select('+permittedOriginal');
  expect(raw.permittedOriginal.record.externalRecordId).toBe('m5-study');
  expect(() => readConfig({ MONGODB_DATABASE: 'benefitbridge_loadtest' })).toThrow(/dedicated/);
});

it('keeps ambiguous identities in staging and refuses a changing snapshot generation', async () => {
  const file = await fileAdapter(fixture('snapshot'), dataset);
  const source = { ...file.metadata, id: 'unstable-source' };
  const candidate = (await file.page({ cursor: null })).records[0];
  const uncertain = { ...candidate, authenticity: 'uncertain' };
  const job = await enqueueSync(models, dataset, source.id, 'snapshot');
  const changing = { metadata: source, incremental: false, async page({ cursor }) {
    return cursor ? { records: [], snapshotKey: 'drifted', nextCursor: null, complete: true }
      : { records: [uncertain], snapshotKey: 'pinned', nextCursor: 'next' };
  } };
  expect((await workSource(models, dataset, changing)).status).toBe('failed');
  expect((await models.SyncJob.findById(job.id)).errorCode).toBe('SNAPSHOT_CHANGED_OR_UNPINNED');
  expect(await models.Scheme.countDocuments({ sourceId: source.id })).toBe(0);
  const staged = await models.ReviewCase.findOne({ sourceId: source.id });
  expect(staged.kind).toBe('conflict');
  await expect(decideReview(models, staged, 'approve', undefined, 'Incomplete snapshot evidence'))
    .rejects.toMatchObject({ code: 'REVIEW_REQUIRES_COMPLETED_SYNC' });
});
