import { Router } from 'express';
import type { Request, Response } from 'express';
import env from '../config/env';
import logger from '../config/logger';
import restaurantService from '../services/comparison/restaurantService';

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

/** GET /api/v1/restaurants?dish=&location= */
router.get('/', async (req: Request, res: Response) => {
  try {
    const dish = asSingleString(req.query.dish ?? req.query.q).trim();
    if (!dish) {
      res.status(400).json({
        success: false,
        data: [],
        error: 'Missing required query parameter: dish',
      });
      return;
    }

    const location =
      asSingleString(req.query.location).trim() || env.scrapper.defaultLocation;

    logger.info('[route] GET /restaurants', {
      dish,
      location,
      timeoutMs: env.scrapper.searchTimeoutMs,
    });

    const result = await withTimeout(
      restaurantService.getRestaurantsByDish(dish, location),
      env.scrapper.searchTimeoutMs,
      `Restaurant search timed out after ${Math.round(env.scrapper.searchTimeoutMs / 1000)}s while waiting for platform scrapers. Increase SCRAPPER_SEARCH_TIMEOUT_MS or retry.`
    );

    if (!result.success) {
      res.status(503).json({
        success: false,
        data: result.data,
        error: result.error,
        meta: {
          location,
          dish,
          platforms: result.platforms,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
      meta: {
        count: result.data.length,
        location,
        dish,
        platforms: result.platforms,
      },
    });
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    logger.error('[route] GET /restaurants failed', { error: err.message });

    const status = err.statusCode === 504 ? 504 : 503;
    res.status(status).json({
      success: false,
      data: [],
      error: err.message || 'Restaurant search failed',
    });
  }
});

const MENU_COMPARISON_TIMEOUT_MS = 15_000;

function optionalUrl(value: unknown): string | null {
  const raw = asSingleString(value).trim();
  return raw.length > 0 ? raw : null;
}

/** GET /api/v1/restaurants/:id/menu-comparison?url_zomato=&url_swiggy= */
router.get('/:id/menu-comparison', async (req: Request, res: Response) => {
  try {
    const urlZomato = optionalUrl(req.query.url_zomato);
    const urlSwiggy = optionalUrl(req.query.url_swiggy);

    logger.info('[route] GET /restaurants/:id/menu-comparison', {
      id: req.params.id,
      hasZomato: Boolean(urlZomato),
      hasSwiggy: Boolean(urlSwiggy),
      timeoutMs: MENU_COMPARISON_TIMEOUT_MS,
    });

    const result = await withTimeout(
      restaurantService.getMenuComparison(urlZomato, urlSwiggy),
      MENU_COMPARISON_TIMEOUT_MS,
      'Menu fetching is taking longer than expected. Please try again.'
    );

    if (!result.success) {
      const status = result.error?.includes('required') ? 400 : 503;
      res.status(status).json({
        success: false,
        data: result.data,
        error: result.error,
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result.data,
    });
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    logger.error('[route] GET /restaurants/:id/menu-comparison failed', {
      id: req.params.id,
      error: err.message,
    });

    if (err.statusCode === 504) {
      res.status(504).json({
        success: false,
        message: 'Menu fetching is taking longer than expected. Please try again.',
      });
      return;
    }

    res.status(503).json({
      success: false,
      message: err.message || 'Menu comparison failed',
    });
  }
});

export default router;
