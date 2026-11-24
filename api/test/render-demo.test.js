import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';
import { readConfig } from '../src/config/env.js';
import { seedRenderDemo } from '../src/config/render-demo.js';
import { readAuthConfig } from '../src/modules/auth/config.js';

const atlasUri = 'mongodb+srv://demo_user:placeholder@cluster.mongodb.net/?retryWrites=true&w=majority&appName=demo';
const env = {
  RENDER: 'true', RENDER_EXTERNAL_URL: 'https://benefitbridge-demo.onrender.com', PORT: '12345', DEMO_ATLAS_URI: atlasUri,
};
const render = { renderDemo: true };
const cache = fileURLToPath(new URL('../../.local/mongodb/', import.meta.url));
const index = '<!doctype html><title>BenefitBridge test build</title>';
let mongo, database, webRoot;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ binary: { downloadDir: cache } });
  database = await connectDatabase({ ...readConfig(env, render), uri: mongo.getUri() });
  webRoot = await mkdtemp(join(tmpdir(), 'benefitbridge-web-build-'));
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'index.html'), index);
  await writeFile(join(webRoot, 'assets', 'app.js'), 'console.log("synthetic test asset");');
});

afterAll(async () => {
  await database?.connection.close();
  await mongo?.stop();
  if (webRoot) await rm(webRoot, { recursive: true, force: true });
});

it('uses the hosted port, dedicated database and Render HTTPS origin', () => {
  const config = readConfig({ ...env, DEMO_PORT: '4001', MONGODB_DATABASE: 'authorized' }, render);
  expect(config).toMatchObject({ uri: atlasUri, dataset: 'synthetic', database: 'benefitbridge_demo', host: '0.0.0.0',
    port: 12345, origin: env.RENDER_EXTERNAL_URL, connectionOptions: { maxPoolSize: 10 },
  });
  expect(() => readConfig({ ...env, DEMO_ATLAS_URI: undefined, MONGODB_URI: atlasUri }, render)).toThrow(/DEMO_ATLAS_URI/);
  expect(() => readConfig({ ...env, RENDER_EXTERNAL_URL: 'http://benefitbridge-demo.onrender.com' }, render))
    .toThrow(/RENDER_EXTERNAL_URL/);
  expect(() => readConfig({ ...env, DEMO_ATLAS_URI: atlasUri.replace('net/?', 'net/authorized?') }, render)).toThrow(/DEMO_ATLAS_URI/);
  expect(() => readConfig({ ...env, DEMO_ATLAS_URI: atlasUri + '&tls=false' }, render)).toThrow(/DEMO_ATLAS_URI/);
  expect(() => readConfig({ ...env, DEMO_ATLAS_URI: atlasUri.replace('mongodb.net', 'example.test') }, render)).toThrow(/DEMO_ATLAS_URI/);
  expect(() => readConfig(env, { ...render, demo: true })).toThrow(/own deployment mode/);
});

it('seeds an empty demo, reuses the published records and serves the API alongside SPA navigation', async () => {
  const { models } = database;
  const initializers = await Promise.all([seedRenderDemo(models), seedRenderDemo(models)]);
  expect(initializers.reduce((total, { published }) => total + published, 0)).toBe(13);
  expect(await seedRenderDemo(models)).toEqual({ published: 0, skipped: 13 });
  expect(await models.Scheme.countDocuments()).toBe(13);
  expect(await models.SchemeVersion.countDocuments()).toBe(13);
  const auth = readAuthConfig({ NODE_ENV: 'production', DEMO_APP_ORIGIN: env.RENDER_EXTERNAL_URL }, 'synthetic');
  expect(auth).toMatchObject({ secureCookies: true, allowUnverifiedEmail: false, sessionCookie: '__Host-bb_session_demo' });
  const app = createApp({ models, dataset: 'synthetic', isReady: () => true, auth, renderDemo: true, webRoot });
  expect(app.get('trust proxy')).toBe(1);
  const api = request(app);
  const health = await api.get('/api/v1/health').expect(200);
  expect(health.body).toEqual({ status: 'ok', dataset: 'synthetic' });
  const list = await api.get('/api/v1/schemes').expect(200);
  expect(list.body).toMatchObject({ dataset: 'synthetic', pagination: { total: 12 } });
  await api.get('/assets/app.js').expect(200).expect(/synthetic test asset/);
  for (const route of ['/', '/schemes/' + list.body.items[0]._id, '/account/notifications', '/admin']) {
    await api.get(route).set('Accept', 'text/html').expect(200).expect('Cache-Control', 'no-cache').expect(index);
  }
  await api.get('/api/v1/unknown').set('Accept', 'text/html').expect('Content-Type', /json/).expect(404);
  await api.get('/assets/unknown.js').expect(404);
  await api.get('/account').set('Accept', 'application/json').expect(404);
  await api.get('/api/v1/me').expect(401);
  await api.get('/api/v1/admin/sources').expect(401);
  await api.post('/api/v1/auth/register').set('Origin', env.RENDER_EXTERNAL_URL)
    .send({ email: 'demo-visitor@example.test', password: 'local-test-passphrase' }).expect(503);
});

it('refuses to seed a database containing authorized catalogue data', async () => {
  const other = await connectDatabase({ uri: mongo.getUri(), database: 'render_guard_test' });
  try {
    await other.models.Source.collection.insertOne({ _id: 'other-catalogue', dataset: 'authorized' });
    await expect(seedRenderDemo(other.models)).rejects.toThrow(/only synthetic catalogue data/);
    expect(await other.models.Scheme.countDocuments()).toBe(0);
  } finally {
    await other.connection.close();
  }
});
