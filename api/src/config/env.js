import { z } from 'zod';

const mongoUri = z.string().regex(/^mongodb(?:\+srv)?:\/\/\S+$/);
const localMongoUri = z.string().regex(/^mongodb:\/\/127\.0\.0\.1:\d{1,5}\/?$/);
const port = z.coerce.number().int().min(1).max(65535);
const databaseName = z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/);
const reservedDatabase = /^(benefitbridge_(?:demo|test|loadtest)(?:_|$)|admin$|config$|local$)/i;

const developmentEnv = z.object({
  MONGODB_URI: mongoUri.default('mongodb://127.0.0.1:27017'),
  MONGODB_DATABASE: databaseName.default('benefitbridge_dev'),
  PORT: port.default(4000),
});

const demoEnv = z.object({
  DEMO_MONGODB_URI: localMongoUri.default('mongodb://127.0.0.1:27017'),
  DEMO_PORT: port.default(4001),
});

function read(schema, env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error('Invalid environment settings: ' + result.error.issues.map(issue => issue.path.join('.')).join(', '));
  }
  return result.data;
}

export function readConfig(env = process.env, { demo = false, loadtest = false } = {}) {
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
  };
}
