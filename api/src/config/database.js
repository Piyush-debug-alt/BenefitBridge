import mongoose from 'mongoose';
import { createCatalogueModels } from '../modules/catalogue/models.js';
import { createIngestionModels } from '../modules/ingestion/models.js';
import { createMatchingModels } from '../modules/matching/model.js';
import { createAccountModels } from '../modules/auth/models.js';
import { createNotificationModels } from '../modules/notifications/models.js';
import { createSyncModels } from '../modules/ingestion/sync-models.js';
import { createExtractionModels } from '../modules/extraction/model.js';

export async function connectDatabase(config) {
  const connection = mongoose.createConnection(config.uri, {
    dbName: config.database,
    serverSelectionTimeoutMS: 5000,
    autoIndex: false,
    ...config.connectionOptions,
  });

  try {
    await connection.asPromise();
    const models = {
      ...createCatalogueModels(connection),
      ...createIngestionModels(connection),
      ...createMatchingModels(connection),
      ...createAccountModels(connection),
      ...createNotificationModels(connection),
      ...createSyncModels(connection),
      ...createExtractionModels(connection),
    };
    await Promise.all(Object.values(models).map(model => model.createIndexes()));
    return { connection, models };
  } catch {
    await connection.close();
    throw new Error('Could not connect to MongoDB or initialize catalogue indexes.');
  }
}
