import { Schema } from 'mongoose';

export function createSyncModels(connection) {
  const objectId = Schema.Types.ObjectId;
  const state = new Schema({
    _id: String, dataset: String, checkpoint: String, lastSnapshotAt: Date, lastSuccessAt: Date,
    lastFailureAt: Date, leaseUntil: Date, lease: String, capabilities: Schema.Types.Mixed,
  }, { collection: 'sync_sources' });

  const job = new Schema({
    dataset: String, sourceId: String, mode: { type: String, enum: ['snapshot', 'incremental'] },
    status: { type: String, enum: ['queued', 'running', 'succeeded', 'failed'] },
    attempts: { type: Number, default: 0 }, availableAt: Date, leaseUntil: Date,
    lease: String, checkpointBefore: String, checkpointAfter: String, snapshotKey: String,
    startedAt: Date, finishedAt: Date, stats: Schema.Types.Mixed, errorCode: String,
  }, { collection: 'sync_jobs', timestamps: true });
  job.index({ dataset: 1, sourceId: 1, status: 1, availableAt: 1 });
  job.index({ dataset: 1, createdAt: -1 });

  const member = new Schema({
    sourceId: String, externalRecordId: String, updatedAt: Date, fingerprint: String,
    seenRun: objectId, missing: Boolean, confirmed: Boolean, lastSeenAt: Date,
  }, { collection: 'source_membership' });
  member.index({ sourceId: 1, externalRecordId: 1 }, { unique: true });
  member.index({ sourceId: 1, confirmed: 1, missing: 1 });

  const review = new Schema({
    dataset: String, sourceId: String, externalRecordId: String,
    fingerprint: String, kind: { type: String, enum: ['candidate', 'conflict', 'invalid', 'missing'] },
    status: { type: String, enum: ['pending', 'approved', 'published', 'rejected', 'deferred', 'superseded'] },
    sourceRecordId: objectId, jobId: objectId, lastObservedJobId: objectId, baseVersionId: objectId, schemeId: objectId,
    normalization: Schema.Types.Mixed, changedFields: [String], errorCode: String, publicationError: String,
    extractionId: objectId, extractionDecision: Schema.Types.Mixed,
    sourceUpdatedAt: Date, decidedAt: Date, decidedBy: objectId, reason: String,
    resolvedAt: Date, resolvedByVersion: objectId,
    decisionHistory: { type: [{ _id: false, actorId: objectId, action: String, reason: String, at: Date }], default: undefined },
  }, { collection: 'review_cases', timestamps: true });
  review.index({ sourceId: 1, externalRecordId: 1, fingerprint: 1 }, { unique: true });
  review.index({ dataset: 1, status: 1, createdAt: -1 });
  review.index({ dataset: 1, sourceId: 1, status: 1, decidedAt: 1 });

  return {
    SyncSource: connection.model('SyncSource', state), SyncJob: connection.model('SyncJob', job),
    SourceMember: connection.model('SourceMember', member), ReviewCase: connection.model('ReviewCase', review),
  };
}
