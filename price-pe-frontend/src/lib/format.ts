import type { ComparisonProduct } from '../types';

export function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '—';
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatRating(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '—';
  }
  return value.toFixed(1);
}

export function platformLabel(platform: string): string {
  const key = platform.toLowerCase();
  if (key === 'zomato') return 'Zomato';
  if (key === 'swiggy') return 'Swiggy';
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

export function sortByPrice(items: ComparisonProduct[]): ComparisonProduct[] {
  return [...items].sort((a, b) => {
    const ap = a.price > 0 ? a.price : Number.POSITIVE_INFINITY;
    const bp = b.price > 0 ? b.price : Number.POSITIVE_INFINITY;
    return ap - bp;
  });
}

export function cheapestOnPlatform(
  items: ComparisonProduct[],
  platform: string
): ComparisonProduct | null {
  const filtered = items.filter(
    (item) => item.platform.toLowerCase() === platform.toLowerCase() && item.price > 0
  );
  if (filtered.length === 0) return null;
  return sortByPrice(filtered)[0] ?? null;
}
