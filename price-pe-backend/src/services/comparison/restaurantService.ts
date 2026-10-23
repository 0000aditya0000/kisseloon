import logger from '../../config/logger';
import type { MenuComparisonResult } from '../../types/restaurant';
import type { RestaurantListing, RestaurantListingResult } from '../../types/restaurant';
import type { PlatformSearchItem, SearchItemsResult } from '../../types/scraper';
import { groupSimilarDishes, type MenuDishInput } from '../../utils/dishMatcher';
import scraperManager from '../scrapers/scraperManager';

const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/150?text=No+Image';
const DEFAULT_CUISINE = 'Mixed Cuisine';

interface TaggedDish extends PlatformSearchItem {
  platform: 'zomato' | 'swiggy';
}

interface RestaurantBucket {
  displayName: string;
  dishes: TaggedDish[];
}

function settledScrape(
  settled: PromiseSettledResult<SearchItemsResult>,
  platformName: 'zomato' | 'swiggy'
): { ok: boolean; data: TaggedDish[]; error?: string } {
  if (settled.status === 'rejected') {
    const error =
      settled.reason instanceof Error
        ? settled.reason.message
        : String(settled.reason || `${platformName} scrape rejected`);
    return { ok: false, data: [], error };
  }

  const value = settled.value;
  if (!value.success) {
    return {
      ok: false,
      data: [],
      error: value.error || `${platformName} scrape failed`,
    };
  }

  return {
    ok: true,
    data: value.data.map((item) => ({ ...item, platform: platformName })),
  };
}

function isPlaceholder(url: string | undefined): boolean {
  if (!url) {
    return true;
  }
  return /placeholder/i.test(url);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function pickCuisine(dishes: TaggedDish[]): string {
  for (const dish of dishes) {
    const extra = dish as PlatformSearchItem & { cuisine?: string };
    if (typeof extra.cuisine === 'string' && extra.cuisine.trim()) {
      return extra.cuisine.trim();
    }
  }
  return DEFAULT_CUISINE;
}

function pickImage(dishes: TaggedDish[]): string {
  const real = dishes.find((d) => d.image_url && !isPlaceholder(d.image_url));
  return real?.image_url || dishes[0]?.image_url || PLACEHOLDER_IMAGE;
}

function pickDeepLink(dishes: TaggedDish[]): string {
  const zomato = dishes.find((d) => d.platform === 'zomato' && d.deep_link);
  if (zomato?.deep_link) {
    return zomato.deep_link;
  }
  return dishes.find((d) => d.deep_link)?.deep_link || '';
}

function pickDisplayName(dishes: TaggedDish[]): string {
  const named = dishes.find((d) => d.restaurant_name.trim());
  return named?.restaurant_name.trim() || 'Unknown restaurant';
}

function toRestaurantListing(dishName: string, dishes: TaggedDish[]): RestaurantListing {
  const ratings = dishes.map((d) => d.rating).filter((n) => Number.isFinite(n) && n > 0);
  const times = dishes
    .map((d) => d.delivery_time_min)
    .filter((n) => Number.isFinite(n) && n > 0);

  const platforms = [...new Set(dishes.map((d) => d.platform))];
  platforms.sort((a, b) => {
    if (a === 'zomato') return -1;
    if (b === 'zomato') return 1;
    return a.localeCompare(b);
  });

  return {
    restaurant_name: pickDisplayName(dishes),
    cuisine: pickCuisine(dishes),
    rating: roundOneDecimal(average(ratings)),
    delivery_time_min: Math.round(average(times)),
    image_url: pickImage(dishes),
    available_platforms: platforms,
    dish_availability_text: `${dishName} available`,
    deep_link: pickDeepLink(dishes),
  };
}

/**
 * Scrape both platforms for a dish, then collapse listings into unique restaurants
 * for the Restaurant Listing screen.
 */
export async function getRestaurantsByDish(
  dishName: string,
  location: string
): Promise<RestaurantListingResult> {
  const query = dishName.trim();
  logger.info('restaurant.getRestaurantsByDish start', { dishName: query, location });

  const [zomatoSettled, swiggySettled] = await Promise.allSettled([
    scraperManager.zomato.isConnected
      ? scraperManager.zomato.searchItems(query, location)
      : Promise.resolve({
          success: false as const,
          data: [] as PlatformSearchItem[],
          error: 'Zomato scraper is not connected',
        }),
    scraperManager.swiggy.isConnected
      ? scraperManager.swiggy.searchItems(query, location)
      : Promise.resolve({
          success: false as const,
          data: [] as PlatformSearchItem[],
          error: 'Swiggy scraper is not connected',
        }),
  ]);

  const zomato = settledScrape(zomatoSettled, 'zomato');
  const swiggy = settledScrape(swiggySettled, 'swiggy');

  const succeeded: string[] = [];
  const failed: Array<{ platform: string; error: string }> = [];

  if (zomato.ok) {
    succeeded.push('zomato');
  } else {
    failed.push({ platform: 'zomato', error: zomato.error || 'unknown' });
    logger.warn('restaurant: Zomato scrape failed — continuing with other platforms', {
      dishName: query,
      error: zomato.error,
    });
  }

  if (swiggy.ok) {
    succeeded.push('swiggy');
  } else {
    failed.push({ platform: 'swiggy', error: swiggy.error || 'unknown' });
    logger.warn('restaurant: Swiggy scrape failed — continuing with other platforms', {
      dishName: query,
      error: swiggy.error,
    });
  }

  const dishes: TaggedDish[] = [...zomato.data, ...swiggy.data].filter(
    (item) => item.restaurant_name && item.restaurant_name.trim().length >= 2
  );

  if (succeeded.length === 0) {
    return {
      success: false,
      data: [],
      error: failed.map((f) => `${f.platform}: ${f.error}`).join('; ') || 'All platform scrapes failed',
      platforms: { succeeded, failed },
    };
  }

  const buckets = new Map<string, RestaurantBucket>();
  for (const dish of dishes) {
    const key = dish.restaurant_name.trim().toLowerCase();
    const existing = buckets.get(key);
    if (existing) {
      existing.dishes.push(dish);
    } else {
      buckets.set(key, { displayName: dish.restaurant_name.trim(), dishes: [dish] });
    }
  }

  const data: RestaurantListing[] = [...buckets.values()]
    .map((bucket) => toRestaurantListing(query, bucket.dishes))
    .sort((a, b) => b.rating - a.rating);

  logger.info(`Found ${data.length} unique restaurants for dish: ${query}`, {
    dishName: query,
    location,
    restaurants: data.length,
    dishes: dishes.length,
    succeeded,
    failed,
  });

  return {
    success: true,
    data,
    platforms: { succeeded, failed },
  };
}

function normalizeMenuUrl(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Fetch full menus from Zomato and/or Swiggy, then fuzzy-group similar dishes.
 */
export async function getMenuComparison(
  urlZomato: string | null,
  urlSwiggy: string | null
): Promise<MenuComparisonResult> {
  const zomatoUrl = normalizeMenuUrl(urlZomato);
  const swiggyUrl = normalizeMenuUrl(urlSwiggy);

  if (!zomatoUrl && !swiggyUrl) {
    return {
      success: false,
      data: { grouped_dishes: [] },
      error: 'At least one of url_zomato or url_swiggy is required',
    };
  }

  logger.info('restaurant.getMenuComparison start', {
    hasZomato: Boolean(zomatoUrl),
    hasSwiggy: Boolean(swiggyUrl),
  });

  const allDishes: MenuDishInput[] = [];
  const errors: string[] = [];

  if (zomatoUrl) {
    if (!scraperManager.zomato.isConnected) {
      errors.push('Zomato scraper is not connected');
    } else {
      const result = await scraperManager.zomato.getRestaurantMenu(zomatoUrl);
      if (result.success) {
        for (const item of result.data) {
          if (!item.name || item.price <= 0) {
            continue;
          }
          allDishes.push({
            name: item.name,
            platform: 'zomato',
            price: item.price,
            is_veg: item.is_veg,
            image_url: item.image_url || undefined,
          });
        }
      } else {
        errors.push(result.error || 'Zomato menu scrape failed');
        logger.warn('restaurant.getMenuComparison: Zomato menu failed', {
          error: result.error,
        });
      }
    }
  }

  if (swiggyUrl) {
    if (!scraperManager.swiggy.isConnected) {
      errors.push('Swiggy scraper is not connected');
    } else {
      const result = await scraperManager.swiggy.getRestaurantMenu(swiggyUrl);
      if (result.success) {
        for (const item of result.data) {
          if (!item.name || item.price <= 0) {
            continue;
          }
          allDishes.push({
            name: item.name,
            platform: 'swiggy',
            price: item.price,
            is_veg: item.is_veg,
            image_url: item.image_url || undefined,
          });
        }
      } else {
        errors.push(result.error || 'Swiggy menu scrape failed');
        logger.warn('restaurant.getMenuComparison: Swiggy menu failed', {
          error: result.error,
        });
      }
    }
  }

  if (allDishes.length === 0) {
    return {
      success: false,
      data: { grouped_dishes: [] },
      error: errors.join('; ') || 'No menu items could be fetched from the provided URLs',
    };
  }

  const grouped_dishes = groupSimilarDishes(allDishes);

  logger.info(
    `Grouped ${allDishes.length} dishes into ${grouped_dishes.length} unique items for menu comparison`,
    {
      dishCount: allDishes.length,
      groupCount: grouped_dishes.length,
      errors: errors.length > 0 ? errors : undefined,
    }
  );

  return {
    success: true,
    data: { grouped_dishes },
  };
}

const restaurantService = {
  getRestaurantsByDish,
  getMenuComparison,
};

export default restaurantService;
