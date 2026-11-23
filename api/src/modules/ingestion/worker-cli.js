import { setTimeout as pause } from 'node:timers/promises';
import { connectDatabase } from '../../config/database.js';
import { readConfig } from '../../config/env.js';
import { emailSchema } from '../auth/password.js';
import { digest, FeedError, fileAdapter, httpAdapter } from './adapters.js';
import { enqueueSync, scheduleSource, workSource } from './sync.js';
import { configuredExtractionProvider } from '../extraction/providers.js';
import { processExtractionBatch } from '../extraction/worker.js';

async function configuredAdapter(dataset, get) {
  const path = get('INGEST_SOURCE_FILE') || (dataset === 'synthetic' && !get('INGEST_ENDPOINT')
    ? new URL('../../../test/fixtures/synthetic/sync-snapshot.json', import.meta.url) : null);
  if (path) {
    let latest = await fileAdapter(path, dataset);
    const metadata = latest.metadata;
    return { metadata, incremental: false, async page(args) {
      if (!args.cursor) {
        try {
          latest = await fileAdapter(path, dataset);
        } catch {
          throw new FeedError('SOURCE_FILE_UNREADABLE', true);
        }
        if (digest(latest.metadata) !== digest(metadata)) throw new FeedError('SOURCE_METADATA_CHANGED');
      }
      return latest.page(args);
    } };
  }
  if (!get('INGEST_ENDPOINT') || !get('INGEST_SOURCE_METADATA')) throw new FeedError('CONFIGURE_A_PERMITTED_SOURCE');
  return httpAdapter({
    metadata: JSON.parse(get('INGEST_SOURCE_METADATA')), endpoint: get('INGEST_ENDPOINT'),
    authorization: get('INGEST_AUTHORIZATION'), incremental: get('INGEST_INCREMENTAL') === 'true',
  });
}

function interval(value, fallback, minimum) {
  if (value === undefined) return fallback;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < minimum) throw new FeedError('INVALID_SYNC_INTERVAL');
  return milliseconds;
}

async function run() {
  const args = process.argv.slice(2).filter(arg => arg !== '--demo');
  const demo = process.argv.includes('--demo');
  const config = readConfig(process.env, { demo });
  const get = key => process.env[(demo ? 'DEMO_' : '') + key];
  const [command = 'watch', value] = args;
  const { connection, models } = await connectDatabase(config);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (command === 'grant-admin' || command === 'revoke-admin') {
      const email = emailSchema.safeParse(value);
      if (!email.success) throw new FeedError('EMAIL_REQUIRED');
      const result = await models.User.updateOne({ email: email.data }, { $set: { isAdministrator: command === 'grant-admin' } });
      if (!result.matchedCount) throw new FeedError('ACCOUNT_NOT_FOUND');
      console.log('Administrator permission updated in the selected database.');
      return;
    }

    if (!['watch', 'snapshot', 'incremental', 'once'].includes(command)) throw new FeedError('UNKNOWN_COMMAND');
    const adapter = await configuredAdapter(config.dataset, get);
    const extractionProvider = configuredExtractionProvider(get('AI_EXTRACTION_PROVIDER'));
    const poll = interval(get('INGEST_POLL_MS'), 15 * 60_000, 60_000);
    const reconcile = interval(get('INGEST_RECONCILE_MS'), 24 * 60 * 60_000, 60_000);
    if (command === 'snapshot' || command === 'incremental') {
      const queued = await enqueueSync(models, config.dataset, adapter.metadata.id, command);
      console.log('Queued synchronization job ' + queued.id);
    }
    do {
      try {
        if (command === 'watch') await scheduleSource(models, config.dataset, adapter, reconcile, poll);
        const result = await workSource(models, config.dataset, adapter, { extractionProvider });
        const extracted = await processExtractionBatch(models, config.dataset, adapter.metadata.id, extractionProvider);
        if (command !== 'watch' || result.jobId || result.reviewed) console.log(result);
        if (extracted) console.log('Processed eligibility proposals: ' + extracted);
        if (command !== 'watch' && ['failed', 'queued', 'interrupted'].includes(result.status)) process.exitCode = 1;
      } catch (error) {
        if (command !== 'watch') throw error;
        console.error('Synchronization worker will retry its database operation.');
      }
      if (command === 'watch' && !stopping) await pause(3000);
    } while (command === 'watch' && !stopping);
  } finally {
    await connection.close();
  }
}

run().catch(error => {
  console.error(error instanceof FeedError ? error.code : 'Synchronization configuration or database operation failed.');
  process.exitCode = 1;
});
