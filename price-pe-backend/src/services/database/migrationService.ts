import fs from 'fs';
import path from 'path';
import { query } from '../../config/database';
import logger from '../../config/logger';

const REQUIRED_TABLES = [
  'platforms',
  'categories',
  'products',
  'platform_products',
  'prices',
  'search_cache',
] as const;

const PLATFORM_SEEDS: ReadonlyArray<{ name: string; display_name: string }> = [
  { name: 'zomato', display_name: 'Zomato' },
  { name: 'swiggy', display_name: 'Swiggy' },
  { name: 'blinkit', display_name: 'Blinkit' },
  { name: 'zepto', display_name: 'Zepto' },
  { name: 'instamart', display_name: 'Instamart' },
];

function resolveSchemaPath(): string {
  const candidates = [
    path.join(__dirname, '../../models/schema.sql'),
    path.join(process.cwd(), 'src/models/schema.sql'),
    path.join(process.cwd(), 'dist/models/schema.sql'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `schema.sql not found. Checked: ${candidates.join(', ')}`
  );
}

/** Returns true when every required table exists in the public schema. */
export async function tablesExist(): Promise<boolean> {
  try {
    const result = await query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      `,
      [REQUIRED_TABLES as unknown as string[]]
    );

    const found = new Set(result.rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((name) => !found.has(name));

    if (missing.length > 0) {
      logger.info('Missing database tables', { missing });
      return false;
    }

    logger.info('All required database tables exist');
    return true;
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to check table existence', { error: err.message });
    throw error;
  }
}

/** Apply the full schema.sql (DDL is idempotent via IF NOT EXISTS). */
export async function runSchema(): Promise<void> {
  try {
    const schemaPath = resolveSchemaPath();
    const sql = fs.readFileSync(schemaPath, 'utf8');

    logger.info('Running database schema migration', { schemaPath });
    await query(sql);
    logger.info('Database schema migration completed');
  } catch (error) {
    const err = error as Error;
    logger.error('Database schema migration failed', { error: err.message });
    throw error;
  }
}

/** Upsert the five core platforms used by PricePe. */
export async function seedInitialData(): Promise<void> {
  try {
    logger.info('Seeding initial platform data');

    for (const platform of PLATFORM_SEEDS) {
      await query(
        `
        INSERT INTO platforms (name, display_name, is_active)
        VALUES ($1, $2, true)
        ON CONFLICT (name) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              is_active = true,
              updated_at = NOW()
        `,
        [platform.name, platform.display_name]
      );
    }

    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM platforms'
    );

    logger.info('Platform seed complete', {
      platformCount: Number(countResult.rows[0]?.count ?? 0),
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to seed initial data', { error: err.message });
    throw error;
  }
}

export interface SetupDatabaseResult {
  connected: boolean;
  migrated: boolean;
  seeded: boolean;
}

/**
 * Ensure schema + seed data are ready before the HTTP server accepts traffic.
 */
export async function setupDatabase(): Promise<SetupDatabaseResult> {
  const result: SetupDatabaseResult = {
    connected: false,
    migrated: false,
    seeded: false,
  };

  try {
    logger.info('Starting database setup');

    const exists = await tablesExist();

    if (!exists) {
      await runSchema();
      result.migrated = true;
    } else {
      logger.info('Schema already present — skipping full migration');
      result.migrated = true;
    }

    await seedInitialData();
    result.seeded = true;
    result.connected = true;

    logger.info('Database setup finished successfully', result);
    return result;
  } catch (error) {
    const err = error as Error;
    logger.error('Database setup failed', { error: err.message, result });
    throw error;
  }
}

export default setupDatabase;
