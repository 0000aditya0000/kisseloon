import { Router } from 'express';
import type { Request, Response } from 'express';
import logger from '../config/logger';
import scraperManager from '../services/scrapers/scraperManager';

const router = Router();

function asSingleString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return '';
}

function requireQueryParam(value: unknown, name: string): string {
  const normalized = asSingleString(value).trim();
  if (!normalized) {
    const error = new Error(`Missing required query parameter: ${name}`);
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return normalized;
}

function ensureScraperReady(res: Response): boolean {
  if (!scraperManager.zomato.isConnected) {
    res.status(503).json({
      success: false,
      data: null,
      error:
        'Zomato scraper is not connected. Ensure Playwright Chromium is installed and the service initialized.',
    });
    return false;
  }
  return true;
}

/** GET /api/v1/zomato/search?q=&location= */
router.get('/search', async (req: Request, res: Response) => {
  try {
    if (!ensureScraperReady(res)) {
      return;
    }

    // Support both `q` (preferred) and legacy `query`
    const q = requireQueryParam(req.query.q ?? req.query.query, 'q');
    const location = requireQueryParam(
      req.query.location ?? process.env.SCRAPPER_DEFAULT_LOCATION,
      'location'
    );

    logger.info('[route] GET /zomato/search', { q, location });
    const result = await scraperManager.zomato.searchItems(q, location);

    if (!result.success) {
      res.status(503).json({
        success: false,
        data: result.data,
        error: result.error || 'Zomato scrape failed',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
      total: result.data.length,
    });
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    logger.error('[route] GET /zomato/search failed', { error: err.message });
    res.status(err.statusCode ?? 503).json({
      success: false,
      data: null,
      error: err.message || 'Service unavailable',
    });
  }
});

/** GET /api/v1/zomato/menu?url= */
router.get('/menu', async (req: Request, res: Response) => {
  try {
    if (!ensureScraperReady(res)) {
      return;
    }

    const url = requireQueryParam(req.query.url, 'url');

    logger.info('[route] GET /zomato/menu', { url });
    const result = await scraperManager.zomato.getRestaurantMenu(url);

    if (!result.success) {
      res.status(503).json({
        success: false,
        data: result.data,
        error: result.error || 'Zomato menu scrape failed',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
      total: result.data.length,
    });
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    logger.error('[route] GET /zomato/menu failed', { error: err.message });
    res.status(err.statusCode ?? 503).json({
      success: false,
      data: null,
      error: err.message || 'Service unavailable',
    });
  }
});

/** GET /api/v1/zomato/status */
router.get('/status', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      platform: 'zomato',
      connected: scraperManager.zomato.isConnected,
      lastError: scraperManager.zomato.lastError,
      note: scraperManager.zomato.isConnected
        ? 'Browser is ready. Search/menu may still fail if Zomato blocks the session.'
        : 'Browser failed to launch. Check Playwright Chromium install and restart.',
    },
  });
});

/** POST /api/v1/zomato/reconnect — relaunch browser after a failed boot */
router.post('/reconnect', async (_req: Request, res: Response) => {
  try {
    logger.info('[route] POST /zomato/reconnect');
    if (scraperManager.zomato.isConnected) {
      await scraperManager.zomato.close();
    }
    await scraperManager.zomato.initialize();
    res.status(200).json({
      success: true,
      data: {
        platform: 'zomato',
        connected: scraperManager.zomato.isConnected,
        lastError: scraperManager.zomato.lastError,
      },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      data: {
        platform: 'zomato',
        connected: scraperManager.zomato.isConnected,
      },
      error: (error as Error).message,
    });
  }
});

export default router;
