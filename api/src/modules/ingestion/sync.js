import { randomUUID } from 'node:crypto';
import { FeedError, pageSchema, withRetry } from './adapters.js';
import { decideReview, processReviewedChanges, publishReview } from './publication.js';
import { reconcileMissing, stageRecord } from './staging.js';
import { enqueueExtraction } from '../extraction/worker.js';

const leaseMs = 180_000;
const maxJobAttempts = 4;
const leaseDate = () => new Date(Date.now() + leaseMs);

async function finishBatch(operations) {
  const outcomes = await Promise.allSettled(operations);
  const failure = outcomes.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return outcomes.map(result => result.value);
}

export async function enqueueSync(models, dataset, sourceId, mode) {
  return models.SyncJob.create({ dataset, sourceId, mode, status: 'queued', availableAt: new Date() });
}

async function runFeed(models, job, adapter, heartbeat, options) {
  const { SyncJob, SyncSource } = models;
  if (job.mode === 'incremental' && !adapter.incremental) throw new FeedError('INCREMENTAL_UNSUPPORTED');
  const stats = { records: 0, pages: 0, staged: 0, conflict: 0, invalid: 0, unchanged: 0, outdated: 0, missing: 0 };
  const cursors = new Set();
  let cursor = null;
  let snapshotKey = job.snapshotKey;
  let final;
  do {
    await heartbeat();
    const value = await withRetry(() => adapter.page({ mode: job.mode, checkpoint: job.checkpointBefore, cursor }), options);
    const parsed = pageSchema.safeParse(value);
    if (!parsed.success) throw new FeedError('INVALID_PAGE');
    const page = parsed.data;
    if (job.mode === 'snapshot') {
      if (!page.snapshotKey || (snapshotKey && snapshotKey !== page.snapshotKey)) throw new FeedError('SNAPSHOT_CHANGED_OR_UNPINNED');
      if (!snapshotKey) {
        snapshotKey = page.snapshotKey;
        await SyncJob.updateOne({ _id: job._id, lease: job.lease }, { $set: { snapshotKey } });
      }
    }
    const ids = page.records.map(item => item?.record?.externalRecordId).filter(id => typeof id === 'string');
    if (new Set(ids).size !== ids.length) throw new FeedError('DUPLICATE_ID_ON_PAGE');
    for (let start = 0; start < page.records.length; start += 16) {
      const outcomes = await finishBatch(page.records.slice(start, start + 16).map(item =>
        stageRecord(models, job, adapter.metadata, item)));
      for (const result of outcomes) stats[result.kind]++;
      if (options.extractionProvider) {
        await finishBatch(outcomes.map(result => enqueueExtraction(models, result.review, options.extractionProvider)));
      }
      if (options.autoPublish) {
        await finishBatch(outcomes.filter(result => result.review?.status === 'pending' && result.kind === 'staged')
          .map(async result => {
            const decision = await decideReview(models, result.review, 'approve', undefined,
              'Isolated synthetic benchmark policy', { syntheticBenchmark: true });
            if (decision) await publishReview(models, decision);
          }));
      }
      if (Date.now() - options.heartbeatAt > 20_000) await heartbeat();
    }
    stats.records += page.records.length;
    stats.pages++;
    if (page.nextCursor && (cursors.has(page.nextCursor) || stats.pages >= 100_000)) {
      throw new FeedError('INVALID_CURSOR_SEQUENCE');
    }
    cursor = page.nextCursor;
    cursors.add(cursor);
    final = page;
  } while (cursor !== null);

  await heartbeat();
  if (job.mode === 'snapshot' && final.complete !== true) throw new FeedError('INCOMPLETE_SNAPSHOT');
  if (job.mode === 'incremental' && !final.checkpoint) throw new FeedError('CHECKPOINT_REQUIRED');
  if (job.mode === 'snapshot' && stats.invalid === 0) {
    stats.missing = await reconcileMissing(models, job, heartbeat);
  }

  const now = new Date();
  const checkpoint = final.checkpoint ?? job.checkpointBefore;
  const committed = await SyncSource.updateOne({ _id: job.sourceId, lease: job.lease }, { $set: {
    lastSuccessAt: now, ...(checkpoint && { checkpoint }), ...(job.mode === 'snapshot' && stats.invalid === 0 && { lastSnapshotAt: now }),
  } });
  if (!committed.matchedCount) throw new FeedError('LEASE_LOST', true);
  await SyncJob.updateOne({ _id: job._id, lease: job.lease }, { $set: {
    status: 'succeeded', stats, finishedAt: now, ...(checkpoint && { checkpointAfter: checkpoint }),
  }, $unset: { errorCode: 1, lease: 1, leaseUntil: 1 } });
}

export async function workSource(models, dataset, adapter, options = {}) {
  const { SyncSource, SyncJob, Source } = models;
  const { id, ...source } = adapter.metadata;
  if (options.autoPublish && (dataset !== 'synthetic' || models.Scheme.db.name !== 'benefitbridge_loadtest')) {
    throw new FeedError('AUTOMATED_APPROVAL_REQUIRES_LOADTEST_DATABASE');
  }
  const url = new URL(source.baseUrl);
  if (url.hostname.endsWith('.invalid') !== (dataset === 'synthetic')) throw new FeedError('SOURCE_DATASET_MISMATCH');
  await Source.updateOne({ _id: id, dataset }, { $set: source }, { upsert: true, runValidators: true });
  await SyncSource.updateOne({ _id: id, dataset }, { $set: {
    capabilities: { incremental: Boolean(adapter.incremental), snapshot: true },
  } }, { upsert: true });
  const lease = randomUUID();
  const now = new Date();
  const state = await SyncSource.findOneAndUpdate({
    _id: id, dataset, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
  }, { $set: { lease, leaseUntil: leaseDate() } }, { new: true }).lean();
  if (!state) return { busy: true };

  let job;
  let status;
  const runOptions = { ...options, heartbeatAt: Date.now() };
  const heartbeat = async () => {
    const result = await SyncSource.updateOne({ _id: id, lease }, { $set: { leaseUntil: leaseDate() } });
    if (!result.matchedCount) throw new FeedError('LEASE_LOST', true);
    if (job) await SyncJob.updateOne({ _id: job._id, lease }, { $set: { leaseUntil: leaseDate() } });
    runOptions.heartbeatAt = Date.now();
  };

  try {
    const head = await SyncJob.findOne({ dataset, sourceId: id, status: { $in: ['running', 'queued'] } })
      .sort({ createdAt: 1, _id: 1 }).select('_id attempts status leaseUntil').lean();
    if (head?.status === 'running' && head.attempts >= maxJobAttempts && head.leaseUntil <= now) {
      await SyncJob.updateOne({ _id: head._id }, { $set: {
        status: 'failed', errorCode: 'INTERRUPTED_TOO_MANY_TIMES', finishedAt: now,
      }, $unset: { lease: 1, leaseUntil: 1 } });
    }
    job = head && await SyncJob.findOneAndUpdate({ _id: head._id, $or: [
      { status: 'running', leaseUntil: { $lte: now } },
      { status: 'queued', availableAt: { $lte: now } },
    ] }, [{ $set: {
      status: 'running', lease, leaseUntil: leaseDate(),
      startedAt: { $ifNull: ['$startedAt', now] }, attempts: { $add: ['$attempts', 1] },
      checkpointBefore: { $ifNull: ['$checkpointBefore', { $literal: state.checkpoint ?? '' }] },
    } }], { sort: { createdAt: 1, _id: 1 }, new: true }).lean();

    if (job) {
      try {
        await runFeed(models, job, adapter, heartbeat, runOptions);
        status = 'succeeded';
      } catch (error) {
        const errorCode = error instanceof FeedError ? error.code : 'STORAGE_OR_ADAPTER_FAILURE';
        const retry = (error.retryable || !(error instanceof FeedError)) && job.attempts < maxJobAttempts;
        status = retry ? 'queued' : 'failed';
        const next = new Date(Date.now() + Math.max(error.retryAfterMs ?? 0, Math.min(60_000, 1000 * 2 ** job.attempts)));
        const owned = await SyncSource.updateOne({ _id: id, lease }, { $set: { lastFailureAt: new Date() } });
        if (!owned.matchedCount) return { status: 'interrupted' };
        await SyncJob.updateOne({ _id: job._id, lease }, {
          $set: { status, availableAt: next, errorCode, ...(!retry && { finishedAt: new Date() }) },
          $unset: { lease: 1, leaseUntil: 1 },
        });
      }
    }
    await heartbeat();
    const reviewed = await processReviewedChanges(models, dataset, id, { heartbeat });
    return { status, reviewed, jobId: job?._id };
  } finally {
    await SyncSource.updateOne({ _id: id, lease }, { $unset: { lease: 1, leaseUntil: 1 } });
  }
}

export async function scheduleSource(models, dataset, adapter, reconcileMs, pollMs) {
  const sourceId = adapter.metadata.id;
  const pending = await models.SyncJob.exists({ dataset, sourceId, status: { $in: ['queued', 'running'] } });
  if (pending) return;
  const state = await models.SyncSource.findById(sourceId).lean();
  const lastAttempt = Math.max(state?.lastFailureAt?.getTime() ?? 0, state?.lastSuccessAt?.getTime() ?? 0);
  if (Date.now() - lastAttempt < pollMs) return;
  const due = !state?.lastSnapshotAt || Date.now() - state.lastSnapshotAt.getTime() >= reconcileMs;
  const mode = due || !adapter.incremental ? 'snapshot' : 'incremental';
  await enqueueSync(models, dataset, sourceId, mode);
}
