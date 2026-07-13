/**
 * Keyword Planner → Alibaba product matching (consolidated table).
 * Scoped to the same root execution pool.
 *
 * When Amazon is active and a product title is available:
 *   1) Alibaba title overlap with Amazon title (40%)
 *   2) Exact keyword match
 *   3) Alibaba title overlap with KWP keyword (40%)
 *
 * When Amazon is off or has no matched product:
 *   1) Exact keyword match
 *   2) Alibaba title overlap with KWP keyword (40%)
 */

export type AlibabaProductRow = Record<string, unknown>;

export type AlibabaMatchOptions = {
  amazonTitle?: string;
  /** Amazon filters on and a matched Amazon product exists */
  useAmazonTitleFirst?: boolean;
  /** Alibaba marketplace stage enabled in search filters */
  alibabaEnabled?: boolean;
};

export type AlibabaMatchResult = {
  row: AlibabaProductRow | null;
  diagnosticReason: string;
};

const TITLE_MIN_RATIO = 0.4;

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value).split(' ').filter((w) => w.length > 2);
}

function matchExactKeyword(
  variantKeyword: string,
  scopedRows: AlibabaProductRow[]
): AlibabaProductRow | null {
  const kwNorm = normalizeText(variantKeyword);
  if (!kwNorm) return null;
  return scopedRows.find((row) => normalizeText(row.keyword) === kwNorm) ?? null;
}

function matchTitleOverlap(
  referenceText: string,
  scopedRows: AlibabaProductRow[]
): AlibabaProductRow | null {
  const words = tokenize(referenceText);
  if (words.length === 0) return null;

  let best: AlibabaProductRow | null = null;
  let bestScore = 0;

  for (const row of scopedRows) {
    const title = normalizeText(row.title ?? '');
    if (!title) continue;
    const hits = words.filter((w) => title.includes(w)).length;
    const ratio = hits / words.length;
    if (ratio >= TITLE_MIN_RATIO && hits > bestScore) {
      bestScore = hits;
      best = row;
    }
  }

  return best;
}

export function groupAlibabaByRoot(
  rows: AlibabaProductRow[],
  kwpRootKeys?: Set<string>
): Map<string, AlibabaProductRow[]> {
  const m = new Map<string, AlibabaProductRow[]>();
  const append = (key: string, row: AlibabaProductRow) => {
    if (!key) return;
    if (!m.has(key)) m.set(key, []);
    const bucket = m.get(key)!;
    if (!bucket.includes(row)) bucket.push(row);
  };

  for (const r of rows) {
    const kw = normalizeText(r.keyword);
    const root = normalizeText(r.root_keyword);
    const searchCat = normalizeText(r.search_category);
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

export function matchAlibabaForKwpKeyword(
  variantKeyword: string,
  scopedRows: AlibabaProductRow[] | undefined,
  options?: AlibabaMatchOptions | string
): AlibabaMatchResult {
  const opts: AlibabaMatchOptions =
    typeof options === 'string' ? { amazonTitle: options } : (options ?? {});
  const { amazonTitle, useAmazonTitleFirst = false, alibabaEnabled = true } = opts;

  if (!alibabaEnabled) {
    return { row: null, diagnosticReason: 'Alibaba stage disabled in filters' };
  }

  if (!scopedRows?.length) {
    return { row: null, diagnosticReason: 'No Alibaba products in execution pool' };
  }

  if (useAmazonTitleFirst && amazonTitle) {
    const byAmazon = matchTitleOverlap(amazonTitle, scopedRows);
    if (byAmazon) {
      return { row: byAmazon, diagnosticReason: 'Matched via Amazon title overlap (≥40%)' };
    }
  }

  const exact = matchExactKeyword(variantKeyword, scopedRows);
  if (exact) {
    return { row: exact, diagnosticReason: 'Matched via exact keyword' };
  }

  const byKeyword = matchTitleOverlap(variantKeyword, scopedRows);
  if (byKeyword) {
    return {
      row: byKeyword,
      diagnosticReason: useAmazonTitleFirst && amazonTitle
        ? 'Matched via keyword title overlap (≥40%) after Amazon title pass'
        : 'Matched via keyword title overlap (≥40%)',
    };
  }

  if (useAmazonTitleFirst && amazonTitle) {
    return {
      row: null,
      diagnosticReason: 'No Amazon title, exact keyword, or keyword title overlap match (≥40%)',
    };
  }

  return {
    row: null,
    diagnosticReason: 'No exact keyword or keyword title overlap match (≥40%)',
  };
}
