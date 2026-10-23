/**
 * Parse a price string into a numeric amount.
 * Examples: "₹199", "Rs. 249", "199 for two" → 199
 */
export function extractPrice(text: string): number {
  if (!text) {
    return 0;
  }

  const normalized = text.replace(/,/g, '');
  const match = normalized.match(/(?:₹|rs\.?\s*)?\s*(\d+(?:\.\d+)?)/i);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Parse a rating string into a float.
 * Examples: "4.2 ★", "4.5", "Rated 3.8" → 4.2 / 4.5 / 3.8
 */
export function extractRating(text: string): number {
  if (!text) {
    return 0;
  }

  const match = text.match(/(\d(?:\.\d)?)/);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > 5) {
    return 0;
  }

  return value;
}

/**
 * Parse a delivery-time range into a single representative minute value.
 * Examples: "30-40 mins" → 35, "25 min" → 25
 */
export function extractDeliveryTime(text: string): number {
  if (!text) {
    return 0;
  }

  const range = text.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      return Math.round((low + high) / 2);
    }
  }

  const single = text.match(/(\d+)\s*(?:min|mins|minute|minutes)?/i);
  if (single) {
    const value = Number(single[1]);
    return Number.isFinite(value) ? value : 0;
  }

  return 0;
}

/**
 * Collapse whitespace and strip control / zero-width characters.
 */
export function cleanText(text: string): string {
  if (!text) {
    return '';
  }

  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Async sleep helper used to mimic human pacing between scraper actions.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
