import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { readConfig } from './config/env.js';
import { readAuthConfig } from './modules/auth/config.js';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { seedRenderDemo } from './config/render-demo.js';

async function start() {
  const renderDemo = process.argv.includes('--render-demo');
  const config = readConfig(process.env, { demo: process.argv.includes('--demo'), renderDemo });
  const auth = readAuthConfig(renderDemo ? { NODE_ENV: 'production', DEMO_APP_ORIGIN: config.origin } : process.env, config.dataset);
  let webRoot;
  if (renderDemo) {
    const dist = new URL('../../web/dist/', import.meta.url);
    await access(new URL('index.html', dist)).catch(() => { throw new Error('The Render demo requires the built frontend.'); });
    webRoot = fileURLToPath(dist);
  }
  const { connection, models } = await connectDatabase(config);
  if (renderDemo) {
    try {
      const { published, skipped } = await seedRenderDemo(models);
      console.log(`Synthetic catalogue ready (${published} seeded, ${skipped} existing).`);
    } catch (error) {
      await connection.close();
      if (error.message === 'The hosted demo database must contain only synthetic catalogue data.') throw error;
      throw new Error('Could not initialize the hosted synthetic catalogue. Check the demo database and database user.');
    }
  }
  const app = createApp({
    models,
    dataset: config.dataset,
    auth,
    trustLoopbackProxy: config.trustLoopbackProxy,
    renderDemo,
    webRoot,
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
