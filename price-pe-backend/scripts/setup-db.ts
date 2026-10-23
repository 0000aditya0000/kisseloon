import { testConnection, closePool } from '../src/config/database';
import { setupDatabase } from '../src/services/database/migrationService';
import logger from '../src/config/logger';

async function main(): Promise<void> {
  try {
    const connected = await testConnection();
    if (!connected) {
      throw new Error('PostgreSQL connection failed');
    }

    await setupDatabase();
    logger.info('Manual database setup completed');
    await closePool();
    process.exit(0);
  } catch (error) {
    const err = error as Error;
    logger.error('Manual database setup failed', { error: err.message });
    await closePool();
    process.exit(1);
  }
}

void main();
