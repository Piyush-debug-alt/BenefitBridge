import { queuePublication } from '../notifications/events.js';
import { digest, FeedError } from './adapters.js';
import { attachEligibility } from './import-fixture.js';
import { isMaterial } from './staging.js';
import { comparableRule } from '../extraction/evidence.js';
import { retainApprovedRule } from '../extraction/worker.js';

async function verifiedRelationships(Scheme, dataset, scheme, relationships) {
  const links = [];
  for (const relationship of relationships) {
    const target = await Scheme.findOne({
      dataset, sourceId: relationship.sourceId, externalRecordId: relationship.externalRecordId,
      publicationStatus: 'published', verificationStatus: 'verified',
    }).select('governmentLevel').lean();
    if (!target || String(target._id) === String(scheme._id) ||
        (relationship.kind === 'variant_of' && target.governmentLevel !== 'central')) {
      throw new FeedError('RELATIONSHIP_TARGET_REQUIRES_VERIFIED_SCHEME');
    }
    links.push({ kind: relationship.kind, targetId: target._id, evidenceUrl: relationship.evidenceUrl });
  }
  return links;
}

export async function decideReview(models, review, action, actorId, reason, { syntheticBenchmark = false, extractionApproval } = {}) {
  const { ReviewCase } = models;
  const status = { approve: 'approved', reject: 'rejected', defer: 'deferred' }[action];
  if (action === 'approve' && !review.normalization) throw new FeedError('REVIEW_NEEDS_CORRECTED_SOURCE');
  if (action === 'approve' && !syntheticBenchmark && !await models.SyncJob.exists({
    _id: review.lastObservedJobId ?? review.jobId, status: 'succeeded',
  })) throw new FeedError('REVIEW_REQUIRES_COMPLETED_SYNC');
  const now = new Date();
  return ReviewCase.findOneAndUpdate({ _id: review._id, status: { $in: ['pending', 'deferred'] },
    ...(extractionApproval && { extractionId: extractionApproval.extractionId, 'extractionDecision.status': { $exists: false } }),
  }, {
    $set: { status, decidedAt: now, decidedBy: actorId, reason,
      ...(extractionApproval && { extractionDecision: extractionApproval }),
    },
    $push: { decisionHistory: { actorId, action: extractionApproval ? 'approve_extraction' : action, reason, at: now } },
    $unset: { publicationError: 1 },
  }, { new: true }).lean();
}

export async function processReviewedChanges(models, dataset, sourceId, { heartbeat, limit = 40 } = {}) {
  const { ReviewCase, Scheme, SchemeVersion } = models;
  const reviews = await ReviewCase.find({
    dataset, sourceId, status: { $in: ['approved', 'rejected'] }, resolvedAt: null,
  }).sort({ decidedAt: 1, _id: 1 }).limit(limit).lean();
  for (const review of reviews) {
    await heartbeat?.();
    if (review.status === 'rejected') {
      if (review.schemeId && review.baseVersionId) {
        const old = await SchemeVersion.findById(review.baseVersionId).select('fields.verificationStatus').lean();
        if (old) await Scheme.updateOne({ _id: review.schemeId, reviewCaseId: review._id, currentVersionId: review.baseVersionId }, {
          $set: { verificationStatus: old.fields.verificationStatus },
          $unset: { reviewCaseId: 1, disputedFields: 1 },
        });
      }
      await ReviewCase.updateOne({ _id: review._id }, { $set: { resolvedAt: new Date() } });
      continue;
    }
    try {
      await publishReview(models, review);
    } catch (error) {
      if (!(error instanceof FeedError)) throw error;
      await ReviewCase.updateOne({ _id: review._id, status: 'approved' }, {
        $set: { status: 'deferred', publicationError: error.code },
      });
    }
  }
  return reviews.length;
}

export async function publishReview(models, review) {
  const { Scheme, SchemeVersion, SourceMember, SchemeRuleVersion, ChangeEvent, ReviewCase } = models;
  const { dataset, sourceId, externalRecordId } = review;
  const identity = { dataset, sourceId, externalRecordId };
  const { record, relationships, closureEvidence } = review.normalization;
  const { externalRecordId: _id, eligibility, ...data } = record;
  const verifiedAt = review.decidedAt ?? new Date();
  const fields = {
    ...data, verificationStatus: 'verified', lastVerifiedAt: verifiedAt.toISOString(),
    ...(relationships.length && { relationships }), ...(closureEvidence && { closureEvidence }),
  };
  let scheme = await Scheme.findOne(identity).lean();
  let version = await SchemeVersion.findOne({ reviewDecisionId: review._id }).lean();
  if (version && String(scheme?.currentVersionId) === String(version._id)) {
    await ReviewCase.updateOne({ _id: review._id }, { $set: {
      status: 'published', resolvedAt: new Date(), resolvedByVersion: version._id,
    } });
    return;
  }
  const member = await SourceMember.findOne({ sourceId, externalRecordId }).lean();
  if (!member || member.missing || member.updatedAt > review.sourceUpdatedAt ||
      String(scheme?.currentVersionId ?? '') !== String(review.baseVersionId ?? '') ||
      (scheme?.reviewCaseId && String(scheme.reviewCaseId) !== String(review._id))) {
    await ReviewCase.updateOne({ _id: review._id }, { $set: {
      status: 'superseded', resolvedAt: new Date(), publicationError: 'NEWER_EVIDENCE_OR_VERSION',
    } });
    return;
  }
  if (!scheme) scheme = await Scheme.findOneAndUpdate(identity, {
    $setOnInsert: { ...data, publicationStatus: 'draft', lastSyncedAt: verifiedAt },
  }, { upsert: true, new: true, runValidators: true }).lean();

  const links = await verifiedRelationships(Scheme, dataset, scheme, relationships);
  const recordHash = digest(fields);
  if (!version) {
    // An interrupted older decision may have reserved a version without switching the public pointer.
    const latest = await SchemeVersion.findOne({ schemeId: scheme._id }).sort({ versionNo: -1 }).select('versionNo').lean();
    version = await SchemeVersion.findOneAndUpdate({
      schemeId: scheme._id, versionNo: (latest?.versionNo ?? 0) + 1,
    }, { $setOnInsert: {
      reviewDecisionId: review._id, recordHash, sourceRecordId: review.sourceRecordId,
      fields, fieldProvenance: Object.fromEntries(Object.keys(fields).map(key => [key, data.sourceRefs])),
      publishedAt: verifiedAt,
    } }, { upsert: true, new: true, runValidators: true }).lean();
  }
  if (String(version.reviewDecisionId) !== String(review._id)) throw new FeedError('VERSION_ALREADY_RESERVED');

  const previousRule = review.baseVersionId && await SchemeRuleVersion.findOne({
    schemeId: scheme._id, schemeVersionId: review.baseVersionId,
  }).select('rule extractionProvenance').lean();
  const approved = review.extractionDecision?.status === 'approved' ? review.extractionDecision : null;
  const previousFields = !eligibility && !approved && previousRule?.extractionProvenance &&
    (await SchemeVersion.findById(review.baseVersionId).select('fields').lean())?.fields;
  const retain = retainApprovedRule(previousFields, previousRule, record);
  const rule = approved?.rule ?? eligibility ?? (retain ? previousRule.rule : undefined);
  const { rule: _approvedRule, ...provenance } = approved ?? {};
  await attachEligibility(SchemeRuleVersion, scheme._id, version._id, rule, externalRecordId,
    approved ? provenance : retain ? previousRule.extractionProvenance : undefined);
  if (!review.baseVersionId || isMaterial(review.changedFields.filter(field => field !== 'eligibility')) ||
      comparableRule(rule) !== comparableRule(previousRule?.rule)) {
    await queuePublication(ChangeEvent, dataset, scheme._id, version, review.baseVersionId ? 'bookmark_update' : 'profile_match');
  }

  const update = await Scheme.updateOne({
    _id: scheme._id, currentVersionId: review.baseVersionId ?? null,
    $or: [{ reviewCaseId: review._id }, { reviewCaseId: { $exists: false } }],
  }, {
    $set: {
      ...data, relationships: links, sourceUpdatedAt: review.sourceUpdatedAt,
      lastVerifiedAt: verifiedAt, lastSyncedAt: new Date(), verificationStatus: 'verified',
      publicationStatus: 'published', currentVersionId: version._id,
    },
    $unset: {
      reviewCaseId: 1, disputedFields: 1,
      ...Object.fromEntries(['applicationUrl', 'applicationDeadline', 'eligibilityText']
        .filter(key => data[key] === undefined).map(key => [key, 1])),
    },
  }, { runValidators: true });
  if (!update.matchedCount) throw new FeedError('PUBLICATION_BASE_CHANGED');

  await ReviewCase.updateOne({ _id: review._id }, { $set: {
    status: 'published', resolvedAt: new Date(), resolvedByVersion: version._id,
  } });
}
