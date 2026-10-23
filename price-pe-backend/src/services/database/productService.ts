import { query } from '../../config/database';
import logger from '../../config/logger';

export interface CreateProductInput {
  name: string;
  brand?: string;
  category_id?: string;
  image_url?: string;
  upc_ean?: string;
  unit?: string;
  description?: string;
}

export interface CreatePlatformProductInput {
  product_id: string;
  platform_id: string;
  platform_product_id: string;
  platform_product_name: string;
  platform_url?: string;
  image_url?: string;
}

export interface SavePriceInput {
  platform_product_id: string;
  price: number;
  mrp?: number;
  discount_percent?: number;
  in_stock?: boolean;
  delivery_time_min?: number;
  pincode?: string;
  location_name?: string;
  latitude?: number;
  longitude?: number;
  offer_text?: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

export async function createOrUpdateProduct(product: CreateProductInput): Promise<string> {
  const brand = product.brand ?? null;
  const unit = product.unit ?? null;

  try {
    const existing = await query<{ id: string }>(
      `
      SELECT id
      FROM products
      WHERE name = $1
        AND brand IS NOT DISTINCT FROM $2
        AND unit IS NOT DISTINCT FROM $3
      LIMIT 1
      `,
      [product.name, brand, unit]
    );

    if (existing.rows[0]?.id) {
      logger.debug('Product already exists', { productId: existing.rows[0].id });
      return existing.rows[0].id;
    }

    const slug = slugify([product.name, brand, unit].filter(Boolean).join(' '));
    const inserted = await query<{ id: string }>(
      `
      INSERT INTO products (
        name, slug, description, category_id, brand, image_url, upc_ean, unit, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
      RETURNING id
      `,
      [
        product.name,
        slug,
        product.description ?? null,
        product.category_id ?? null,
        brand,
        product.image_url ?? null,
        product.upc_ean ?? null,
        unit,
      ]
    );

    const productId = inserted.rows[0].id;
    logger.info('Created product', { productId, name: product.name });
    return productId;
  } catch (error) {
    logger.error('createOrUpdateProduct failed', {
      error: (error as Error).message,
      product,
    });
    throw error;
  }
}

export async function createOrUpdatePlatformProduct(
  data: CreatePlatformProductInput
): Promise<string> {
  try {
    const existing = await query<{ id: string }>(
      `
      SELECT id
      FROM platform_products
      WHERE platform_id = $1
        AND platform_product_id = $2
      LIMIT 1
      `,
      [data.platform_id, data.platform_product_id]
    );

    if (existing.rows[0]?.id) {
      await query(
        `
        UPDATE platform_products
        SET product_id = $1,
            platform_product_name = $2,
            platform_url = COALESCE($3, platform_url),
            image_url = COALESCE($4, image_url),
            is_active = true,
            updated_at = NOW()
        WHERE id = $5
        `,
        [
          data.product_id,
          data.platform_product_name,
          data.platform_url ?? null,
          data.image_url ?? null,
          existing.rows[0].id,
        ]
      );
      return existing.rows[0].id;
    }

    const inserted = await query<{ id: string }>(
      `
      INSERT INTO platform_products (
        product_id, platform_id, platform_product_id, platform_product_name,
        platform_url, image_url, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, true)
      RETURNING id
      `,
      [
        data.product_id,
        data.platform_id,
        data.platform_product_id,
        data.platform_product_name,
        data.platform_url ?? null,
        data.image_url ?? null,
      ]
    );

    return inserted.rows[0].id;
  } catch (error) {
    logger.error('createOrUpdatePlatformProduct failed', {
      error: (error as Error).message,
      data,
    });
    throw error;
  }
}

export async function savePrice(data: SavePriceInput): Promise<void> {
  try {
    await query(
      `
      INSERT INTO prices (
        platform_product_id, price, mrp, discount_percent, in_stock,
        delivery_time_min, pincode, location_name, latitude, longitude,
        offer_text, fetched_at, expires_at
      )
      VALUES (
        $1, $2, $3, $4, COALESCE($5, true),
        $6, $7, $8, $9, $10,
        $11, NOW(), NOW() + INTERVAL '30 minutes'
      )
      `,
      [
        data.platform_product_id,
        data.price,
        data.mrp ?? null,
        data.discount_percent ?? null,
        data.in_stock ?? true,
        data.delivery_time_min ?? null,
        data.pincode ?? null,
        data.location_name ?? null,
        data.latitude ?? null,
        data.longitude ?? null,
        data.offer_text ?? null,
      ]
    );
  } catch (error) {
    logger.error('savePrice failed', {
      error: (error as Error).message,
      platformProductId: data.platform_product_id,
    });
    throw error;
  }
}

/** Latest non-expired (or most recent) price per platform for a product. */
export async function getProductPrices(productId: string): Promise<Record<string, unknown>[]> {
  try {
    const result = await query(
      `
      SELECT DISTINCT ON (p.id)
        pr.id AS price_id,
        pr.price,
        pr.mrp,
        pr.discount_percent,
        pr.currency,
        pr.in_stock,
        pr.delivery_time_min,
        pr.delivery_fee,
        pr.pincode,
        pr.location_name,
        pr.fetched_at,
        pr.expires_at,
        pp.platform_product_id,
        pp.platform_product_name,
        pp.platform_url,
        p.name AS platform_name,
        p.display_name AS platform_display_name
      FROM platform_products pp
      INNER JOIN platforms p ON p.id = pp.platform_id
      INNER JOIN prices pr ON pr.platform_product_id = pp.id
      WHERE pp.product_id = $1
        AND pp.is_active = true
      ORDER BY p.id, pr.fetched_at DESC
      `,
      [productId]
    );

    return result.rows;
  } catch (error) {
    logger.error('getProductPrices failed', {
      error: (error as Error).message,
      productId,
    });
    throw error;
  }
}

export async function searchProducts(
  searchQuery: string,
  limit = 20
): Promise<Record<string, unknown>[]> {
  try {
    const result = await query(
      `
      SELECT
        prod.id,
        prod.name,
        prod.slug,
        prod.brand,
        prod.unit,
        prod.image_url,
        prod.description,
        COALESCE(
          json_agg(
            json_build_object(
              'platform', plat.display_name,
              'platform_name', plat.name,
              'price', latest.price,
              'mrp', latest.mrp,
              'in_stock', latest.in_stock,
              'fetched_at', latest.fetched_at
            )
          ) FILTER (WHERE latest.price IS NOT NULL),
          '[]'
        ) AS prices
      FROM products prod
      LEFT JOIN platform_products pp ON pp.product_id = prod.id AND pp.is_active = true
      LEFT JOIN platforms plat ON plat.id = pp.platform_id
      LEFT JOIN LATERAL (
        SELECT pr.price, pr.mrp, pr.in_stock, pr.fetched_at
        FROM prices pr
        WHERE pr.platform_product_id = pp.id
        ORDER BY pr.fetched_at DESC
        LIMIT 1
      ) latest ON true
      WHERE prod.is_active = true
        AND prod.name ILIKE $1
      GROUP BY prod.id
      ORDER BY prod.name ASC
      LIMIT $2
      `,
      [`%${searchQuery}%`, limit]
    );

    return result.rows;
  } catch (error) {
    logger.error('searchProducts failed', {
      error: (error as Error).message,
      searchQuery,
    });
    throw error;
  }
}

export async function getPlatformIdByName(name: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT id FROM platforms WHERE name = $1 LIMIT 1`,
    [name]
  );
  return result.rows[0]?.id ?? null;
}

/** Read a non-expired search_cache row. */
export async function getSearchCache(params: {
  query: string;
  location?: string;
  pincode?: string;
  platformId?: string | null;
}): Promise<unknown | null> {
  const result = await query<{ results: unknown }>(
    `
    SELECT results
    FROM search_cache
    WHERE query = $1
      AND location IS NOT DISTINCT FROM $2
      AND pincode IS NOT DISTINCT FROM $3
      AND platform_id IS NOT DISTINCT FROM $4
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [params.query, params.location ?? null, params.pincode ?? null, params.platformId ?? null]
  );

  return result.rows[0]?.results ?? null;
}

/** Persist search results with TTL (default 15 minutes). */
export async function setSearchCache(params: {
  query: string;
  location?: string;
  pincode?: string;
  platformId?: string | null;
  results: unknown;
  ttlMinutes?: number;
}): Promise<void> {
  const ttl = params.ttlMinutes ?? 15;
  await query(
    `
    INSERT INTO search_cache (query, location, pincode, platform_id, results, expires_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6 || ' minutes')::interval)
    `,
    [
      params.query,
      params.location ?? null,
      params.pincode ?? null,
      params.platformId ?? null,
      JSON.stringify(params.results),
      String(ttl),
    ]
  );
}

const productService = {
  createOrUpdateProduct,
  createOrUpdatePlatformProduct,
  savePrice,
  getProductPrices,
  searchProducts,
  getPlatformIdByName,
  getSearchCache,
  setSearchCache,
};

export default productService;
