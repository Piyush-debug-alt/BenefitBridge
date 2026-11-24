import { z } from 'zod';

const mongoUri = z.string().regex(/^mongodb(?:\+srv)?:\/\/\S+$/);
const localMongoUri = z.string().regex(/^mongodb:\/\/127\.0\.0\.1:\d{1,5}\/?$/);
const port = z.coerce.number().int().min(1).max(65535);
const proxySetting = z.enum(['true', 'false']).default('false').transform(value => value === 'true');
const databaseName = z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/);
const reservedDatabase = /^(benefitbridge_(?:demo|test|loadtest)(?:_|$)|admin$|config$|local$)/i;

const developmentEnv = z.object({
  MONGODB_URI: mongoUri.default('mongodb://127.0.0.1:27017'),
  MONGODB_DATABASE: databaseName.default('benefitbridge_dev'),
  PORT: port.default(4000),
  TRUST_LOOPBACK_PROXY: proxySetting,
});

const demoEnv = z.object({
  DEMO_MONGODB_URI: localMongoUri.default('mongodb://127.0.0.1:27017'),
  DEMO_PORT: port.default(4001),
  DEMO_TRUST_LOOPBACK_PROXY: proxySetting,
});

function isDemoAtlasUri(value) {
  try {
    const uri = new URL(value);
    const options = [...uri.searchParams];
    const allowed = { retryWrites: 'true', w: 'majority', authSource: 'admin' };
    return uri.protocol === 'mongodb+srv:' && Boolean(uri.username && uri.password) && !uri.port && !uri.hash &&
      /^[a-z\d-]+(?:\.[a-z\d-]+)*\.mongodb\.net$/i.test(uri.hostname) &&
      ['', '/', '/benefitbridge_demo'].includes(uri.pathname) &&
      new Set(uri.searchParams.keys()).size === options.length && options.every(([key, option]) =>
        key === 'appName' ? option.length > 0 && Buffer.byteLength(option) <= 128 : Object.hasOwn(allowed, key) && option === allowed[key]);
  } catch {
    return false;
  }
}

const renderEnv = z.object({
  RENDER: z.literal('true'),
  RENDER_EXTERNAL_URL: z.url({ protocol: /^https$/, hostname: /^[a-z\d-]+\.onrender\.com$/ })
    .refine(value => new URL(value).origin === value.replace(/\/$/, ''))
    .transform(value => new URL(value).origin),
  PORT: port,
  DEMO_ATLAS_URI: z.string().max(2048).refine(isDemoAtlasUri),
});

function read(schema, env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error('Invalid environment settings: ' + result.error.issues.map(issue => issue.path.join('.')).join(', '));
  }
  return result.data;
}

export function readConfig(env = process.env, { demo = false, loadtest = false, renderDemo = false } = {}) {
  if (renderDemo) {
    if (demo || loadtest) throw new Error('The Render demo must start in its own deployment mode.');
    const values = read(renderEnv, env);
    return {
      uri: values.DEMO_ATLAS_URI,
      database: 'benefitbridge_demo',
      dataset: 'synthetic',
      origin: values.RENDER_EXTERNAL_URL,
      port: values.PORT,
      host: '0.0.0.0',
      connectionOptions: { maxPoolSize: 10, maxIdleTimeMS: 60_000, serverSelectionTimeoutMS: 15_000 },
    };
  }
  if (loadtest) {
    const { LOADTEST_MONGODB_URI } = read(z.object({ LOADTEST_MONGODB_URI: localMongoUri }), env);
    return { uri: LOADTEST_MONGODB_URI, database: 'benefitbridge_loadtest', dataset: 'synthetic' };
  }
  if (demo) {
    const values = read(demoEnv, env);
    return {
      uri: values.DEMO_MONGODB_URI,
      database: 'benefitbridge_demo',
      dataset: 'synthetic',
      port: values.DEMO_PORT,
      host: '127.0.0.1',
      trustLoopbackProxy: values.DEMO_TRUST_LOOPBACK_PROXY,
    };
  }

  const values = read(developmentEnv, env);
  if (reservedDatabase.test(values.MONGODB_DATABASE)) {
    throw new Error('MONGODB_DATABASE must use a dedicated real-data database name.');
  }
  return {
    uri: values.MONGODB_URI,
    database: values.MONGODB_DATABASE,
    dataset: 'authorized',
    port: values.PORT,
    host: '127.0.0.1',
    trustLoopbackProxy: values.TRUST_LOOPBACK_PROXY,
  };
}
