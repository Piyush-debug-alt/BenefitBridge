import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';
import { readConfig } from '../src/config/env.js';
import { fileAdapter } from '../src/modules/ingestion/adapters.js';
import { importFixture } from '../src/modules/ingestion/import-fixture.js';
import { enqueueSync, workSource } from '../src/modules/ingestion/sync.js';

const snapshot = new URL('../../data/authorized/pib-pilot.json', import.meta.url);
const demoFixture = new URL('./fixtures/synthetic/catalogue.json', import.meta.url);
const cache = fileURLToPath(new URL('../../.local/mongodb/', import.meta.url));
const origin = 'http://127.0.0.1:5173';
const base = '/api/v1';
let mongo, authorized, demo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { downloadDir: cache } });
  const uri = mongo.getUri();
  authorized = await connectDatabase(readConfig({ MONGODB_URI: uri, MONGODB_DATABASE: 'benefitbridge_pib_integration' }));
  demo = await connectDatabase(readConfig({ DEMO_MONGODB_URI: uri }, { demo: true }));
});

afterAll(async () => {
  await Promise.all([authorized?.connection.close(), demo?.connection.close()]);
  await mongo?.stop();
});

it('reviews and publishes the PIB snapshot with precise evidence, with repeat imports isolated from the demo', async () => {
  const adapter = await fileAdapter(snapshot, 'authorized');
  await expect(fileAdapter(snapshot, 'synthetic')).rejects.toMatchObject({ code: 'INVALID_FILE' });
  const synthetic = JSON.parse(await readFile(demoFixture, 'utf8'));
  await expect(importFixture(demo.models, 'synthetic', synthetic)).resolves.toMatchObject({ published: 13 });
  const beforeDemo = await demo.models.Scheme.find().sort('_id').lean();

  const { models } = authorized;
  const app = createApp({ models, dataset: 'authorized', isReady: () => true });
  const get = path => request(app).get(base + path).expect(200);
  async function sync() {
    const job = await enqueueSync(models, 'authorized', adapter.metadata.id, 'snapshot');
    await expect(workSource(models, 'authorized', adapter)).resolves.toMatchObject({ status: 'succeeded' });
    return models.SyncJob.findById(job.id).lean();
  }

  expect((await sync()).stats).toMatchObject({ staged: 2, invalid: 0 });
  expect((await get('/schemes')).body.pagination.total).toBe(0);
  const admin = request.agent(app);
  const credentials = { email: 'pib-reviewer@example.test', password: 'test-only-reviewer-password' };
  await admin.post(base + '/auth/register').set('Origin', origin).send(credentials).expect(202);
  await models.User.updateOne({ email: credentials.email }, { $set: { isAdministrator: true } });
  await admin.post(base + '/auth/login').set('Origin', origin).send(credentials).expect(200);
  const pending = (await admin.get(base + '/admin/reviews?status=pending').expect(200)).body.items;
  const entries = (await adapter.page({ cursor: null })).records;
  expect(pending).toHaveLength(entries.length);
  for (const entry of entries) {
    const item = pending.find(row => row.externalRecordId === entry.record.externalRecordId);
    const path = base + '/admin/reviews/' + item._id;
    const { review, provenance, source } = (await admin.get(path).expect(200)).body;
    expect(review.normalization.fieldProvenance.benefits.map(ref => ref.url)).toEqual(entry.fieldProvenance.benefits);
    expect(provenance.retrievedAt).toBe(new Date(entry.retrievedAt).toISOString());
    expect(provenance.providerUpdatedAt).toBe(new Date(entry.updatedAt).toISOString());
    expect(provenance).not.toHaveProperty('permittedOriginal');
    expect(source).toMatchObject({ retentionPolicy: 'reference_only', accessPermissions: expect.stringContaining('prominent acknowledgment') });
    await admin.post(path + '/decision').set('Origin', origin)
      .send({ action: 'approve', reason: 'Validated PIB evidence and application guidance' }).expect(200);
  }
  expect((await get('/schemes')).body.pagination.total).toBe(0);
  await expect(workSource(models, 'authorized', adapter)).resolves.toMatchObject({ reviewed: 2 });

  const solar = (await get('/schemes?q=rooftop&category=Energy&state=MH')).body.items;
  const artisan = (await get('/schemes?q=Vishwakarma&benefitType=Toolkit&lifecycleStatus=unknown')).body.items;
  expect(solar.map(item => item.canonicalName)).toEqual(['PM Surya Ghar: Muft Bijli Yojana']);
  expect(artisan.map(item => item.canonicalName)).toEqual(['PM Vishwakarma']);
  expect((await get('/schemes?state=TN&governmentLevel=central')).body.pagination.total).toBe(2);
  expect((await get('/schemes?governmentLevel=state')).body.pagination.total).toBe(0);
  const solarDetail = (await get('/schemes/' + solar[0]._id)).body.item;
  const artisanDetail = (await get('/schemes/' + artisan[0]._id)).body.item;
  expect(solarDetail).toMatchObject({
    applicationUrl: 'https://www.pmsuryaghar.gov.in/',
    eligibilityText: expect.stringContaining('grid-connected'),
    sourceRefs: expect.arrayContaining([expect.objectContaining({ label: expect.stringContaining('PIB / Ministry') })]),
  });
  expect(artisanDetail.description).toContain('Check with a CSC');
  expect(artisanDetail).not.toHaveProperty('applicationUrl');
  expect(artisanDetail.sourceRefs).toContainEqual({
    label: 'PM Vishwakarma government portal — scheme information', url: 'https://pmvishwakarma.gov.in/',
  });
  for (const item of [solarDetail, artisanDetail]) expect(item).not.toHaveProperty('applicationDeadline');
  for (const entry of entries) {
    const scheme = await models.Scheme.findOne({ externalRecordId: entry.record.externalRecordId }).lean();
    const version = await models.SchemeVersion.findById(scheme.currentVersionId).lean();
    expect(version.versionNo).toBe(1);
    expect(Object.fromEntries(Object.entries(version.fieldProvenance).map(([field, refs]) => [
      field, refs.map(ref => ref.url),
    ]))).toEqual(entry.fieldProvenance);
  }
  expect(await models.SchemeRuleVersion.countDocuments()).toBe(0);
  expect((await sync()).stats).toMatchObject({ unchanged: 2, staged: 0 });
  expect(await models.SchemeVersion.countDocuments()).toBe(2);
  expect(await models.SourceRecord.countDocuments()).toBe(2);
  expect(await models.ReviewCase.countDocuments({ status: 'published' })).toBe(2);
  expect(await demo.models.Scheme.find().sort('_id').lean()).toEqual(beforeDemo);

  const invalidEvidence = {
    ...adapter,
    async page(args) {
      const page = await adapter.page(args);
      const [first, ...rest] = page.records;
      const fieldProvenance = { ...first.fieldProvenance, benefits: ['https://www.pib.gov.in/'] };
      return { ...page, records: [{ ...first, fieldProvenance }, ...rest] };
    },
  };
  const badJob = await enqueueSync(models, 'authorized', adapter.metadata.id, 'snapshot');
  await workSource(models, 'authorized', invalidEvidence);
  const rejected = await models.ReviewCase.findOne({ jobId: badJob.id, kind: 'invalid' }).lean();
  expect(rejected.errorCode).toBe('UNSUPPORTED_PROVENANCE');
  expect(await models.SchemeVersion.countDocuments()).toBe(2);
});
