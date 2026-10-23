import express from 'express';
import type { CorsOptions } from 'cors';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import env from './config/env';
import logger, { morganStream } from './config/logger';
import { closePool, testConnection } from './config/database';
import { setupDatabase } from './services/database/migrationService';
import scraperManager from './services/scrapers/scraperManager';
import apiRoutes from './routes';
import notFoundHandler from './middleware/notFound';
import errorHandler from './middleware/errorHandler';

const app = express();
const startedAt = Date.now();

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin || env.allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      message: 'Too many requests, please try again later.',
      statusCode: 429,
    },
  },
});

app.use(helmet());
app.use(cors(corsOptions));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: morganStream }));
app.use(limiter);

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: env.nodeEnv,
    scrapers: {
      zomato: scraperManager.zomato.isConnected,
      swiggy: scraperManager.swiggy.isConnected,
    },
  });
});

app.get('/', (_req, res) => {
  res.status(200).json({
    name: 'PricePe Backend',
    description: 'Food & Grocery Price Comparison API',
    version: '1.0.0',
    environment: env.nodeEnv,
    documentation: 'Coming soon',
    endpoints: {
      health: '/health',
      api: '/api/v1',
      zomato: '/api/v1/zomato',
      swiggy: '/api/v1/swiggy',
      products: '/api/v1/products',
      restaurants: '/api/v1/restaurants',
    },
  });
});

app.use('/api/v1', apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer(): Promise<void> {
  try {
    const connected = await testConnection();
    if (!connected) {
      throw new Error(
        `Unable to connect to PostgreSQL at ${env.db.host}:${env.db.port}/${env.db.name}`
      );
    }

    const dbSetup = await setupDatabase();
    logger.info('Database ready', dbSetup);

    // Scraper init is best-effort — browser failures must not block HTTP startup
    await scraperManager.initialize();
    logger.info('Scraper initialization status', {
      zomatoConnected: scraperManager.zomato.isConnected,
      swiggyConnected: scraperManager.swiggy.isConnected,
      headless: env.scrapper.headless,
      defaultLocation: env.scrapper.defaultLocation,
    });

    const server = app.listen(env.port, () => {
      logger.info('PricePe backend started', {
        port: env.port,
        environment: env.nodeEnv,
        logLevel: env.logLevel,
        pid: process.pid,
        database: env.db.name,
        zomatoScraper: scraperManager.zomato.isConnected ? 'connected' : 'unavailable',
        swiggyScraper: scraperManager.swiggy.isConnected ? 'connected' : 'unavailable',
        startedAt: new Date(startedAt).toISOString(),
      });
      logger.info(`Listening on http://localhost:${env.port}`);
    });

    const shutdown = (signal: string): void => {
      logger.info(`${signal} received — starting graceful shutdown`);

      server.close(async (err) => {
        if (err) {
          logger.error('Error during server close', { error: err.message });
          await scraperManager.shutdown();
          await closePool();
          process.exit(1);
          return;
        }

        await scraperManager.shutdown();
        await closePool();
        logger.info('HTTP server closed. Goodbye.');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10_000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled promise rejection', { reason });
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', { error: error.message, stack: error.stack });
      shutdown('uncaughtException');
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to start PricePe backend', {
      error: err.message,
      stack: err.stack,
      hint: 'Ensure PostgreSQL is running and DB_* env vars are correct. See README.md.',
    });
    await scraperManager.shutdown();
    await closePool();
    process.exit(1);
  }
}

void startServer();

export default app;
