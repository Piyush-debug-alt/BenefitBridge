import { z } from 'zod';
import { digest } from './adapters.js';
import { opaqueId, record, timestamp, webUrl } from './file-adapter.js';
import { retainApprovedRule } from '../extraction/worker.js';

const relation = z.strictObject({
  kind: z.enum(['variant_of', 'supplement_to', 'related_to']),
  sourceId: opaqueId, externalRecordId: opaqueId, evidenceUrl: webUrl,
});
const envelope = z.strictObject({
  record, updatedAt: timestamp, retrievedAt: timestamp.optional(), closureEvidence: webUrl.optional(),
  fieldProvenance: z.partialRecord(record.keyof(), z.array(webUrl).min(1).max(15)).optional(),
  relationships: z.array(relation).max(20).default([]),
  authenticity: z.enum(['supported', 'uncertain']).default('supported'),
});
const material = ['benefits', 'eligibility', 'eligibilityText', 'requiredDocuments', 'applicationUrl',
  'applicationDeadline', 'lifecycleStatus'];

export function changedFields(previous, previousRule, next) {
  const fields = new Set([...Object.keys(previous ?? {}), ...Object.keys(next)]);
  fields.delete('lastVerifiedAt');
  fields.delete('verificationStatus');
  fields.delete('eligibility');
  const changed = [...fields].filter(key => digest(previous?.[key]) !== digest(next[key]));
  if (digest(previousRule ?? null) !== digest(next.eligibility ?? null)) changed.push('eligibility');
  return changed;
}

export function isMaterial(fields) {
  return fields.some(field => material.includes(field));
}

function normalize(input, source, dataset) {
  const result = envelope.safeParse(input);
  if (!result.success) return { errorCode: 'INVALID_RECORD' };
  const candidate = result.data;
  const { record, relationships, closureEvidence, updatedAt, retrievedAt, fieldProvenance } = candidate;
  const refsByUrl = new Map(record.sourceRefs.map(ref => [ref.url, ref]));
  const publishedRefs = [...refsByUrl.keys()];
  const evidence = [...publishedRefs, ...relationships.map(item => item.evidenceUrl), closureEvidence, record.applicationUrl].filter(Boolean);
  const targetCount = relationships.filter(item => item.kind === 'variant_of').length;
  const distinctRelationships = new Set(relationships.map(item => [item.kind, item.sourceId, item.externalRecordId].join('/')));
  if (evidence.some(value => {
    const url = new URL(value);
    return !source.evidenceOrigins.includes(url.origin) || url.hostname.endsWith('.invalid') !== (dataset === 'synthetic');
  }) || relationships.some(item => !publishedRefs.includes(item.evidenceUrl)) ||
      distinctRelationships.size !== relationships.length || targetCount > 1 ||
      (targetCount && record.governmentLevel !== 'state')) return { errorCode: 'UNSUPPORTED_PROVENANCE' };
  if (closureEvidence && !publishedRefs.includes(closureEvidence)) return { errorCode: 'UNSUPPORTED_CLOSURE_EVIDENCE' };
  if (record.lifecycleStatus === 'closed' && !closureEvidence) return { errorCode: 'MISSING_CLOSURE_EVIDENCE' };
  if (fieldProvenance) {
    const fields = Object.keys(fieldProvenance);
    if (!fields.length || fields.some(field => !Object.hasOwn(record, field) ||
      fieldProvenance[field].some(url => !refsByUrl.has(url)))) return { errorCode: 'UNSUPPORTED_PROVENANCE' };
    candidate.fieldProvenance = Object.fromEntries(fields.sort().map(field => [
      field, fieldProvenance[field].map(url => refsByUrl.get(url)),
    ]));
  }
  if (record.lastVerifiedAt && Date.parse(record.lastVerifiedAt) > Date.now() + 60_000 ||
      retrievedAt && Date.parse(retrievedAt) > Date.now() + 60_000 ||
      Date.parse(updatedAt) > Date.now() + 60_000) return { errorCode: 'FUTURE_SOURCE_TIMESTAMP' };
  return { candidate };
}

async function queueReview(ReviewCase, identity, fingerprint, fields) {
  return ReviewCase.findOneAndUpdate({ ...identity, fingerprint }, {
    $set: { lastObservedJobId: fields.jobId },
    $setOnInsert: fields,
  }, { upsert: true, new: true, timestamps: true }).lean();
}

export async function stageRecord(models, job, source, raw) {
  const { Scheme, SchemeVersion, SchemeRuleVersion, ReviewCase, SourceRecord, SourceMember } = models;
  const parsedId = opaqueId.safeParse(raw?.record?.externalRecordId);
  const id = parsedId.success ? parsedId.data : 'invalid-' + digest(raw).slice(0, 32);
  const identity = { sourceId: source.id, externalRecordId: id };
  const { candidate, errorCode } = normalize(raw, source, job.dataset);
  const scheme = parsedId.success && await Scheme.findOne({ ...identity, dataset: job.dataset }).lean();
  const member = parsedId.success && await SourceMember.findOne(identity).lean();
  const common = {
    dataset: job.dataset, jobId: job._id, schemeId: scheme?._id, baseVersionId: scheme?.currentVersionId,
    status: 'pending',
  };
  if (errorCode) {
    await queueReview(ReviewCase, identity, digest([errorCode, raw]), { ...common, kind: 'invalid', errorCode });
    return { kind: 'invalid' };
  }

  const { updatedAt, retrievedAt, record, authenticity, closureEvidence, relationships, fieldProvenance } = candidate;
  const fingerprint = digest([record, authenticity, closureEvidence, relationships, ...(fieldProvenance ? [fieldProvenance] : [])]);
  const providerTime = new Date(updatedAt);
  const seen = { lastSeenAt: new Date(), ...(job.mode === 'snapshot' && { seenRun: job._id }), confirmed: true, missing: false };
  const olderThan = member?.updatedAt ?? scheme?.sourceUpdatedAt ?? scheme?.lastVerifiedAt;
  if (olderThan && providerTime < olderThan) {
    await SourceMember.updateOne(identity, { $set: seen }, { upsert: true });
    return { kind: 'outdated' };
  }
  const sameTimeConflict = member?.updatedAt?.getTime() === providerTime.getTime() && member.fingerprint !== fingerprint;
  const previous = scheme?.currentVersionId && await SchemeVersion.findById(scheme.currentVersionId)
    .select('fields fieldProvenance').lean();
  const previousRule = scheme?.currentVersionId && await SchemeRuleVersion.findOne({
    schemeId: scheme._id, schemeVersionId: scheme.currentVersionId,
  }).select('rule extractionProvenance').lean();
  const { externalRecordId, eligibility, ...fields } = record;
  const observedRule = eligibility ?? (retainApprovedRule(previous?.fields, previousRule, record) ? previousRule.rule : undefined);
  const changed = changedFields(previous?.fields, previousRule?.rule, {
    ...fields, ...(relationships.length && { relationships }), ...(observedRule && { eligibility: observedRule }),
    ...(closureEvidence && { closureEvidence }),
  });
  if (fieldProvenance && digest(fieldProvenance) !== digest(previous?.fieldProvenance) && !changed.includes('sourceRefs')) {
    changed.push('sourceRefs');
  }
  const needsReview = changed.length || !scheme?.currentVersionId || sameTimeConflict || authenticity === 'uncertain' ||
    record.verificationStatus !== 'verified';
  let review;
  if (needsReview) {
    const contentHash = digest([updatedAt, fingerprint]);
    const permitOriginal = source.retentionPolicy === 'permitted_original';
    const evidence = await SourceRecord.findOneAndUpdate({ ...identity, contentHash }, {
      $setOnInsert: {
        retrievedAt: retrievedAt ? new Date(retrievedAt) : new Date(),
        providerUpdatedAt: providerTime, permittedReference: record.sourceRefs[0].url,
        ...(permitOriginal && Buffer.byteLength(JSON.stringify(raw)) <= 256_000 && { permittedOriginal: raw }),
      },
    }, { upsert: true, new: true }).select('_id').lean();
    const conflict = sameTimeConflict || authenticity === 'uncertain' || record.verificationStatus !== 'verified';
    review = await queueReview(ReviewCase, identity, digest([contentHash, common.baseVersionId ?? null]), {
      ...common, kind: conflict ? 'conflict' : 'candidate', sourceRecordId: evidence._id, sourceUpdatedAt: providerTime,
      normalization: candidate, changedFields: changed,
      ...(sameTimeConflict && { errorCode: 'CONFLICTING_SOURCE_TIMESTAMP' }),
    });
    if (scheme?.publicationStatus === 'published' && ['pending', 'deferred', 'approved'].includes(review.status)) {
      await Scheme.updateOne({ _id: scheme._id, currentVersionId: common.baseVersionId }, {
        $set: { reviewCaseId: review._id, disputedFields: changed.length ? changed : ['source evidence'],
          verificationStatus: conflict ? 'disputed' : 'under_review' },
      });
    }
  } else if (scheme?.reviewCaseId) {
    // The newer verified evidence confirms the currently published version.
    await ReviewCase.updateOne({ _id: scheme.reviewCaseId, status: { $in: ['pending', 'deferred', 'approved'] } }, {
      $set: { status: 'superseded', resolvedAt: new Date() },
    });
    await Scheme.updateOne({ _id: scheme._id, currentVersionId: scheme.currentVersionId, reviewCaseId: scheme.reviewCaseId }, {
      $set: { verificationStatus: previous.fields.verificationStatus }, $unset: { reviewCaseId: 1, disputedFields: 1 },
    });
  }
  await SourceMember.updateOne(identity, { $set: {
    ...seen, ...(!sameTimeConflict && { updatedAt: providerTime, fingerprint }),
  } }, { upsert: true });
  return { kind: review ? (review.kind === 'conflict' ? 'conflict' : 'staged') : 'unchanged', review };
}

export async function reconcileMissing(models, job, heartbeat = async () => {}) {
  let missing = 0;
  let checked = 0;
  const { Scheme, ReviewCase, SourceMember } = models;
  // Adopt pre-M5 published identities before the first complete snapshot.
  let batch = [];
  async function adopt() {
    if (!batch.length) return;
    await heartbeat();
    await SourceMember.bulkWrite(batch, { ordered: false });
    batch = [];
  }
  for await (const scheme of Scheme.find({ dataset: job.dataset, sourceId: job.sourceId, publicationStatus: 'published' })
    .select('externalRecordId').lean().cursor()) {
    batch.push({ updateOne: {
      filter: { sourceId: job.sourceId, externalRecordId: scheme.externalRecordId },
      update: { $setOnInsert: { confirmed: true } },
      upsert: true,
    } });
    if (batch.length === 500) await adopt();
  }
  await adopt();
  for await (const member of SourceMember.find({ sourceId: job.sourceId, confirmed: true,
    seenRun: { $ne: job._id }, missing: { $ne: true } }).lean().cursor()) {
    if (++checked % 500 === 0) await heartbeat();
    const identity = { sourceId: job.sourceId, externalRecordId: member.externalRecordId };
    const scheme = await Scheme.findOne({ ...identity, dataset: job.dataset, publicationStatus: 'published' }).lean();
    if (scheme) {
      const review = await queueReview(ReviewCase, identity, digest(['missing', job._id]), {
        dataset: job.dataset, jobId: job._id, kind: 'missing', status: 'pending',
        schemeId: scheme._id, baseVersionId: scheme.currentVersionId, changedFields: ['source availability'],
      });
      await Scheme.updateOne({ _id: scheme._id, currentVersionId: scheme.currentVersionId,
        reviewCaseId: { $exists: false } }, {
        $set: { reviewCaseId: review._id, disputedFields: ['source availability'], verificationStatus: 'under_review' },
      });
    }
    await SourceMember.updateOne({ _id: member._id }, { $set: { missing: true } });
    missing++;
  }
  return missing;
}
