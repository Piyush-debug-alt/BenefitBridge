import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { readConfig } from './config/env.js';
import { readAuthConfig } from './modules/auth/config.js';

async function start() {
  const config = readConfig(process.env, { demo: process.argv.includes('--demo') });
  const auth = readAuthConfig(process.env, config.dataset);
  const { connection, models } = await connectDatabase(config);
  const app = createApp({
    models,
    dataset: config.dataset,
    auth,
    isReady: () => connection.readyState === 1,
  });
  const server = app.listen(config.port, config.host, () => {
    console.log('BenefitBridge API (' + config.dataset + ') at http://' + config.host + ':' + config.port);
  });
  server.once('error', async error => {
    console.error('API could not listen on port ' + config.port + ' (' + error.code + ').');
    await connection.close();
    process.exitCode = 1;
  });

  const shutdown = () => server.close(async () => {
    await connection.close();
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
