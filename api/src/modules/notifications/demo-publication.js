import { createHash } from 'node:crypto';
import { attachEligibility, importFixture } from '../ingestion/import-fixture.js';
import { readFixture } from '../ingestion/file-adapter.js';
import { queuePublication } from './events.js';

const seedFile = new URL('../../../test/fixtures/synthetic/catalogue.json', import.meta.url);
const targetId = 'learning-grant';
const dataset = 'synthetic';

export async function publishDemoNew(models) {
  const fixture = await readFixture(seedFile, dataset);
  const example = fixture.records.find(record => record.externalRecordId === targetId);
  const url = 'https://benefitbridge.example.invalid/fixtures/demo-campus-materials';
  const record = {
    ...example,
    externalRecordId: 'demo-campus-materials',
    canonicalName: 'Demo Campus Materials Award',
    description: 'A fictional education award used to demonstrate alerts for newly published schemes.',
    sourceRefs: [{ label: 'Synthetic campus award source', url }],
    eligibility: { ...example.eligibility, evidenceUrl: url },
  };
  return importFixture(models, dataset, { ...fixture, records: [record] });
}

export async function publishDemoUpdate(models) {
  const { Scheme, SchemeVersion, SourceRecord, SchemeRuleVersion, ChangeEvent } = models;
  const fixture = await readFixture(seedFile, dataset);
  const live = { dataset, sourceId: fixture.source.id, externalRecordId: targetId, publicationStatus: 'published', verificationStatus: 'verified' };
  const scheme = await Scheme.findOne(live).lean();
  if (!scheme) throw new Error('Seed the synthetic demo before publishing its update.');
  const original = await SchemeVersion.findOne({ schemeId: scheme._id, versionNo: 1 }).lean();
  if (!original) throw new Error('The synthetic scheme has no initial version.');

  // This reviewed fixture changes one benefit. It keeps the verified eligibility and evidence from version one.
  const benefits = [...original.fields.benefits, 'The synthetic award now also covers practice materials.'];
  const fields = { ...original.fields, benefits };
  const recordHash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  const existing = await SchemeVersion.findById(scheme.currentVersionId).lean();
  if (existing?.recordHash === recordHash) return { published: 0, skipped: 1 };
  if (String(scheme.currentVersionId) !== String(original._id)) {
    throw new Error('The synthetic scheme already has a different current version.');
  }

  const now = new Date();
  const sourceRecord = await SourceRecord.findOneAndUpdate({
    sourceId: fixture.source.id, externalRecordId: targetId, contentHash: recordHash,
  }, { $setOnInsert: { retrievedAt: now, permittedReference: fields.sourceRefs[0].url } }, {
    upsert: true, new: true, runValidators: true,
  }).lean();
  const fieldProvenance = Object.fromEntries(Object.keys(fields).map(key => [key, fields.sourceRefs]));
  const version = await SchemeVersion.findOneAndUpdate({ schemeId: scheme._id, versionNo: 2 }, {
    $setOnInsert: { fields, recordHash, sourceRecordId: sourceRecord._id, fieldProvenance, publishedAt: now },
  }, { upsert: true, new: true, runValidators: true }).lean();
  if (version.recordHash !== recordHash) throw new Error('Version two already contains a different update.');

  const initialRule = await SchemeRuleVersion.findOne({ schemeId: scheme._id, schemeVersionId: original._id }).lean();
  await attachEligibility(SchemeRuleVersion, scheme._id, version._id, initialRule?.rule, targetId);
  await queuePublication(ChangeEvent, dataset, scheme._id, version);
  const result = await Scheme.updateOne({ ...live, _id: scheme._id, currentVersionId: original._id }, {
    $set: { currentVersionId: version._id, benefits, lastSyncedAt: now, lastVerifiedAt: now },
  }, { runValidators: true });
  return { published: result.modifiedCount, skipped: 1 - result.modifiedCount };
}
