import { once } from 'node:events';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { createApp } from '../api/src/app.js';
import { readConfig } from '../api/src/config/env.js';
import { connectDatabase } from '../api/src/config/database.js';
import { buildFilter, searchSchemes } from '../api/src/modules/catalogue/routes.js';

const volume = Number(process.argv[2] ?? 50_000);
if (!Number.isInteger(volume) || volume < 100 || volume > 100_000) throw new Error('Supply 100–100000 synthetic records.');
const dataset = 'synthetic';
const published = { dataset, publicationStatus: 'published' };
const states = ['MH', 'KA', 'TN', 'KL', 'GJ'];
const categories = ['Education', 'Agriculture', 'Health', 'Transport', 'Housing', 'Industry', 'Research'];
const syntheticUrl = 'https://scale.example.invalid/eligibility';
const now = new Date('2026-10-01T00:00:00Z');
const sampleSize = 160;
const cases = [
  ['text', { q: 'solar' }],
  ['state', { state: 'MH' }],
  ['category-state', { category: 'Education', state: 'MH' }],
  ['pagination', { category: 'Education', page: 30 }],
  ['browse', {}],
];

function fixture(index) {
  const category = categories[index % categories.length];
  const nationwide = index % 11 === 0;
  return {
    ...published, sourceId: 'http-loadtest', externalRecordId: String(index),
    canonicalName: `Fictional ${category} Scheme ${index % 1000}`,
    description: `Synthetic ${category} support. ${index % 131 === 0 ? 'Solar installation.' : 'Community resources.'}`,
    categoryIds: [category], benefitTypes: ['Fictional equipment'], issuer: `Fictional issuer ${index % 37}`,
    governmentLevel: nationwide ? 'central' : 'state', nationwide, stateCodes: nationwide ? [] : [states[index % states.length]],
    lifecycleStatus: index % 23 === 0 ? 'closed' : index % 17 === 0 ? 'unknown' : 'active', verificationStatus: 'verified',
    lastSyncedAt: now, lastVerifiedAt: now, sourceRefs: [{ label: 'Synthetic evidence', url: syntheticUrl }],
  };
}

function plan(result) {
  const stages = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.stage) stages.add(node.indexName ? `${node.stage}(${node.indexName})` : node.stage);
    Object.values(node).forEach(walk);
  }
  const cursor = result.stages?.find(stage => stage.$cursor)?.$cursor ?? result;
  walk(cursor.queryPlanner.winningPlan);
  return { stages: [...stages], keys: cursor.executionStats.totalKeysExamined, docs: cursor.executionStats.totalDocsExamined };
}

const round = value => Math.round(value * 100) / 100;
function latency(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}Ms`, round(sorted[Math.ceil(sorted.length * p / 100) - 1]) || 0]));
}

const mongod = await MongoMemoryServer.create({ binary: { downloadDir: resolve('.local/mongodb') } });
let connection, server;
try {
  const database = await connectDatabase(readConfig({ LOADTEST_MONGODB_URI: mongod.getUri() }, { loadtest: true }));
  const { models } = database;
  connection = database.connection;
  if (connection.name !== 'benefitbridge_loadtest') throw new Error('Expected isolated load-test database.');
  for (let start = 0; start < volume; start += 2000) {
    await models.Scheme.collection.insertMany(Array.from({ length: Math.min(2000, volume - start) }, (_, offset) => fixture(start + offset)));
  }
  const matchIds = [];
  for (const scheme of await models.Scheme.find({ ...published, lifecycleStatus: 'active' }).sort('_id').limit(10)) {
    const version = new connection.base.Types.ObjectId();
    await models.Scheme.updateOne({ _id: scheme._id }, { $set: { currentVersionId: version } });
    await models.SchemeRuleVersion.create({ schemeId: scheme._id, schemeVersionId: version, rule: {
      status: 'verified', evidenceUrl: syntheticUrl, pathsExhaustive: true,
      paths: [{ complete: true, conditions: [{ attribute: 'age', operator: 'atLeast', value: 21 }] }],
    } });
    matchIds.push(scheme.id);
  }
  const plans = [];
  for (const [name, options] of cases) {
    const filters = { page: 1, limit: 10, ...options };
    const [find] = searchSchemes(models.Scheme, published, filters);
    const match = buildFilter(published, filters);
    const count = models.Scheme.aggregate([{ $match: match }, { $count: 'total' }]);
    plans.push({ name, list: plan(await find.explain('executionStats')), count: plan(await count.explain('executionStats')) });
  }
  // Loopback test traffic represents separate clients and still goes through the normal limiters.
  const app = createApp({ models, dataset, isReady: () => true, trustLoopbackProxy: true });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const requests = [
    ...cases.map(([name, options]) => [name, '/schemes?' + new URLSearchParams(options)]),
    ['variant-filter', null],
    ['questions', '/questions?' + new URLSearchParams({ schemeIds: matchIds.join(',') })],
    ['ranking', '/matches/evaluate', { method: 'POST', body: JSON.stringify({ schemeIds: matchIds, answers: { age: 25 } }) }],
  ];
  const mongo = connection.getClient();
  let poolSamples = [];
  let checkoutFailures = 0;
  mongo.on('connectionCheckedOut', event => poolSamples.push(event.durationMS));
  mongo.on('connectionCheckOutFailed', () => { checkoutFailures++; });
  async function run(concurrency, group) {
    const metrics = Object.fromEntries(requests.map(([name]) => [name, []]));
    const failures = {};
    poolSamples = [];
    checkoutFailures = 0;
    const start = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async (_, client) => {
      for (let index = client; index < sampleSize; index += concurrency) {
        const [name, path, options] = requests[(index + Math.floor(index / requests.length)) % requests.length];
        const variant = '/schemes?' + new URLSearchParams({ category: categories[(index + client) % categories.length],
          state: states[(index + client * 3) % states.length], page: String(1 + index % 15) });
        const begin = performance.now();
        try {
          const response = await fetch(base + (path ?? variant), { ...options, signal: AbortSignal.timeout(10_000),
            headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${(group - 1) * 50 + client + 1}` } });
          const body = await response.json();
          if (!response.ok || body.dataset !== dataset) {
            failures[response.status] = (failures[response.status] ?? 0) + 1;
          } else {
            metrics[name].push(performance.now() - begin);
          }
        } catch { failures.transport = (failures.transport ?? 0) + 1; }
      }
    }));
    return { concurrency, failures, requestsPerSecond: round(sampleSize * 1000 / (performance.now() - start)),
      pool: { maxPoolSize: mongo.options.maxPoolSize, checkouts: poolSamples.length, failures: checkoutFailures, ...latency(poolSamples) },
      overall: latency(Object.values(metrics).flat()),
      routes: Object.fromEntries(Object.entries(metrics).map(([name, values]) => [name, { requests: values.length, ...latency(values) }])),
    };
  }
  await run(10, 1);
  const runs = [];
  for (const [index, concurrency] of [1, 10, 50, 50].entries()) runs.push(await run(concurrency, index + 2));
  console.log(JSON.stringify({ volume, node: process.version, os: release(), cpu: cpus()[0]?.model,
    logicalProcessors: availableParallelism(), ramGiB: round(totalmem() / 2 ** 30), mongodb: (await connection.db.admin().serverInfo()).version,
    plans, runs }, null, 2));
  if (runs.some(({ failures }) => Object.keys(failures).length)) process.exitCode = 1;
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await connection?.close();
  await mongod.stop();
}
