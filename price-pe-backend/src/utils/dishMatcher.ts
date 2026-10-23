import levenshtein from 'fast-levenshtein';

export interface MenuDishInput {
  name: string;
  platform: string;
  price: number;
  is_veg: boolean;
  image_url?: string;
}

export interface MenuDishVariation {
  platform: string;
  name: string;
  price: number;
  is_veg: boolean;
  image_url?: string;
}

export interface GroupedMenuDish {
  group_name: string;
  variations: MenuDishVariation[];
}

const SIMILARITY_THRESHOLD = 0.75;

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similarity in [0, 1] via normalized Levenshtein distance. */
export function calculateSimilarity(str1: string, str2: string): number {
  const a = normalizeForMatch(str1);
  const b = normalizeForMatch(str2);

  if (!a && !b) {
    return 1;
  }
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }

  const distance = levenshtein.get(a, b);
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) {
    return 1;
  }

  return Math.max(0, 1 - distance / maxLength);
}

export function groupSimilarDishes(dishes: MenuDishInput[]): GroupedMenuDish[] {
  const groups: GroupedMenuDish[] = [];

  for (const dish of dishes) {
    const variation: MenuDishVariation = {
      platform: dish.platform,
      name: dish.name,
      price: dish.price,
      is_veg: dish.is_veg,
      ...(dish.image_url ? { image_url: dish.image_url } : {}),
    };

    let matched: GroupedMenuDish | undefined;
    for (const group of groups) {
      if (calculateSimilarity(dish.name, group.group_name) >= SIMILARITY_THRESHOLD) {
        matched = group;
        break;
      }
    }

    if (matched) {
      matched.variations.push(variation);
    } else {
      groups.push({
        group_name: dish.name,
        variations: [variation],
      });
    }
  }

  for (const group of groups) {
    group.variations.sort((a, b) => a.price - b.price);
  }

  groups.sort((a, b) => {
    const minA = Math.min(...a.variations.map((v) => v.price));
    const minB = Math.min(...b.variations.map((v) => v.price));
    return minA - minB;
  });

  return groups;
}
