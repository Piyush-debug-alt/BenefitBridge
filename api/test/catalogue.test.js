import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';
import { readConfig } from '../src/config/env.js';
import { parseFixture, readFixture } from '../src/modules/ingestion/file-adapter.js';
import { importFixture } from '../src/modules/ingestion/import-fixture.js';

const fixturePath = new URL('./fixtures/synthetic/catalogue.json', import.meta.url);
const cachePath = fileURLToPath(new URL('../../.local/mongodb/', import.meta.url));
const fixture = await readFixture(fixturePath, 'synthetic');

describe('configuration and fixture validation', () => {
  it('reserves the demo database and rejects a non-local demo URI', () => {
    expect(() => readConfig({ MONGODB_DATABASE: 'BenefitBridge_Demo' })).toThrow(/dedicated/);
    expect(() => readConfig({ DEMO_MONGODB_URI: 'mongodb://db.example.net:27017' }, { demo: true })).toThrow(/Invalid/);
    const demo = readConfig({ MONGODB_DATABASE: 'benefitbridge_dev' }, { demo: true });
    expect(demo).toMatchObject({ database: 'benefitbridge_demo', dataset: 'synthetic' });
  });

  it('blocks synthetic fixture imports into normal mode', () => {
    expect(() => parseFixture(fixture, 'authorized')).toThrow(/target environment/);
    expect(() => parseFixture({ ...fixture, dataset: 'authorized' }, 'authorized')).toThrow(/reserved for the demo/);
  });

  it('rejects duplicate IDs and invalid geographic scope', () => {
    const invalid = { ...fixture, records: [fixture.records[0], { ...fixture.records[0], governmentLevel: 'state' }] };
    expect(() => parseFixture(invalid, 'synthetic')).toThrow(/Duplicate source record ID/);
    expect(() => parseFixture(invalid, 'synthetic')).toThrow(/Nationwide scope/);
  });
});

describe('catalogue backed by MongoDB', () => {
  let mongo;
  let demo;
  let development;
  let api;
  let normalApi;
  const names = response => response.body.items.map(item => item.canonicalName);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: cachePath } });
    const demoConfig = readConfig({ DEMO_MONGODB_URI: mongo.getUri() }, { demo: true });
    const normalConfig = readConfig({ MONGODB_URI: mongo.getUri() });
    demo = await connectDatabase(demoConfig);
    development = await connectDatabase(normalConfig);
    api = request(createApp({ models: demo.models, dataset: demoConfig.dataset, isReady: () => true }));
    normalApi = request(createApp({ models: development.models, dataset: normalConfig.dataset, isReady: () => true }));
    expect(await importFixture(demo.models, demoConfig.dataset, fixture)).toEqual({ published: 13, skipped: 0 });
  });

  afterAll(async () => {
    await Promise.all([demo?.connection.close(), development?.connection.close()]);
    await mongo?.stop();
  });

  it('indexes searchable fields and finds relevant catalogue records by text and goal', async () => {
    const indexes = await demo.models.Scheme.collection.indexes();
    expect(indexes.find(index => index.key._fts === 'text').weights).toHaveProperty('canonicalName', 8);
    const text = await api.get('/api/v1/schemes').query({ q: 'rooftop solar' }).expect(200);
    expect(names(text)).toEqual(['Home Energy Upgrade Rebate']);
    const goal = await api.get('/api/v1/schemes').query({ goal: 'learning' }).expect(200);
    expect(names(goal)).toEqual(expect.arrayContaining(['Learning Materials Grant', 'Community Library Pass']));
  });

  it('includes nationwide central and matching regional records when filtering by state', async () => {
    const response = await api.get('/api/v1/schemes').query({ state: 'mh', limit: 50 }).expect(200);
    expect(names(response)).toContain('Home Energy Upgrade Rebate');
    expect(names(response)).toContain('Student Travel Support');
    expect(names(response)).not.toContain('Community Garden Starter Kit');
    expect(names(response)).not.toContain('Rural Connectivity Trial');

    const regionalCentral = await api.get('/api/v1/schemes').query({
      state: 'KA', governmentLevel: 'central', category: 'Technology',
    }).expect(200);
    expect(names(regionalCentral)).toEqual(['Rural Connectivity Trial']);

    const withText = await api.get('/api/v1/schemes').query({ state: 'MH', q: 'solar' }).expect(200);
    expect(names(withText)).toEqual(['Home Energy Upgrade Rebate']);
  });

  it('paginates with stable ordering and exposes metadata-backed facets', async () => {
    const first = await api.get('/api/v1/schemes').query({ limit: 2 }).expect(200);
    const next = await api.get('/api/v1/schemes').query({ limit: 2, page: 2 }).expect(200);
    expect(first.body.pagination).toEqual({ page: 1, limit: 2, total: 12, totalPages: 6 });
    expect(names(next).some(name => names(first).includes(name))).toBe(false);
    const repeat = await api.get('/api/v1/schemes').query({ limit: 2, page: 2 }).expect(200);
    expect(names(repeat)).toEqual(names(next));
    const facets = await api.get('/api/v1/facets').expect(200);
    expect(facets.body).toMatchObject({ dataset: 'synthetic', states: ['KA', 'MH', 'TN'] });
  });

  it('shows provenance in detail and only lists closed schemes through the closed filter', async () => {
    const ordinary = await api.get('/api/v1/schemes').query({ category: 'Energy' }).expect(200);
    expect(names(ordinary)).toEqual(['Home Energy Upgrade Rebate']);
    const closed = await api.get('/api/v1/schemes').query({ state: 'MH', lifecycleStatus: 'closed' }).expect(200);
    expect(names(closed)).toEqual(['Efficient Lighting Trial']);
    const detail = await api.get('/api/v1/schemes/' + ordinary.body.items[0]._id).expect(200);
    expect(detail.body.item.sourceRefs[0].url).toMatch(/\.invalid\//);
    expect(detail.body.item.lastVerifiedAt).toBeTruthy();
    expect(detail.body.item).not.toHaveProperty('externalRecordId');
  });

  it('returns empty results and consistent validation and not-found errors', async () => {
    const empty = await api.get('/api/v1/schemes').query({ q: 'zznonexistentzz' }).expect(200);
    expect(empty.body.items).toEqual([]);
    const bad = await api.get('/api/v1/schemes?limit=100&state=MH&state=KA').expect(400);
    expect(bad.body).toMatchObject({ code: 'INVALID_REQUEST', requestId: bad.headers['x-request-id'] });
    await api.get('/api/v1/schemes?state[$ne]=MH').expect(400);
    await api.get('/api/v1/schemes/bad-id').expect(400);
    const missing = await api.get('/api/v1/schemes/000000000000000000000001').expect(404);
    expect(missing.body.code).toBe('SCHEME_NOT_FOUND');
  });

  it('keeps demo fixtures isolated from the authorized development database', async () => {
    expect(demo.connection.name).toBe('benefitbridge_demo');
    expect(development.connection.name).toBe('benefitbridge_dev');
    const normal = await normalApi.get('/api/v1/schemes').expect(200);
    expect(normal.body).toMatchObject({ dataset: 'authorized', items: [] });
    const demoResult = await api.get('/api/v1/schemes').expect(200);
    await normalApi.get('/api/v1/schemes/' + demoResult.body.items[0]._id).expect(404);
  });

  it('skips repeat imports and preserves one initial version and provenance record per scheme', async () => {
    expect(await importFixture(demo.models, 'synthetic', fixture)).toEqual({ published: 0, skipped: 13 });
    const { Scheme, SchemeVersion, Source, SourceRecord } = demo.models;
    expect(await Scheme.countDocuments()).toBe(13);
    expect(await SchemeVersion.countDocuments()).toBe(13);
    expect(await SourceRecord.countDocuments()).toBe(13);
    expect(await Source.countDocuments()).toBe(1);
    const scheme = await Scheme.findOne({ externalRecordId: fixture.records[0].externalRecordId });
    const version = await SchemeVersion.findById(scheme.currentVersionId);
    expect(version.fieldProvenance.get('description')[0].url).toBe(fixture.records[0].sourceRefs[0].url);
    expect(await SourceRecord.exists({ _id: version.sourceRecordId })).toBeTruthy();

    const changed = { ...fixture, records: [{ ...fixture.records[0], description: 'Changed fixture description.' }] };
    await expect(importFixture(demo.models, 'synthetic', changed)).rejects.toThrow(/requires review/);
    expect((await Scheme.findById(scheme._id)).description).toBe(fixture.records[0].description);
  });
});
