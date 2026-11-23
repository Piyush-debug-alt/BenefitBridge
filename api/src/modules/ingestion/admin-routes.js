import { Router } from 'express';
import { z } from 'zod';
import { readAuthConfig } from '../auth/config.js';
import { authLimit, jsonBody, requireOrigin, safeInput } from '../auth/security.js';
import { createSessions } from '../auth/session.js';
import { listQuery, schemeId } from '../catalogue/validation.js';
import { HttpError } from '../../middleware/http.js';
import { FeedError } from './adapters.js';
import { opaqueId } from './file-adapter.js';
import { decideReview } from './publication.js';
import { enqueueSync } from './sync.js';
import { mountExtractionReview } from '../extraction/admin.js';

const pageQuery = listQuery.pick({ page: true, limit: true });
const reviewQuery = pageQuery.extend({
  status: z.enum(['pending', 'deferred', 'approved', 'published', 'rejected', 'superseded']).optional(),
});
const selection = z.strictObject({
  action: z.enum(['approve', 'reject', 'defer']),
  reason: z.string().trim().min(3).max(500),
});
const modes = z.strictObject({ mode: z.enum(['snapshot', 'incremental']) });

export function administrationRouter(models, dataset, config = readAuthConfig({}, dataset)) {
  const router = Router();
  const { SyncSource, SyncJob, ReviewCase, SourceRecord, SchemeVersion, Source } = models;
  const origin = requireOrigin(config.origin);
  const admin = Router();
  admin.use(createSessions(models, config).requireUser, (req, _res, next) => {
    if (!req.user.isAdministrator) throw new HttpError(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
    next();
  });

  admin.get('/sources', async (_req, res) => {
    const sources = await SyncSource.find({ dataset })
      .select('capabilities lastSnapshotAt lastSuccessAt lastFailureAt').sort('_id').limit(50).lean();
    res.json({ sources });
  });

  admin.get('/sync-jobs', async (req, res) => {
    const { page, limit } = safeInput(pageQuery, req.query);
    const items = await SyncJob.find({ dataset }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit)
      .limit(limit).select('-lease -leaseUntil').lean();
    res.json({ items });
  });

  admin.post('/sync/:sourceId', authLimit(12, 1), origin, jsonBody, async (req, res) => {
    const sourceId = safeInput(opaqueId, req.params.sourceId);
    const { mode } = safeInput(modes, req.body);
    const source = await SyncSource.findOne({ _id: sourceId, dataset }).lean();
    if (!source) throw new HttpError(404, 'SOURCE_NOT_FOUND', 'Start a worker for this source first.');
    if (mode === 'incremental' && !source.capabilities?.incremental) {
      throw new HttpError(400, 'INCREMENTAL_UNSUPPORTED', 'This source supports snapshots only.');
    }
    const job = await enqueueSync(models, dataset, sourceId, mode);
    res.status(202).json({ jobId: job.id });
  });

  admin.get('/reviews', async (req, res) => {
    const { page, limit, status } = safeInput(reviewQuery, req.query);
    const items = await ReviewCase.find({ dataset, ...(status && { status }) }).sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit)
      .select('sourceId externalRecordId kind status changedFields errorCode publicationError createdAt').lean();
    res.json({ items });
  });

  async function getReview(req) {
    const id = safeInput(schemeId, req.params.id);
    const review = await ReviewCase.findOne({ dataset, _id: id }).lean();
    if (!review) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'This review does not exist.');
    return review;
  }

  admin.get('/reviews/:id', async (req, res) => {
    const review = await getReview(req);
    const [provenance, previous, source] = await Promise.all([
      review.sourceRecordId && SourceRecord.findById(review.sourceRecordId).select('+permittedOriginal').lean(),
      review.baseVersionId && SchemeVersion.findById(review.baseVersionId).select('versionNo fields fieldProvenance').lean(),
      Source.findOne({ _id: review.sourceId, dataset }).select('name baseUrl accessPermissions retentionPolicy evidenceOrigins').lean(),
    ]);
    res.json({ review, provenance, previous, source });
  });

  admin.post('/reviews/:id/decision', origin, jsonBody, async (req, res) => {
    const review = await getReview(req);
    const { action, reason } = safeInput(selection, req.body);
    let decision;
    try {
      decision = await decideReview(models, review, action, req.user._id, reason);
    } catch (error) {
      if (!(error instanceof FeedError)) throw error;
      throw new HttpError(400, error.code, error.code === 'REVIEW_REQUIRES_COMPLETED_SYNC'
        ? 'Complete a synchronization with this evidence before approving publication.'
        : 'The case needs corrected source evidence before publication.');
    }
    if (!decision) throw new HttpError(409, 'ALREADY_DECIDED', 'This case is no longer open.');
    res.json({ status: decision.status });
  });

  mountExtractionReview(admin, models, origin, getReview);
  router.use('/admin', admin);
  return router;
}
