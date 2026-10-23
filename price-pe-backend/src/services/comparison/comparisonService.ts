import { query } from '../../config/database';
import logger from '../../config/logger';
import scraperManager from '../scrapers/scraperManager';
import productService from '../database/productService';
import { normalizeText } from '../../utils/stringUtils';
import type { PlatformSearchItem, SearchItemsResult } from '../../types/scraper';
import type {
  ComparisonProduct,
  ComparisonSearchResult,
  PriceHistoryEntry,
  ProductDetails,
  ProductDetailsResult,
} from '../../types/comparison';

const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/150?text=No+Image';

interface PlatformRow {
  id: string;
  name: string;
}

interface SyncedRow {
  product_id: string;
  name: string;
  restaurant_name: string | null;
  platform_name: string;
  platform_product_id: string;
  price: string;
  mrp: string | null;
  offer_text: string | null;
  delivery_time_min: number | null;
  image_url: string | null;
  product_image_url: string | null;
  deep_link: string | null;
  fetched_at: Date;
}

function parseOfferMeta(offerText: string | null | undefined): {
  rating: number;
  is_veg: boolean;
} {
  if (!offerText) {
    return { rating: 0, is_veg: false };
  }
  try {
    const parsed = JSON.parse(offerText) as { rating?: number; is_veg?: boolean };
    return {
      rating: typeof parsed.rating === 'number' ? parsed.rating : 0,
      is_veg: Boolean(parsed.is_veg),
    };
  } catch {
    const match = offerText.match(/rating["\s:]+(\d(?:\.\d)?)/i);
    return { rating: match ? Number(match[1]) : 0, is_veg: false };
  }
}

function offerMetaText(rating: number, isVeg: boolean): string {
  return JSON.stringify({ rating, is_veg: isVeg });
}

async function ensureRestaurantCategoryId(): Promise<string | null> {
  try {
    const existing = await query<{ id: string }>(
      `SELECT id FROM categories WHERE slug = 'restaurant' LIMIT 1`
    );
    if (existing.rows[0]?.id) {
      return existing.rows[0].id;
    }

    const inserted = await query<{ id: string }>(
      `
      INSERT INTO categories (name, slug, icon)
      VALUES ('Restaurant', 'restaurant', 'restaurant')
      RETURNING id
      `
    );
    return inserted.rows[0]?.id ?? null;
  } catch (error) {
    logger.warn('Failed to ensure restaurant category', {
      error: (error as Error).message,
    });
    return null;
  }
}

async function getPlatformByName(name: string): Promise<PlatformRow | null> {
  const result = await query<PlatformRow>(
    `SELECT id, name FROM platforms WHERE name = $1 LIMIT 1`,
    [name]
  );
  return result.rows[0] ?? null;
}

async function findExistingPlatformProduct(
  platformUuid: string,
  platformProductId: string
): Promise<{ id: string; product_id: string; image_url: string | null } | null> {
  const result = await query<{ id: string; product_id: string; image_url: string | null }>(
    `
    SELECT id, product_id, image_url
    FROM platform_products
    WHERE platform_id = $1
      AND platform_product_id = $2
    LIMIT 1
    `,
    [platformUuid, platformProductId]
  );
  return result.rows[0] ?? null;
}

async function syncPlatformItem(
  item: PlatformSearchItem,
  platform: PlatformRow,
  categoryId: string | null,
  location: string
): Promise<{ productId: string; platformProductUuid: string; created: boolean } | null> {
  const normalized = normalizeText(item.dish_name);
  // Unique per dish + restaurant so the same dish from two places stays distinct
  const platformProductId = `${item.restaurant_id}::${normalizeText(item.dish_name).replace(/\s+/g, '-') || 'dish'}`;
  const imageUrl = item.image_url || PLACEHOLDER_IMAGE;
  const displayName = item.dish_name;
  const deepLink = item.deep_link;

  try {
    const existingPp = await findExistingPlatformProduct(platform.id, platformProductId);

    if (existingPp) {
      await query(
        `
        UPDATE platform_products
        SET platform_product_name = $1,
            platform_url = $2,
            image_url = CASE
              WHEN image_url IS NULL OR image_url = '' OR image_url LIKE '%placeholder%'
                THEN $3
              ELSE image_url
            END,
            is_active = true,
            updated_at = NOW()
        WHERE id = $4
        `,
        [displayName, deepLink, imageUrl, existingPp.id]
      );

      await query(
        `
        UPDATE products
        SET name = $1,
            brand = $2,
            image_url = CASE
              WHEN image_url IS NULL OR image_url = '' OR image_url LIKE '%placeholder%'
                THEN $3
              ELSE image_url
            END,
            description = $4,
            updated_at = NOW()
        WHERE id = $5
        `,
        [
          displayName,
          item.restaurant_name,
          imageUrl,
          `normalized:${normalized}|restaurant:${item.restaurant_id}|platform:${platform.name}`,
          existingPp.product_id,
        ]
      );

      await productService.savePrice({
        platform_product_id: existingPp.id,
        price: item.price || 0,
        mrp: item.price || undefined,
        delivery_time_min: item.delivery_time_min || undefined,
        location_name: location,
        offer_text: offerMetaText(item.rating || 0, item.is_veg),
      });

      return {
        productId: existingPp.product_id,
        platformProductUuid: existingPp.id,
        created: false,
      };
    }

    // One catalog product per dish@restaurant listing
    const productId = await productService.createOrUpdateProduct({
      name: displayName,
      brand: item.restaurant_name,
      unit: 'dish',
      category_id: categoryId ?? undefined,
      image_url: imageUrl,
      description: `normalized:${normalized}|restaurant:${item.restaurant_id}|veg:${item.is_veg}|platform:${platform.name}`,
    });

    const ppId = await productService.createOrUpdatePlatformProduct({
      product_id: productId,
      platform_id: platform.id,
      platform_product_id: platformProductId,
      platform_product_name: displayName,
      platform_url: deepLink,
      image_url: imageUrl,
    });

    await productService.savePrice({
      platform_product_id: ppId,
      price: item.price || 0,
      mrp: item.price || undefined,
      delivery_time_min: item.delivery_time_min || undefined,
      location_name: location,
      offer_text: offerMetaText(item.rating || 0, item.is_veg),
    });

    return { productId, platformProductUuid: ppId, created: true };
  } catch (error) {
    logger.error(`Failed to sync ${platform.name} dish item — continuing batch`, {
      dish: item.dish_name,
      restaurant: item.restaurant_name,
      platformProductId,
      error: (error as Error).message,
    });
    return null;
  }
}

/** One FE row per platform listing (not collapsed by product/platform). */
async function fetchUnifiedListings(platformProductUuids: string[]): Promise<ComparisonProduct[]> {
  if (platformProductUuids.length === 0) {
    return [];
  }

  const result = await query<SyncedRow>(
    `
    SELECT DISTINCT ON (pp.id)
      p.id AS product_id,
      COALESCE(pp.platform_product_name, p.name) AS name,
      p.brand AS restaurant_name,
      plat.name AS platform_name,
      pp.platform_product_id,
      pr.price::text AS price,
      pr.mrp::text AS mrp,
      pr.offer_text,
      pr.delivery_time_min,
      COALESCE(NULLIF(pp.image_url, ''), NULLIF(p.image_url, ''), $2) AS image_url,
      p.image_url AS product_image_url,
      pp.platform_url AS deep_link,
      pr.fetched_at
    FROM platform_products pp
    INNER JOIN products p ON p.id = pp.product_id
    INNER JOIN platforms plat ON plat.id = pp.platform_id
    INNER JOIN prices pr ON pr.platform_product_id = pp.id
    WHERE pp.id = ANY($1::uuid[])
    ORDER BY pp.id, pr.fetched_at DESC
    `,
    [platformProductUuids, PLACEHOLDER_IMAGE]
  );

  return result.rows.map((row) => {
    const meta = parseOfferMeta(row.offer_text);
    return {
      id: row.product_id,
      name: row.name,
      restaurant_name: row.restaurant_name || '',
      platform: row.platform_name,
      platform_id: row.platform_product_id,
      price: Number(row.price) || 0,
      mrp: row.mrp != null ? Number(row.mrp) : null,
      rating: meta.rating,
      delivery_time_min: row.delivery_time_min ?? 0,
      image_url: row.image_url || PLACEHOLDER_IMAGE,
      is_veg: meta.is_veg,
      deep_link: row.deep_link || '',
      last_updated: new Date(row.fetched_at).toISOString(),
    };
  });
}

function settledScrape(
  settled: PromiseSettledResult<SearchItemsResult>,
  platformName: string
): { ok: boolean; data: PlatformSearchItem[]; error?: string } {
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

  return { ok: true, data: value.data };
}

/**
 * Scrape Zomato + Swiggy in parallel → upsert products/prices → flat FE payload.
 * Uses Promise.allSettled so one platform failure does not drop the other.
 */
export async function searchAndSyncPlatforms(
  searchQuery: string,
  location: string
): Promise<ComparisonSearchResult> {
  logger.info('comparison.searchAndSyncPlatforms start', { searchQuery, location });

  const [zomatoSettled, swiggySettled] = await Promise.allSettled([
    scraperManager.zomato.isConnected
      ? scraperManager.zomato.searchItems(searchQuery, location)
      : Promise.resolve({
          success: false as const,
          data: [] as PlatformSearchItem[],
          error: 'Zomato scraper is not connected',
        }),
    scraperManager.swiggy.isConnected
      ? scraperManager.swiggy.searchItems(searchQuery, location)
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
    logger.warn('comparison: Zomato scrape failed — continuing with other platforms', {
      searchQuery,
      error: zomato.error,
    });
  }

  if (swiggy.ok) {
    succeeded.push('swiggy');
  } else {
    failed.push({ platform: 'swiggy', error: swiggy.error || 'unknown' });
    logger.warn('comparison: Swiggy scrape failed — continuing with other platforms', {
      searchQuery,
      error: swiggy.error,
    });
  }

  logger.info('comparison platform scrape summary', {
    searchQuery,
    location,
    succeeded,
    failed,
    zomatoCount: zomato.data.length,
    swiggyCount: swiggy.data.length,
  });

  if (succeeded.length === 0) {
    return {
      success: false,
      data: [],
      error: failed.map((f) => `${f.platform}: ${f.error}`).join('; ') || 'All platform scrapes failed',
      platforms: { succeeded, failed },
    };
  }

  const categoryId = await ensureRestaurantCategoryId();
  const platformProductUuids: string[] = [];
  let created = 0;
  let updated = 0;

  const batches: Array<{ platformName: string; items: PlatformSearchItem[] }> = [];
  if (zomato.ok && zomato.data.length > 0) {
    batches.push({ platformName: 'zomato', items: zomato.data });
  }
  if (swiggy.ok && swiggy.data.length > 0) {
    batches.push({ platformName: 'swiggy', items: swiggy.data });
  }

  for (const batch of batches) {
    const platform = await getPlatformByName(batch.platformName);
    if (!platform) {
      logger.warn(`Platform "${batch.platformName}" is not seeded — skipping sync`, {
        searchQuery,
      });
      failed.push({
        platform: batch.platformName,
        error: `${batch.platformName} platform is not seeded in the database`,
      });
      continue;
    }

    logger.info('comparison scrape raw count', {
      platform: batch.platformName,
      searchQuery,
      scraped: batch.items.length,
      sample: batch.items
        .slice(0, 8)
        .map((r) => `${r.dish_name} @ ${r.restaurant_name}`),
    });

    for (const item of batch.items) {
      const synced = await syncPlatformItem(item, platform, categoryId, location);
      if (!synced) {
        continue;
      }
      platformProductUuids.push(synced.platformProductUuid);
      if (synced.created) {
        created += 1;
      } else {
        updated += 1;
      }
    }
  }

  const data = await fetchUnifiedListings([...new Set(platformProductUuids)]);

  logger.info(`Synced ${created} new products for query: ${searchQuery}`, {
    created,
    updated,
    returned: data.length,
    location,
    platforms: { succeeded, failed },
  });

  return {
    success: true,
    data,
    synced: created + updated,
    created,
    updated,
    platforms: { succeeded, failed },
  };
}

export async function getProductDetails(productId: string): Promise<ProductDetailsResult> {
  try {
    const productResult = await query<{
      id: string;
      name: string;
      slug: string;
      image_url: string | null;
      description: string | null;
    }>(
      `
      SELECT id, name, slug, image_url, description
      FROM products
      WHERE id = $1
      LIMIT 1
      `,
      [productId]
    );

    const product = productResult.rows[0];
    if (!product) {
      return { success: false, data: null, error: 'Product not found' };
    }

    const platformsResult = await query<{
      platform_name: string;
      platform_display_name: string;
      platform_product_id: string;
      deep_link: string | null;
      image_url: string | null;
      price: string | null;
      mrp: string | null;
      offer_text: string | null;
      delivery_time_min: number | null;
      fetched_at: Date | null;
    }>(
      `
      SELECT DISTINCT ON (plat.id)
        plat.name AS platform_name,
        plat.display_name AS platform_display_name,
        pp.platform_product_id,
        pp.platform_url AS deep_link,
        COALESCE(pp.image_url, p.image_url) AS image_url,
        pr.price::text AS price,
        pr.mrp::text AS mrp,
        pr.offer_text,
        pr.delivery_time_min,
        pr.fetched_at
      FROM platform_products pp
      INNER JOIN platforms plat ON plat.id = pp.platform_id
      INNER JOIN products p ON p.id = pp.product_id
      LEFT JOIN prices pr ON pr.platform_product_id = pp.id
      WHERE pp.product_id = $1
        AND pp.is_active = true
      ORDER BY plat.id, pr.fetched_at DESC NULLS LAST
      `,
      [productId]
    );

    const historyResult = await query<{
      id: string;
      price: string;
      mrp: string | null;
      offer_text: string | null;
      delivery_time_min: number | null;
      fetched_at: Date;
      location_name: string | null;
    }>(
      `
      SELECT
        pr.id,
        pr.price::text AS price,
        pr.mrp::text AS mrp,
        pr.offer_text,
        pr.delivery_time_min,
        pr.fetched_at,
        pr.location_name
      FROM prices pr
      INNER JOIN platform_products pp ON pp.id = pr.platform_product_id
      WHERE pp.product_id = $1
      ORDER BY pr.fetched_at DESC
      LIMIT 5
      `,
      [productId]
    );

    const price_history: PriceHistoryEntry[] = historyResult.rows.map((row) => ({
      id: row.id,
      price: Number(row.price) || 0,
      mrp: row.mrp != null ? Number(row.mrp) : null,
      rating: parseOfferMeta(row.offer_text).rating,
      delivery_time_min: row.delivery_time_min,
      fetched_at: new Date(row.fetched_at).toISOString(),
      location_name: row.location_name,
    }));

    const details: ProductDetails = {
      id: product.id,
      name: product.name,
      slug: product.slug,
      image_url: product.image_url,
      description: product.description,
      platforms: platformsResult.rows.map((row) => ({
        platform: row.platform_name,
        platform_display_name: row.platform_display_name,
        platform_product_id: row.platform_product_id,
        deep_link: row.deep_link,
        image_url: row.image_url || PLACEHOLDER_IMAGE,
        latest_price: row.price != null ? Number(row.price) : null,
        mrp: row.mrp != null ? Number(row.mrp) : null,
        rating: parseOfferMeta(row.offer_text).rating,
        delivery_time_min: row.delivery_time_min,
        last_updated: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
      })),
      price_history,
    };

    return { success: true, data: details };
  } catch (error) {
    logger.error('getProductDetails failed', {
      productId,
      error: (error as Error).message,
    });
    return {
      success: false,
      data: null,
      error: (error as Error).message || 'Failed to load product details',
    };
  }
}

const comparisonService = {
  searchAndSyncPlatforms,
  getProductDetails,
};

export default comparisonService;
