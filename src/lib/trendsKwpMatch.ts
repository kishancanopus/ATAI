/**
 * Keyword Planner → Google Trends matching (consolidated table).
 *
 * Uses exact keyword match only, scoped to the same root execution pool.
 * Substring inheritance (e.g. "buybabylist" → "baby") is intentionally avoided.
 */

export type TrendRow = Record<string, unknown>;

function normalizeKeyword(value: unknown): string {
  return String(value ?? '').toLowerCase().trim();
}

/** Group trend rows under root / keyword keys (same pattern as marketplace scoping). */
export function groupTrendsByRoot(
  rows: TrendRow[],
  kwpRootKeys?: Set<string>
): Map<string, TrendRow[]> {
  const m = new Map<string, TrendRow[]>();
  const append = (key: string, row: TrendRow) => {
    if (!key) return;
    if (!m.has(key)) m.set(key, []);
    const bucket = m.get(key)!;
    if (!bucket.includes(row)) bucket.push(row);
  };

  for (const r of rows) {
    const kw = normalizeKeyword(r.keyword);
    const root = normalizeKeyword(r.root_keyword);
    const searchCat = normalizeKeyword(r.search_category);
    append(kw, r);
    append(root, r);
    append(searchCat, r);
    if (kwpRootKeys) {
      for (const rk of kwpRootKeys) {
        if (kw === rk || (kw && rk && (kw.startsWith(`${rk} `) || rk.startsWith(`${kw} `)))) {
          append(rk, r);
        }
      }
    }
  }

  return m;
}

/**
 * Match one KWP variant to its Google Trends row.
 * Exact keyword match within the root-scoped pool only.
 */
export function matchTrendForKwpKeyword(
  variantKeyword: string,
  scopedTrendRows: TrendRow[] | undefined
): TrendRow | null {
  const kwNorm = normalizeKeyword(variantKeyword);
  if (!kwNorm || !scopedTrendRows?.length) return null;

  return (
    scopedTrendRows.find((row) => normalizeKeyword(row.keyword) === kwNorm) ?? null
  );
}
