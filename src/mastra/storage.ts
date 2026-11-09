import { InMemoryStore } from '@mastra/core/storage';
import { PostgresStore } from '@mastra/pg';

export const durableStorage = process.env.DATABASE_URL
  ? new PostgresStore({
      id: 'careassistant-postgres',
      connectionString: process.env.DATABASE_URL,
    })
  : undefined;

export const mastraStorage = durableStorage ?? new InMemoryStore({ id: 'careassistant-local-dev' });

export async function requirePostgres() {
  if (!durableStorage) {
    throw new Error('DATABASE_URL is required for the cloud inbox and persistent memory.');
  }

  await durableStorage.init();
  return durableStorage.pool;
}
