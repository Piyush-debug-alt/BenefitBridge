import { Schema } from 'mongoose';
import { eligibilitySchema } from './criteria.js';

export function createMatchingModels(connection) {
  const version = new Schema({
    schemeId: { type: Schema.Types.ObjectId, ref: 'Scheme', required: true, immutable: true },
    schemeVersionId: { type: Schema.Types.ObjectId, ref: 'SchemeVersion', required: true, immutable: true },
    extractionProvenance: { type: Schema.Types.Mixed, immutable: true },
    rule: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: value => eligibilitySchema.safeParse(value).success,
    },
  }, { collection: 'scheme_rule_versions' });

  version.index({ schemeVersionId: 1, schemeId: 1 }, { unique: true });
  return { SchemeRuleVersion: connection.model('SchemeRuleVersion', version) };
}
