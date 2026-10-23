export interface RestaurantListing {
  restaurant_name: string;
  cuisine: string;
  rating: number;
  delivery_time_min: number;
  image_url: string;
  available_platforms: string[];
  dish_availability_text: string;
  deep_link: string;
}

export interface RestaurantListingResult {
  success: boolean;
  data: RestaurantListing[];
  error?: string;
  platforms?: {
    succeeded: string[];
    failed: Array<{ platform: string; error: string }>;
  };
}

export interface MenuComparisonVariation {
  platform: string;
  name: string;
  price: number;
  is_veg: boolean;
  image_url?: string;
}

export interface MenuComparisonGroup {
  group_name: string;
  variations: MenuComparisonVariation[];
}

export interface MenuComparisonResult {
  success: boolean;
  data: {
    grouped_dishes: MenuComparisonGroup[];
  };
  error?: string;
}
