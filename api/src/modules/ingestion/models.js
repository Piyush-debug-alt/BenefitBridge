import { Schema } from 'mongoose';
import { datasets } from '../catalogue/validation.js';

export function createIngestionModels(connection) {
  const source = new Schema({
    _id: { type: String, required: true },
    dataset: { type: String, enum: datasets, required: true, immutable: true },
    name: { type: String, required: true },
    baseUrl: { type: String, required: true },
    accessPermissions: { type: String, required: true },
    retentionPolicy: { type: String, enum: ['reference_only'], required: true },
  }, { collection: 'sources' });

  const sourceRecord = new Schema({
    sourceId: { type: String, ref: 'Source', required: true, immutable: true },
    externalRecordId: { type: String, required: true, immutable: true },
    retrievedAt: { type: Date, required: true, immutable: true },
    contentHash: { type: String, required: true, immutable: true },
    permittedReference: { type: String, required: true, immutable: true },
  }, { collection: 'source_records' });
  sourceRecord.index({ sourceId: 1, externalRecordId: 1, contentHash: 1 }, { unique: true });

  return {
    Source: connection.model('Source', source),
    SourceRecord: connection.model('SourceRecord', sourceRecord),
  };
}
