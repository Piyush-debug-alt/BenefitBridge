import { createHash } from 'node:crypto';
import { parseFixture } from './file-adapter.js';

export async function importFixture(models, dataset, input) {
  const { source, records, retrievedAt } = parseFixture(input, dataset);
  const { Source, SourceRecord, Scheme, SchemeVersion } = models;
  const { id: sourceId, ...sourceFields } = source;
  await Source.updateOne({ _id: sourceId, dataset }, { $setOnInsert: sourceFields }, {
    upsert: true,
    runValidators: true,
  });

  let published = 0;
  let skipped = 0;
  for (const record of records) {
    const { externalRecordId, ...fields } = record;
    const identity = { dataset, sourceId, externalRecordId };
    const recordHash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const scheme = await Scheme.findOneAndUpdate(identity, {
      $setOnInsert: { ...fields, publicationStatus: 'draft', lastSyncedAt: retrievedAt },
    }, { upsert: true, new: true, runValidators: true, timestamps: false }).lean();

    if (scheme.publicationStatus !== 'draft') {
      const current = await SchemeVersion.findById(scheme.currentVersionId).select('recordHash').lean();
      if (scheme.publicationStatus !== 'published' || !current || current.recordHash !== recordHash) {
        throw new Error('A changed or quarantined record requires review: ' + externalRecordId);
      }
      skipped += 1;
      continue;
    }

    const sourceRecord = await SourceRecord.findOneAndUpdate({ sourceId, externalRecordId, contentHash: recordHash }, {
      $setOnInsert: { retrievedAt, permittedReference: fields.sourceRefs[0].url },
    }, { upsert: true, new: true, runValidators: true }).lean();

    const fieldProvenance = Object.fromEntries(Object.keys(fields).map(key => [key, fields.sourceRefs]));
    const version = await SchemeVersion.findOneAndUpdate({ schemeId: scheme._id, versionNo: 1 }, {
      $setOnInsert: { recordHash, sourceRecordId: sourceRecord._id, fields, fieldProvenance, publishedAt: new Date() },
    }, { upsert: true, new: true, runValidators: true }).lean();

    if (version.recordHash !== recordHash) {
      throw new Error('Retry the initial import with its original record: ' + externalRecordId);
    }

    const result = await Scheme.updateOne({ _id: scheme._id, publicationStatus: 'draft' }, {
      $set: { ...fields, lastSyncedAt: retrievedAt, currentVersionId: version._id, publicationStatus: 'published' },
    }, { runValidators: true });
    if (result.modifiedCount === 1) published += 1;
    else skipped += 1;
  }
  return { published, skipped };
}
