export interface ScraperResult<T> {
  success: boolean;
  data: T;
  error?: string;
}

/** Dish-level result shared by Zomato / Swiggy scrapers. */
export interface PlatformSearchItem {
  dish_name: string;
  restaurant_name: string;
  restaurant_id: string;
  price: number;
  rating: number;
  delivery_time_min: number;
  image_url: string;
  is_veg: boolean;
  deep_link: string;
}

/** @deprecated Prefer PlatformSearchItem — kept for existing Zomato call sites. */
export type ZomatoSearchItem = PlatformSearchItem;

/** Dish-level result from Swiggy `/search?query=` (Dishes tab). */
export type SwiggySearchItem = PlatformSearchItem;

export interface PlatformMenuItem {
  name: string;
  price: number;
  description?: string;
  is_veg: boolean;
  image_url?: string;
  category?: string;
}

/** @deprecated Prefer PlatformMenuItem */
export type ZomatoMenuItem = PlatformMenuItem & {
  description: string;
  image_url: string;
  category: string;
};

export type SearchItemsResult = ScraperResult<PlatformSearchItem[]>;
export type RestaurantMenuResult = ScraperResult<PlatformMenuItem[]>;
