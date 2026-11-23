import { readConfig } from '../../config/env.js';
import { connectDatabase } from '../../config/database.js';
import { readFixture } from './file-adapter.js';
import { importFixture } from './import-fixture.js';

const demoFixture = new URL('../../../test/fixtures/synthetic/catalogue.json', import.meta.url);

async function main() {
  const [arg, ...extras] = process.argv.slice(2);
  if (!arg || extras.length) {
    throw new Error('Supply --demo or the path to an authorized fixture JSON file.');
  }

  const demo = arg === '--demo';
  const config = readConfig(process.env, { demo });
  const fixture = await readFixture(demo ? demoFixture : arg, config.dataset);
  if (demo) console.log('Synthetic fixture import into the dedicated BenefitBridge demo database.');

  const { connection, models } = await connectDatabase(config);
  try {
    const { published, skipped } = await importFixture(models, config.dataset, fixture);
    console.log('Published ' + published + ' schemes; skipped ' + skipped + ' unchanged schemes.');
  } finally {
    await connection.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
