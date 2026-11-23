import { Schema } from 'mongoose';

export function createExtractionModels(connection) {
  const job = new Schema({
    dataset: String, sourceId: String, externalRecordId: String, inputHash: String,
    provider: String, providerVersion: String, policyVersion: String,
    input: Schema.Types.Mixed, status: {
      type: String, enum: ['queued', 'running', 'ready', 'review_required', 'failed'],
    },
    availableAt: Date, startedAt: Date, finishedAt: Date, attempts: { type: Number, default: 0 },
    lease: String, processingMs: Number, errorCode: String, result: Schema.Types.Mixed,
  }, { collection: 'eligibility_extractions', timestamps: true });
  job.index({ dataset: 1, sourceId: 1, externalRecordId: 1, inputHash: 1,
    provider: 1, providerVersion: 1, policyVersion: 1 }, { unique: true });
  job.index({ dataset: 1, sourceId: 1, provider: 1, providerVersion: 1, status: 1, availableAt: 1 });
  return { EligibilityExtraction: connection.model('EligibilityExtraction', job) };
}
