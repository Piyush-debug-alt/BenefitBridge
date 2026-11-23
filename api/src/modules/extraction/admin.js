import { z } from 'zod';
import { jsonBody, safeInput } from '../auth/security.js';
import { HttpError } from '../../middleware/http.js';
import { digest, FeedError } from '../ingestion/adapters.js';
import { decideReview } from '../ingestion/publication.js';
import { comparableRule, validateProposal } from './evidence.js';
import { extractionInput } from './worker.js';

const reviewerInput = z.strictObject({
  proposal: z.unknown().optional(), questionWording: z.unknown().optional(),
});
const decisionInput = reviewerInput.extend({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(3).max(500),
  replaceExistingRule: z.boolean().optional(),
});

async function extractionView(models, review) {
  if (!review.extractionId || !review.normalization) return null;
  const extraction = await models.EligibilityExtraction.findOne({
    _id: review.extractionId, dataset: review.dataset, sourceId: review.sourceId,
    externalRecordId: review.externalRecordId,
    inputHash: digest(extractionInput(review.normalization.record, review.normalization.fieldProvenance)),
  }).select('-lease -availableAt').lean();
  if (!extraction) return null;
  const current = review.baseVersionId && await models.SchemeRuleVersion.findOne({
    schemeId: review.schemeId, schemeVersionId: review.baseVersionId,
  }).select('rule').lean();
  return { extraction, currentRule: current?.rule, suppliedRule: review.normalization.record.eligibility };
}

function assess(view, draft) {
  const original = view.extraction.result;
  const result = draft.proposal === undefined && draft.questionWording === undefined && original?.schemaValid === false
    ? original : validateProposal(view.extraction.input, draft.proposal === undefined ? original?.proposal : draft.proposal,
      draft.questionWording);
  const { rule, ...preview } = result;
  const existing = [view.currentRule, view.suppliedRule].filter(Boolean);
  const replacesExisting = Boolean(rule) && existing.some(value => comparableRule(value) !== comparableRule(rule));
  return { ...preview, rule, replacesExisting };
}

export function mountExtractionReview(admin, models, origin, getReview) {
  async function reviewWithExtraction(req) {
    const review = await getReview(req);
    const view = await extractionView(models, review);
    if (!view) throw new HttpError(404, 'EXTRACTION_NOT_FOUND', 'This case has no eligibility extraction.');
    return { review, view };
  }

  admin.get('/reviews/:id/extraction', async (req, res) => {
    const { review, view } = await reviewWithExtraction(req);
    const preview = view.extraction.result && assess(view, {});
    const { rule: _rule, ...safePreview } = preview ?? {};
    res.json({ ...view, decision: review.extractionDecision, preview: preview && safePreview });
  });

  function requireFinished(view) {
    if (!view.extraction.result) throw new HttpError(409, 'EXTRACTION_NOT_READY', 'The worker has not produced a proposal.');
  }

  admin.post('/reviews/:id/extraction/validate', origin, jsonBody, async (req, res) => {
    const { view } = await reviewWithExtraction(req);
    requireFinished(view);
    const draft = safeInput(reviewerInput, req.body);
    const { rule: _rule, ...preview } = assess(view, draft);
    res.json(preview);
  });

  admin.post('/reviews/:id/extraction/decision', origin, jsonBody, async (req, res) => {
    const { review, view } = await reviewWithExtraction(req);
    const submitted = safeInput(decisionInput, req.body);
    const { action, reason } = submitted;
    const at = new Date();
    const actorId = req.user._id;
    const extractionId = view.extraction._id;
    if (action === 'reject') {
      const decision = await models.ReviewCase.findOneAndUpdate({
        _id: review._id, extractionId, status: { $in: ['pending', 'deferred'] }, 'extractionDecision.status': { $exists: false },
      }, {
        $set: { extractionDecision: { status: 'rejected', extractionId, actorId, reason, at } },
        $push: { decisionHistory: { actorId, action: 'reject_extraction', reason, at } },
      }, { new: true });
      if (!decision) throw new HttpError(409, 'EXTRACTION_ALREADY_DECIDED', 'This proposal is no longer open for review.');
      return res.json({ status: 'rejected' });
    }

    requireFinished(view);
    const assessment = assess(view, submitted);
    if (!assessment.valid) throw new HttpError(422, 'INVALID_EXTRACTION', 'Resolve the evidence and validation warnings before approval.', assessment.warnings);
    if (assessment.replacesExisting && submitted.replaceExistingRule !== true) {
      throw new HttpError(409, 'CONFIRM_RULE_REPLACEMENT', 'Confirm that the reviewed rule should replace existing verified criteria.');
    }
    const approval = {
      status: 'approved', extractionId, actorId, reason, at, rule: assessment.rule,
      inputHash: view.extraction.inputHash, field: view.extraction.input.field, sourceRecordId: review.sourceRecordId,
      evidence: assessment.evidence, provider: view.extraction.provider, providerVersion: view.extraction.providerVersion,
      policyVersion: view.extraction.policyVersion,
    };
    let decision;
    try {
      decision = await decideReview(models, review, 'approve', actorId, reason, { extractionApproval: approval });
    } catch (error) {
      if (!(error instanceof FeedError)) throw error;
      throw new HttpError(409, error.code, 'Complete synchronization for this evidence before approval.');
    }
    if (!decision) throw new HttpError(409, 'EXTRACTION_ALREADY_DECIDED', 'This proposal is no longer open for review.');
    res.json({ status: 'approved' });
  });
}
