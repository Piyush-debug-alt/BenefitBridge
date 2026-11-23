import { Schema } from 'mongoose';

export const notificationTypes = ['bookmark_update', 'profile_match'];

export function createNotificationModels(connection) {
  const id = { type: Schema.Types.ObjectId, required: true };
  const preferences = new Schema({
    userId: { ...id, unique: true },
    bookmarkUpdatesSince: Date,
    profileMatchesSince: Date,
  }, { collection: 'notification_preferences' });
  preferences.index({ profileMatchesSince: 1, _id: 1 });

  const event = new Schema({
    dataset: { type: String, required: true },
    schemeId: id,
    versionId: id,
    versionNo: { type: Number, required: true },
    type: { type: String, enum: notificationTypes, required: true },
    availableAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    completedAt: Date,
    lease: String,
  }, { collection: 'change_events' });
  event.index({ schemeId: 1, versionId: 1 }, { unique: true });
  event.index({ dataset: 1, completedAt: 1, availableAt: 1, _id: 1 });

  const notification = new Schema({
    userId: id,
    schemeId: id,
    eventKey: id,
    type: { type: String, enum: notificationTypes, required: true },
    schemeName: { type: String, required: true },
    readAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
  }, { collection: 'notifications' });
  notification.index({ userId: 1, eventKey: 1 }, { unique: true });
  notification.index({ userId: 1, createdAt: -1, _id: -1 });
  notification.index({ userId: 1, readAt: 1 });
  return {
    NotificationPreference: connection.model('NotificationPreference', preferences),
    ChangeEvent: connection.model('ChangeEvent', event),
    Notification: connection.model('Notification', notification),
  };
}
