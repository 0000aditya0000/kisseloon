export interface ApiError extends Error {
  statusCode?: number;
  details?: unknown;
}
