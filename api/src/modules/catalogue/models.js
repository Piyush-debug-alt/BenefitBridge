import { Schema } from 'mongoose';
import { datasets, governmentLevels, lifecycleStatuses, verificationStatuses } from './validation.js';

const sourceReference = new Schema({
  label: { type: String, required: true },
  url: { type: String, required: true },
}, { _id: false });

export function createCatalogueModels(connection) {
  const scheme = new Schema({
    dataset: { type: String, enum: datasets, required: true, immutable: true },
    sourceId: { type: String, required: true, immutable: true },
    externalRecordId: { type: String, required: true, immutable: true },
    canonicalName: { type: String, required: true },
    description: { type: String, required: true },
    keywords: [String],
    goalTags: [String],
    categoryIds: [String],
    benefitTypes: [String],
    governmentLevel: { type: String, enum: governmentLevels, required: true },
    issuer: { type: String, required: true },
    nationwide: { type: Boolean, required: true },
    stateCodes: [String],
    publicationStatus: { type: String, enum: ['draft', 'published', 'quarantined'], required: true },
    lifecycleStatus: { type: String, enum: lifecycleStatuses, required: true },
    verificationStatus: { type: String, enum: verificationStatuses, required: true },
    currentVersionId: { type: Schema.Types.ObjectId, ref: 'SchemeVersion' },
    sourceRefs: [sourceReference],
    applicationUrl: String,
    applicationDeadline: String,
    relationships: { type: [{
      _id: false, kind: String, targetId: Schema.Types.ObjectId, evidenceUrl: String,
    }], default: undefined },
    sourceUpdatedAt: Date,
    reviewCaseId: Schema.Types.ObjectId,
    disputedFields: { type: [String], default: undefined },
    benefits: [String],
    eligibilityText: String,
    requiredDocuments: [String],
    lastVerifiedAt: Date,
    lastSyncedAt: { type: Date, required: true },
  }, { collection: 'schemes', timestamps: true });

  scheme.index({ dataset: 1, sourceId: 1, externalRecordId: 1 }, { unique: true });
  scheme.index({ canonicalName: 'text', description: 'text', keywords: 'text', goalTags: 'text' }, {
    weights: { canonicalName: 8, keywords: 4, goalTags: 4, description: 1 },
  });
  scheme.index({ dataset: 1, publicationStatus: 1, categoryIds: 1 });
  scheme.index({ dataset: 1, publicationStatus: 1, stateCodes: 1 });
  scheme.index({ dataset: 1, publicationStatus: 1, governmentLevel: 1, nationwide: 1 });
  scheme.index({ dataset: 1, publicationStatus: 1, canonicalName: 1, _id: 1 });
  scheme.index({ dataset: 1, 'relationships.targetId': 1, publicationStatus: 1 });

  const version = new Schema({
    schemeId: { type: Schema.Types.ObjectId, ref: 'Scheme', required: true, immutable: true },
    versionNo: { type: Number, required: true, min: 1, immutable: true },
    recordHash: { type: String, required: true, immutable: true },
    sourceRecordId: { type: Schema.Types.ObjectId, ref: 'SourceRecord', required: true, immutable: true },
    publishedAt: { type: Date, required: true, immutable: true },
    fields: { type: Schema.Types.Mixed, required: true, immutable: true },
    fieldProvenance: { type: Map, of: [sourceReference], required: true, immutable: true },
    reviewDecisionId: { type: Schema.Types.ObjectId, immutable: true },
  }, { collection: 'scheme_versions' });
  version.index({ schemeId: 1, versionNo: 1 }, { unique: true });
  version.index({ reviewDecisionId: 1 }, { unique: true, sparse: true });

  return {
    Scheme: connection.model('Scheme', scheme),
    SchemeVersion: connection.model('SchemeVersion', version),
  };
}
