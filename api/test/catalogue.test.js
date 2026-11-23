import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  it('requires explicit opt-in to trust a local reverse proxy in each environment', () => {
    expect(readConfig({}).trustLoopbackProxy).toBe(false);
    expect(readConfig({ TRUST_LOOPBACK_PROXY: 'true' }).trustLoopbackProxy).toBe(true);
    expect(readConfig({ TRUST_LOOPBACK_PROXY: 'true' }, { demo: true }).trustLoopbackProxy).toBe(false);
    expect(() => readConfig({ TRUST_LOOPBACK_PROXY: 'yes' })).toThrow(/TRUST_LOOPBACK_PROXY/);
    const app = createApp({ models: {}, dataset: 'synthetic', isReady: () => true, trustLoopbackProxy: true });
    const isTrusted = app.get('trust proxy fn');
    expect(isTrusted('127.0.0.1', 0)).toBe(true);
    expect(isTrusted('192.0.2.1', 0)).toBe(false);
  });

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

  it('requires verified publication data and linked evidence for imported eligibility', () => {
    const record = fixture.records[0];
    const unverified = { ...record, verificationStatus: 'stale' };
    const unlinked = { ...record, eligibility: { ...record.eligibility, evidenceUrl: 'https://other.example.invalid' } };
    expect(() => parseFixture({ ...fixture, records: [unverified] }, 'synthetic')).toThrow(/requires a verified scheme/);
    expect(() => parseFixture({ ...fixture, records: [unlinked] }, 'synthetic')).toThrow(/one of the scheme source references/);
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
    const phaseOne = { ...fixture, records: fixture.records.map(({ eligibility, ...record }) => record) };
    expect(await importFixture(demo.models, demoConfig.dataset, phaseOne)).toEqual({ published: 13, skipped: 0 });
    expect(await importFixture(demo.models, demoConfig.dataset, fixture)).toEqual({ published: 0, skipped: 13 });
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

  it('shares only an in-flight count across concurrent pages of the same filtered catalogue', async () => {
    const { Scheme } = demo.models;
    const original = Scheme.countDocuments.bind(Scheme);
    const begin = Promise.withResolvers();
    const executions = vi.fn();
    const counts = vi.spyOn(Scheme, 'countDocuments').mockImplementation(filter => {
      const count = original(filter);
      const exec = count.exec.bind(count);
      count.exec = async () => { executions(); await begin.promise; return exec(); };
      return count;
    });
    try {
      const requests = Promise.all([1, 2].map(page => api.get('/api/v1/schemes')
        .query({ page, limit: 1, state: 'MH' }).expect(200).then(response => response)));
      try {
        await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(2));
      } finally {
        begin.resolve();
      }
      const [first, second] = await requests;
      expect(executions).toHaveBeenCalledTimes(1);
      expect(first.body.pagination.total).toBe(second.body.pagination.total);
      expect(first.body.items[0]._id).not.toBe(second.body.items[0]._id);
      await api.get('/api/v1/schemes').query({ state: 'MH' }).expect(200);
      expect(executions).toHaveBeenCalledTimes(2);
    } finally {
      counts.mockRestore();
    }
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

  it('selects only relevant questions and ranks all selected public results without persisting answers', async () => {
    const { Scheme, SchemeRuleVersion } = demo.models;
    const [solar, garden, education] = await Promise.all(
      ['home-energy', 'garden-kits', 'learning-grant'].map(externalRecordId => Scheme.findOne({ externalRecordId })),
    );
    const schemeIds = [education.id, garden.id, solar.id];
    const rule = await SchemeRuleVersion.findOne({ schemeId: solar.id }).lean();
    expect(String(rule.schemeVersionId)).toBe(String(solar.currentVersionId));
    const before = await SchemeRuleVersion.find({}).sort('_id').lean();
    const collections = await demo.connection.db.listCollections().toArray();

    const solarQuestions = await api.get('/api/v1/questions').query({ schemeIds: solar.id }).expect(200);
    expect(solarQuestions.body.questions.map(question => question.id)).toEqual(['ownsHome', 'hasOwnerPermission']);
    const questions = await api.get('/api/v1/questions').query({ schemeIds: schemeIds.join(',') }).expect(200);
    expect(questions.body.questions.map(question => question.id))
      .toEqual(['age', 'currentlyStudying', 'ownsHome', 'hasOwnerPermission']);
    const result = await api.post('/api/v1/matches/evaluate').send({
      schemeIds, answers: { age: 27, currentlyStudying: false, ownsHome: false, hasOwnerPermission: true },
    }).expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.results.map(({ schemeId, outcome }) => [schemeId, outcome])).toEqual([
      [solar.id, 'POTENTIAL_MATCH'], [garden.id, 'NEEDS_INFO'], [education.id, 'KNOWN_UNMET'],
    ]);
    expect(result.body.results[0].paths.map(path => path.status)).toEqual(['FAIL', 'PASS']);
    expect(await SchemeRuleVersion.find({}).sort('_id').lean()).toEqual(before);
    expect(await demo.connection.db.listCollections().toArray()).toEqual(collections);
  });

  it('suppresses mismatched versions, stale rules, and cross-environment scheme IDs', async () => {
    const { Scheme } = demo.models;
    const solar = await Scheme.findOne({ externalRecordId: 'home-energy' });
    for (const update of [{ verificationStatus: 'stale' }, { currentVersionId: '000000000000000000000002' }]) {
      try {
        await Scheme.updateOne({ _id: solar._id }, { $set: update });
        const questions = await api.get('/api/v1/questions').query({ schemeIds: solar.id }).expect(200);
        expect(questions.body.questions).toEqual([]);
        const match = await api.post('/api/v1/matches/evaluate').send({ schemeIds: [solar.id], answers: {} }).expect(200);
        expect(match.body.results).toMatchObject([{ outcome: 'NEEDS_INFO', paths: [] }]);
      } finally {
        await Scheme.updateOne({ _id: solar._id }, { $set: {
          verificationStatus: 'verified', currentVersionId: solar.currentVersionId,
        } });
      }
    }
    const result = await normalApi.post('/api/v1/matches/evaluate').send({ schemeIds: [solar.id], answers: {} }).expect(200);
    expect(result.body).toEqual({ dataset: 'authorized', results: [] });
  });

  it('refuses changed rule sets and invalid, oversized or irrelevant answers without echoing request data', async () => {
    const record = fixture.records[0];
    const changed = { ...record, eligibility: { ...record.eligibility, pathsExhaustive: false } };
    await expect(importFixture(demo.models, 'synthetic', { ...fixture, records: [changed] })).rejects.toThrow(/requires review/);
    const scheme = await demo.models.Scheme.findOne({ externalRecordId: record.externalRecordId });
    const schemeIds = [scheme.id];
    const privateValue = 'private-guest-value';
    const invalid = await api.post('/api/v1/matches/evaluate').send({
      schemeIds, answers: { [privateValue]: privateValue },
    }).expect(400);
    expect(invalid.text).not.toContain(privateValue);
    await api.post('/api/v1/matches/evaluate').send({ schemeIds, answers: { ownsHome: true } }).expect(400);
    await api.post('/api/v1/matches/evaluate').send({ schemeIds, answers: { age: 200 } }).expect(400);
    const malformed = await api.post('/api/v1/matches/evaluate').type('json').send('{"' + privateValue).expect(400);
    expect(malformed.text).not.toContain(privateValue);
    await api.post('/api/v1/matches/evaluate').send({ schemeIds, answers: { age: 'x'.repeat(9000) } }).expect(413);
    await api.get('/api/v1/questions').query({ schemeIds: [scheme.id, scheme.id].join(',') }).expect(400);
  });
});
