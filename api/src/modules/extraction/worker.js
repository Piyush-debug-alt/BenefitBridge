import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { digest } from '../ingestion/adapters.js';
import { validateProposal } from './evidence.js';

const policyVersion = 'evidence-v1';
const maxAttempts = 3;

export function extractionInput(record) {
  const field = record.eligibilityText ? 'eligibilityText' : 'description';
  return { text: record[field], field, url: record.sourceRefs[0].url };
}

export function retainApprovedRule(previousFields, previousRule, nextRecord) {
  if (!previousFields || !previousRule?.extractionProvenance || !previousRule.rule?.evidenceUrl) return false;
  const field = previousRule.extractionProvenance.field;
  return Boolean(previousFields[field] && previousFields[field] === nextRecord[field] &&
    extractionInput(nextRecord).field === field &&
    nextRecord.sourceRefs.some(ref => ref.url === previousRule.rule.evidenceUrl));
}

export async function enqueueExtraction(models, review, provider) {
  if (!provider || !review?.normalization || review.extractionDecision || !['pending', 'deferred'].includes(review.status)) return;
  const input = extractionInput(review.normalization.record);
  if (!input.text || input.text.length > 4000) return;

  const { dataset, sourceId, externalRecordId } = review;
  const identity = {
    dataset, sourceId, externalRecordId, inputHash: digest(input),
    provider: provider.id, providerVersion: provider.version, policyVersion,
  };
  const job = await models.EligibilityExtraction.findOneAndUpdate(identity, {
    $setOnInsert: { input, status: 'queued', availableAt: new Date() },
  }, { upsert: true, new: true }).select('_id').lean();
  await models.ReviewCase.updateOne({ _id: review._id, status: { $in: ['pending', 'deferred'] },
    'extractionDecision.status': { $exists: false } }, { $set: { extractionId: job._id } });
}

async function extractBoundedly(provider, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('EXTRACTION_TIMEOUT'));
        controller.abort();
      }, timeoutMs);
    });
    return await Promise.race([timeout, Promise.resolve().then(() => provider.extract({
      text, signal: controller.signal,
    }))]);
  } finally {
    clearTimeout(timer);
  }
}

export async function processExtractionBatch(models, dataset, sourceId, provider, { limit = 8, timeoutMs = 5000 } = {}) {
  if (!provider) return 0;
  const { EligibilityExtraction } = models;
  const filters = { dataset, sourceId, provider: provider.id, providerVersion: provider.version, policyVersion };
  await EligibilityExtraction.updateMany({
    ...filters, status: 'running', attempts: { $gte: maxAttempts }, availableAt: { $lte: new Date() },
  }, { $set: { status: 'failed', errorCode: 'EXTRACTION_ATTEMPTS_EXHAUSTED', finishedAt: new Date() }, $unset: { lease: 1 } });
  let processed = 0;
  while (processed < limit) {
    const now = new Date();
    const lease = randomUUID();
    const job = await EligibilityExtraction.findOneAndUpdate({
      ...filters, status: { $in: ['queued', 'running'] }, availableAt: { $lte: now }, attempts: { $lt: maxAttempts },
    }, { $set: { status: 'running', startedAt: now, lease, availableAt: new Date(now.getTime() + Math.max(30_000, timeoutMs * 2)) },
      $inc: { attempts: 1 },
    }, { sort: { availableAt: 1, _id: 1 }, new: true }).lean();
    if (!job) break;
    const begin = performance.now();
    const owned = { _id: job._id, status: 'running', lease };
    let raw;
    try {
      raw = await extractBoundedly(provider, job.input.text, timeoutMs);
    } catch (error) {
      const retry = job.attempts < maxAttempts;
      await EligibilityExtraction.updateOne(owned, { $set: {
        status: retry ? 'queued' : 'failed',
        errorCode: error?.message === 'EXTRACTION_TIMEOUT' ? 'EXTRACTION_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        availableAt: new Date(Date.now() + 1000 * 2 ** job.attempts),
        processingMs: performance.now() - begin,
        ...(!retry && { finishedAt: new Date() }),
      }, $unset: { lease: 1 } });
      processed++;
      continue;
    }

    const result = validateProposal(job.input, raw);
    // Store candidate evidence and warnings only. The publishable rule is derived again during review.
    const { rule: _rule, ...candidate } = result;
    await EligibilityExtraction.updateOne(owned, {
      $set: { result: candidate, status: result.valid ? 'ready' : 'review_required', finishedAt: new Date(),
        processingMs: performance.now() - begin },
      $unset: { lease: 1, errorCode: 1 },
    });
    processed++;
  }
  return processed;
}
