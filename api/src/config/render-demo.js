import { importFixture } from '../modules/ingestion/import-fixture.js';
import { readFixture } from '../modules/ingestion/file-adapter.js';

const fixturePath = new URL('../../test/fixtures/synthetic/catalogue.json', import.meta.url);

export async function seedRenderDemo(models) {
  const otherDataset = { dataset: { $ne: 'synthetic' } };
  if (await models.Scheme.exists(otherDataset) || await models.Source.exists(otherDataset)) {
    throw new Error('The hosted demo database must contain only synthetic catalogue data.');
  }
  const fixture = await readFixture(fixturePath, 'synthetic');
  return importFixture(models, 'synthetic', fixture);
}
