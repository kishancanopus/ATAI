export const DEFAULT_RESULTS_CAP = 10;
export const DEFAULT_VARIANT_LIMIT = 10;
export const MAX_VARIANT_LIMIT = 30;
/** Max parallel category Step Function executions while batching variants */
export const MAX_CATEGORY_CONCURRENT_EXECUTIONS = 5;

/** UI `0` means “use the maximum allowed variant count” (30). */
export function resolveVariantLimitMax(val: string | number | undefined | null): number {
  const trimmed = String(val ?? '').trim();
  if (trimmed === '0' || val === 0) return 0;
  const n = typeof val === 'number' ? Math.floor(val) : parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VARIANT_LIMIT;
  return Math.min(n, MAX_VARIANT_LIMIT);
}

/** UI `0` is passed through so AWS Lambdas apply their own size=0 handling. */
export function resolveResultsCap(val: string | number | undefined | null): number {
  const trimmed = String(val ?? '').trim();
  if (trimmed === '0' || val === 0) return 0;
  const n = typeof val === 'number' ? Math.floor(val) : parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RESULTS_CAP;
  return n;
}

export function normalizePresetNumericFields<T extends Record<string, unknown>>(data: T): T {
  return {
    ...data,
    variantLimitMax: data.variantLimitMax != null ? String(data.variantLimitMax) : '',
    resultsCap: data.resultsCap != null ? String(data.resultsCap) : '',
    trendPeriod: data.trendPeriod != null ? String(data.trendPeriod) : '',
    kwpMinSearches: data.kwpMinSearches != null ? String(data.kwpMinSearches) : '',
    kwpMaxSearches: data.kwpMaxSearches != null ? String(data.kwpMaxSearches) : '',
    moq: data.moq != null ? String(data.moq) : '',
    googleTrendScore: Number(data.googleTrendScore) || 0,
    priceMin: Number(data.priceMin) || 0,
    priceMax: Number(data.priceMax) || 0,
    reviewsMin: Number(data.reviewsMin) || 0,
    reviewsMax: Number(data.reviewsMax) || 0,
    ratingFilter: Number(data.ratingFilter) || 0,
    fcl: Number(data.fcl) || 0,
    costBelow: Number(data.costBelow) || 0,
    alibabaRating: Number(data.alibabaRating) || 0,
  };
}
