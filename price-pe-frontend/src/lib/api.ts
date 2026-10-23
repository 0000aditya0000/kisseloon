import type { SearchResponse } from '../types';

const API_BASE =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ||
  'http://localhost:3000/api/v1';

export async function searchProducts(
  query: string,
  location: string,
  signal?: AbortSignal
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    q: query.trim(),
    location: location.trim(),
  });

  const response = await fetch(`${API_BASE}/products/search?${params}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  const payload = (await response.json().catch(() => null)) as SearchResponse | null;

  if (!payload) {
    throw new Error('Could not read comparison results from the server.');
  }

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Search failed (${response.status})`);
  }

  return payload;
}
