import { connectDatabase } from '../../config/database.js';
import { readConfig } from '../../config/env.js';
import { publishDemoNew, publishDemoUpdate } from './demo-publication.js';

async function run() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['new', 'update'].includes(args[0])) {
    throw new Error('Pass new or update to publish a synthetic notification fixture.');
  }
  const config = readConfig(process.env, { demo: true });
  const { models, connection } = await connectDatabase(config);
  try {
    const publish = args[0] === 'new' ? publishDemoNew : publishDemoUpdate;
    console.log('Synthetic publication:', await publish(models));
  } finally {
    await connection.close();
  }
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
