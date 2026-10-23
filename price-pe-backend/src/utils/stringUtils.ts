/** Only drop true stop-words — keep brand words like "blues", "corner", "cafe". */
const FILLER_WORDS = new Set([
  'the',
  'and',
  'a',
  'an',
  'of',
  'at',
  'in',
  'on',
  'for',
  'to',
  'restaurant',
  'restaurants',
]);

/**
 * Lowercase, strip special chars, collapse whitespace, drop filler words.
 */
export function normalizeText(text: string): string {
  if (!text) {
    return '';
  }

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0 && !FILLER_WORDS.has(word))
    .join(' ');
}

/**
 * Extract the first number from a string.
 * Examples: "₹600 for one" → 600, "30-40 mins" → 30
 */
export function extractNumber(text: string): number | null {
  if (!text) {
    return null;
  }

  const match = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }

  return dp[n];
}

/**
 * Similarity score in [0, 1] based on normalized Levenshtein distance.
 * 1.0 = identical, 0.0 = completely different.
 */
export function similarity(a: string, b: string): number {
  const left = normalizeText(a);
  const right = normalizeText(b);

  if (!left && !right) {
    return 1;
  }
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }

  const distance = levenshtein(left, right);
  const maxLen = Math.max(left.length, right.length);
  return Math.max(0, 1 - distance / maxLen);
}
