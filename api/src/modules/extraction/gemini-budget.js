export class ExtractionRequestError extends Error {
  constructor(code, { retryable = false, retryAt, deferred = false, diagnostic } = {}) {
    super(code);
    Object.assign(this, { code, retryable, retryAt, deferred, diagnostic });
  }
}

export const geminiBudgetDatabase = 'benefitbridge_ai_usage';

export function geminiRequestBudget(connection, limit, clock = Date.now) {
  const collection = connection.getClient().db(geminiBudgetDatabase).collection('gemini_request_budget');

  return {
    async reserve() {
      const now = clock();
      const throttle = await collection.findOne({ _id: 'cooldown', retryAt: { $gt: new Date(now) } });
      if (throttle) {
        throw new ExtractionRequestError('GEMINI_QUOTA_COOLDOWN', {
          deferred: true, retryAt: throttle.retryAt, diagnostic: { source: 'application', category: 'quota_cooldown' },
        });
      }
      const day = new Date(now).toISOString().slice(0, 10);
      const filter = { _id: day, requests: { $lt: limit } };
      const increment = { $inc: { requests: 1 } };
      try {
        await collection.updateOne(filter, increment, { upsert: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        // A simultaneous first request can win the upsert while leaving budget available.
        if ((await collection.updateOne(filter, increment)).matchedCount) return;
        const retryAt = new Date(Date.parse(day) + 86_400_000);
        throw new ExtractionRequestError('GEMINI_DAILY_LIMIT', {
          deferred: true, retryAt, diagnostic: { source: 'application', category: 'local_daily_limit' },
        });
      }
    },
    async throttleUntil(retryAt) {
      await collection.updateOne({ _id: 'cooldown' }, { $max: { retryAt } }, { upsert: true });
    },
  };
}
