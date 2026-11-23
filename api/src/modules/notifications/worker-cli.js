import { setTimeout as pause } from 'node:timers/promises';
import { connectDatabase } from '../../config/database.js';
import { readConfig } from '../../config/env.js';
import { processNotificationBatch } from './worker.js';

async function run() {
  const config = readConfig(process.env, { demo: process.argv.includes('--demo') });
  const once = process.argv.includes('--once');
  const { connection, models } = await connectDatabase(config);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    do {
      try {
        const result = await processNotificationBatch(models, config.dataset);
        if (once || result.processed || result.failed) console.log('Notification worker:', result);
        if (once && result.failed) process.exitCode = 1;
      } catch (error) {
        if (once) throw error;
        console.error('Notification worker could not reach MongoDB. Retrying.');
      }
      if (!once && !stopping) await pause(3000);
    } while (!once && !stopping);
  } finally {
    await connection.close();
  }
}

run().catch(() => {
  console.error('The notification worker could not complete its database operation.');
  process.exitCode = 1;
});
