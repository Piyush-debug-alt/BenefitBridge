import { z } from 'zod';
import { HttpError } from '../../middleware/http.js';
import { jsonBody, safeInput } from '../auth/security.js';
import { listQuery, schemeId } from '../catalogue/validation.js';

const prefsInput = z.strictObject({ bookmarkUpdates: z.boolean(), profileMatches: z.boolean() });
const readInput = z.strictObject({ read: z.boolean() });
const pageInput = listQuery.pick({ page: true, limit: true });

function publicPreferences(record) {
  return { bookmarkUpdates: Boolean(record?.bookmarkUpdatesSince), profileMatches: Boolean(record?.profileMatchesSince) };
}

export function mountNotificationRoutes(router, { Notification, NotificationPreference }, origin) {
  router.get('/me/notification-preferences', async (req, res) => {
    const record = await NotificationPreference.findOne({ userId: req.user._id }).lean();
    res.json({ preferences: publicPreferences(record) });
  });

  router.put('/me/notification-preferences', origin, jsonBody, async (req, res) => {
    const settings = safeInput(prefsInput, req.body);
    const now = new Date();
    const record = await NotificationPreference.findOneAndUpdate({ userId: req.user._id }, [{
      $set: Object.fromEntries(Object.entries(settings).map(([key, enabled]) => {
        const field = key + 'Since';
        return [field, enabled ? { $ifNull: ['$' + field, now] } : '$$REMOVE'];
      })),
    }], { upsert: true, new: true }).lean();
    res.json({ preferences: publicPreferences(record) });
  });

  router.get('/me/notifications', async (req, res) => {
    const { page, limit } = safeInput(pageInput, req.query);
    const owner = { userId: req.user._id };
    const [items, unread, total] = await Promise.all([
      Notification.find(owner).select('schemeId schemeName type readAt createdAt')
        .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Notification.countDocuments({ ...owner, readAt: null }),
      Notification.countDocuments(owner),
    ]);
    res.json({ items, unread, totalPages: Math.min(1000, Math.ceil(total / limit)) });
  });

  router.patch('/me/notifications/:notificationId', origin, jsonBody, async (req, res) => {
    const id = safeInput(schemeId, req.params.notificationId);
    const { read } = safeInput(readInput, req.body);
    const item = await Notification.findOneAndUpdate({ _id: id, userId: req.user._id }, {
      $set: { readAt: read ? new Date() : null },
    }, { new: true }).select('readAt').lean();
    if (!item) throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'This notification could not be found.');
    res.json({ readAt: item.readAt });
  });
}
