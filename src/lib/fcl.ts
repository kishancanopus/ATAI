/**
 * FCL (Local Competition Factor) estimated local selling price.
 *
 * estimated_local_price = amazon_price_usd × (1 − fcl_percentage)
 *
 * fcl_percentage is the slider value 0–1 (e.g. 0.25 = 25% competitive discount).
 */
export function computeEstimatedLocalPrice(
  amazonPriceUsd: number,
  fclPercentage: number
): number | null {
  if (!Number.isFinite(amazonPriceUsd) || amazonPriceUsd <= 0) return null;
  if (!Number.isFinite(fclPercentage) || fclPercentage <= 0) return null;

  const pct = Math.min(Math.max(fclPercentage, 0), 1);
  return Math.round(amazonPriceUsd * (1 - pct) * 100) / 100;
}
