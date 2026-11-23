import { randomUUID } from 'node:crypto';
import { answersSchema, eligibilitySchema } from '../matching/criteria.js';
import { evaluateScheme } from '../matching/engine.js';

const retryMs = 60_000;

async function recipientIds(models, scheme, event) {
  if (event.type === 'bookmark_update') {
    return models.Bookmark.find({ schemeId: scheme._id, createdAt: { $lte: event.createdAt } })
      .select('userId').lean().cursor();
  }
  if (scheme.lifecycleStatus !== 'active') return [];
  const saved = await models.SchemeRuleVersion.findOne({ schemeId: scheme._id, schemeVersionId: event.versionId }).lean();
  const rule = eligibilitySchema.safeParse(saved?.rule);
  if (!rule.success || !scheme.sourceRefs.some(ref => ref.url === rule.data.evidenceUrl)) return [];

  return matchingProfiles(models.Profile, event, rule.data);
}

async function* matchingProfiles(Profile, event, rule) {
  const profiles = Profile.find({ consentAt: { $lte: event.createdAt } }).select('userId attributes updatedAt').lean().cursor();
  for await (const profile of profiles) {
    const answers = answersSchema.safeParse(profile.attributes);
    if (answers.success && evaluateScheme(rule, answers.data).outcome === 'POTENTIAL_MATCH') yield profile;
  }
}

async function deliver(models, dataset, event) {
  const { Scheme, SchemeVersion, Notification, NotificationPreference } = models;
  const live = {
    _id: event.schemeId, dataset, currentVersionId: event.versionId,
    publicationStatus: 'published', verificationStatus: 'verified',
  };
  const scheme = await Scheme.findOne(live).lean();
  if (!scheme) {
    const latest = await Scheme.findOne({ _id: event.schemeId, dataset }).select('currentVersionId').lean();
    const revision = latest?.currentVersionId && await SchemeVersion.findById(latest.currentVersionId).select('versionNo').lean();
    return Boolean(revision && revision.versionNo > event.versionNo);
  }

  const field = event.type === 'bookmark_update' ? 'bookmarkUpdatesSince' : 'profileMatchesSince';
  const cursor = await recipientIds(models, scheme, event);
  for await (const recipient of cursor) {
    const { userId } = recipient;
    const preference = await NotificationPreference.exists({ userId, [field]: { $lte: event.createdAt } });
    if (!preference) continue;
    const stillSubscribed = event.type === 'bookmark_update'
      ? await models.Bookmark.exists({ _id: recipient._id, userId })
      : await models.Profile.exists({ _id: recipient._id, userId, updatedAt: recipient.updatedAt });
    if (!stillSubscribed) continue;
    if (!await Scheme.exists(live)) return false;
    const key = { userId, eventKey: event._id };
    try {
      await Notification.updateOne(key, {
        $setOnInsert: { schemeId: scheme._id, schemeName: scheme.canonicalName, type: event.type, createdAt: new Date() },
      }, { upsert: true, runValidators: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }

  return true;
}

export async function processNotificationBatch(models, dataset, { limit = 20 } = {}) {
  const { ChangeEvent } = models;
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    const now = new Date();
    const lease = randomUUID();
    const event = await ChangeEvent.findOneAndUpdate({
      dataset, completedAt: null, availableAt: { $lte: now },
    }, { $set: { availableAt: new Date(now.getTime() + retryMs), lease } }, {
      sort: { availableAt: 1, _id: 1 }, new: true,
    }).lean();
    if (!event) break;

    try {
      const finished = await deliver(models, dataset, event);
      if (finished) {
        await ChangeEvent.updateOne({ _id: event._id, lease }, {
          $set: { completedAt: new Date() }, $unset: { lease: 1 },
        });
        processed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { processed, failed };
}
