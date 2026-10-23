import { Router } from 'express';
import type { Request, Response } from 'express';
import env from '../config/env';
import logger from '../config/logger';
import comparisonService from '../services/comparison/comparisonService';

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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(message), { statusCode: 504 }));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  }) as Promise<T>;
}

/** GET /api/v1/products/search?q=&location= */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const q = asSingleString(req.query.q ?? req.query.query).trim();
    if (!q) {
      res.status(400).json({
        success: false,
        data: [],
        error: 'Missing required query parameter: q',
      });
      return;
    }

    const location =
      asSingleString(req.query.location).trim() || env.scrapper.defaultLocation;

    logger.info('[route] GET /products/search', {
      q,
      location,
      timeoutMs: env.scrapper.searchTimeoutMs,
    });

    const result = await withTimeout(
      comparisonService.searchAndSyncPlatforms(q, location),
      env.scrapper.searchTimeoutMs,
      `Product search timed out after ${Math.round(env.scrapper.searchTimeoutMs / 1000)}s while waiting for platform scrapers. Increase SCRAPPER_SEARCH_TIMEOUT_MS or retry.`
    );

    if (!result.success) {
      res.status(503).json({
        success: false,
        data: result.data,
        error: result.error,
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
      meta: {
        synced: result.synced,
        created: result.created,
        updated: result.updated,
        location,
        query: q,
        platforms: result.platforms,
      },
    });
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    logger.error('[route] GET /products/search failed', { error: err.message });

    const status = err.statusCode === 504 ? 504 : 503;
    res.status(status).json({
      success: false,
      data: [],
      error: err.message || 'Product search failed',
    });
  }
});

/** GET /api/v1/products/:id */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = asSingleString(req.params.id).trim();
    if (!id) {
      res.status(400).json({
        success: false,
        data: null,
        error: 'Missing product id',
      });
      return;
    }

    logger.info('[route] GET /products/:id', { id });
    const result = await comparisonService.getProductDetails(id);

    if (!result.success || !result.data) {
      res.status(result.error === 'Product not found' ? 404 : 503).json({
        success: false,
        data: null,
        error: result.error || 'Failed to load product',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
    });
  } catch (error) {
    logger.error('[route] GET /products/:id failed', {
      error: (error as Error).message,
    });
    res.status(503).json({
      success: false,
      data: null,
      error: (error as Error).message || 'Failed to load product',
    });
  }
});

export default router;
