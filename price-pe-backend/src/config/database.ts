import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import logger from './logger';
import env from './env';

const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.name,
  user: env.db.user,
  password: env.db.password,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

pool.on('connect', () => {
  logger.debug('New client connected to PostgreSQL pool');
});

pool.on('error', (err: Error) => {
  logger.error('Unexpected PostgreSQL pool error', {
    error: err.message,
    stack: err.stack,
  });
});

pool.on('remove', () => {
  logger.debug('Client removed from PostgreSQL pool');
});

/**
 * Execute a parameterized query against the pool.
 * Always pass user input via `params` — never interpolate into `text`.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();

  try {
    const result = await pool.query<T>(text, params);
    const durationMs = Date.now() - start;

    logger.debug('Executed query', {
      text: text.replace(/\s+/g, ' ').trim().slice(0, 200),
      durationMs,
      rowCount: result.rowCount,
    });

    return result;
  } catch (error) {
    const err = error as Error;
    logger.error('Query failed', {
      text: text.replace(/\s+/g, ' ').trim().slice(0, 200),
      params,
      error: err.message,
    });
    throw error;
  }
}

/**
 * Checkout a dedicated client for multi-statement transactions.
 * Caller must release the client in a `finally` block.
 */
export async function getClient(): Promise<PoolClient> {
  try {
    const client = await pool.connect();
    return client;
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get client from pool', { error: err.message });
    throw error;
  }
}

/** Verify the pool can reach PostgreSQL. */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await query<{ now: Date }>('SELECT NOW() AS now');
    logger.info('PostgreSQL connection successful', {
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      serverTime: result.rows[0]?.now,
    });
    return true;
  } catch (error) {
    const err = error as Error;
    logger.error('PostgreSQL connection failed', {
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      error: err.message,
    });
    return false;
  }
}

/** Drain the pool during graceful shutdown. */
export async function closePool(): Promise<void> {
  try {
    await pool.end();
    logger.info('PostgreSQL pool closed');
  } catch (error) {
    const err = error as Error;
    logger.error('Error closing PostgreSQL pool', { error: err.message });
  }
}

export { pool };
export default pool;
