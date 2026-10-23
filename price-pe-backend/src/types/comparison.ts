export interface ComparisonProduct {
  id: string;
  /** Dish / item name (e.g. "Biryani") */
  name: string;
  /** Restaurant serving the dish */
  restaurant_name: string;
  platform: string;
  platform_id: string;
  price: number;
  mrp: number | null;
  rating: number;
  delivery_time_min: number;
  image_url: string;
  is_veg: boolean;
  deep_link: string;
  last_updated: string;
}

export interface ComparisonSearchResult {
  success: boolean;
  data: ComparisonProduct[];
  error?: string;
  synced?: number;
  created?: number;
  updated?: number;
  /** Which scrapers contributed / failed for this request. */
  platforms?: {
    succeeded: string[];
    failed: Array<{ platform: string; error: string }>;
  };
}

export interface PriceHistoryEntry {
  id: string;
  price: number;
  mrp: number | null;
  rating: number;
  delivery_time_min: number | null;
  fetched_at: string;
  location_name: string | null;
}

export interface ProductDetails {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  description: string | null;
  platforms: Array<{
    platform: string;
    platform_display_name: string;
    platform_product_id: string;
    deep_link: string | null;
    image_url: string | null;
    latest_price: number | null;
    mrp: number | null;
    rating: number;
    delivery_time_min: number | null;
    last_updated: string | null;
  }>;
  price_history: PriceHistoryEntry[];
}

export interface ProductDetailsResult {
  success: boolean;
  data: ProductDetails | null;
  error?: string;
}
