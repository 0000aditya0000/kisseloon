export interface ComparisonProduct {
  id: string;
  name: string;
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

export interface SearchMeta {
  synced?: number;
  created?: number;
  updated?: number;
  location?: string;
  query?: string;
  platforms?: {
    succeeded: string[];
    failed: Array<{ platform: string; error: string }>;
  };
}

export interface SearchResponse {
  success: boolean;
  data: ComparisonProduct[];
  error?: string;
  meta?: SearchMeta;
}

export interface UserLocation {
  /** City slug sent to the API (e.g. bangalore, noida) */
  citySlug: string;
  /** Human label for the UI */
  label: string;
  source: 'gps' | 'manual' | 'fallback';
}
