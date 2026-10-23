-- PricePe database schema
-- Extensions: uuid-ossp (UUID helpers) + pgcrypto (gen_random_uuid)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- platforms: delivery / grocery sources we compare
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  logo_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- categories: hierarchical product taxonomy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  parent_id UUID REFERENCES categories(id),
  icon VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- products: normalized catalog items across platforms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  category_id UUID REFERENCES categories(id),
  brand VARCHAR(200),
  image_url TEXT,
  upc_ean VARCHAR(50),
  unit VARCHAR(50),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (name, brand, unit)
);

-- ---------------------------------------------------------------------------
-- platform_products: mapping of a product to a platform-specific listing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  platform_id UUID REFERENCES platforms(id) ON DELETE CASCADE,
  platform_product_id TEXT NOT NULL,
  platform_product_name TEXT NOT NULL,
  platform_url TEXT,
  image_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (platform_id, platform_product_id)
);

-- ---------------------------------------------------------------------------
-- prices: time-series / location-scoped price snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_product_id UUID REFERENCES platform_products(id) ON DELETE CASCADE,
  price DECIMAL(10, 2) NOT NULL,
  mrp DECIMAL(10, 2),
  discount_percent DECIMAL(5, 2),
  discount_amount DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'INR',
  in_stock BOOLEAN DEFAULT true,
  stock_quantity INTEGER,
  delivery_time_min INTEGER,
  delivery_fee DECIMAL(10, 2),
  pincode VARCHAR(10),
  location_name VARCHAR(200),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  offer_text TEXT,
  fetched_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- search_cache: short-lived cached search responses per location/platform
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL,
  location VARCHAR(200),
  pincode VARCHAR(10),
  platform_id UUID REFERENCES platforms(id),
  results JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

-- Indexes: products
CREATE INDEX IF NOT EXISTS idx_products_name ON products (name);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products (slug);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products (category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand);
CREATE INDEX IF NOT EXISTS idx_products_upc_ean ON products (upc_ean);

-- Indexes: platform_products
CREATE INDEX IF NOT EXISTS idx_platform_products_product_id ON platform_products (product_id);
CREATE INDEX IF NOT EXISTS idx_platform_products_platform_id ON platform_products (platform_id);
CREATE INDEX IF NOT EXISTS idx_platform_products_platform_product_id ON platform_products (platform_product_id);

-- Indexes: prices
CREATE INDEX IF NOT EXISTS idx_prices_platform_product_id ON prices (platform_product_id);
CREATE INDEX IF NOT EXISTS idx_prices_fetched_at ON prices (fetched_at);
CREATE INDEX IF NOT EXISTS idx_prices_pincode ON prices (pincode);
CREATE INDEX IF NOT EXISTS idx_prices_in_stock ON prices (in_stock);

-- Indexes: search_cache
CREATE INDEX IF NOT EXISTS idx_search_cache_query ON search_cache (query);
CREATE INDEX IF NOT EXISTS idx_search_cache_location ON search_cache (location);
CREATE INDEX IF NOT EXISTS idx_search_cache_expires_at ON search_cache (expires_at);

-- Keep updated_at in sync on row updates
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS trg_platform_products_updated_at ON platform_products;
CREATE TRIGGER trg_platform_products_updated_at
  BEFORE UPDATE ON platform_products
  FOR EACH ROW
  EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS trg_platforms_updated_at ON platforms;
CREATE TRIGGER trg_platforms_updated_at
  BEFORE UPDATE ON platforms
  FOR EACH ROW
  EXECUTE PROCEDURE set_updated_at();

-- Seed core platforms (idempotent)
INSERT INTO platforms (name, display_name, is_active)
VALUES
  ('zomato', 'Zomato', true),
  ('swiggy', 'Swiggy', true),
  ('blinkit', 'Blinkit', true),
  ('zepto', 'Zepto', true),
  ('instamart', 'Instamart', true)
ON CONFLICT (name) DO NOTHING;
