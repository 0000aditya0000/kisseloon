import dotenv from 'dotenv';

dotenv.config();

const allowedOrigins = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export const env = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'debug',
  isProduction: process.env.NODE_ENV === 'production',
  allowedOrigins,
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    name: process.env.DB_NAME || 'pricepe',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },
  scrapper: {
    headless: process.env.SCRAPPER_HEADLESS === 'true',
    defaultLocation: process.env.SCRAPPER_DEFAULT_LOCATION || 'bangalore',
    requestDelay: Number.parseInt(process.env.SCRAPPER_REQUEST_DELAY || '2000', 10),
    maxRetries: Number.parseInt(process.env.SCRAPPER_MAX_RETRIES || '3', 10),
    /** Product search orchestration timeout (ms). Scrapes are slow — default 3 minutes. */
    searchTimeoutMs: Number.parseInt(process.env.SCRAPPER_SEARCH_TIMEOUT_MS || '180000', 10),
  },
};

export default env;
