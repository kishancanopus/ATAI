/**
 * Keyword Planner → Alibaba product matching (consolidated table).
 * Scoped to the same root execution pool; exact keyword first, then title overlap.
 */

export type AlibabaProductRow = Record<string, unknown>;

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
  amazonTitle?: string
): AlibabaProductRow | null {
  if (!scopedRows?.length) return null;

  const kwNorm = normalizeText(variantKeyword);
  if (kwNorm) {
    const exact = scopedRows.find((row) => normalizeText(row.keyword) === kwNorm);
    if (exact) return exact;
  }

  const kwWords = tokenize(variantKeyword);
  if (kwWords.length > 0) {
    let best: AlibabaProductRow | null = null;
    let bestScore = 0;
    for (const row of scopedRows) {
      const title = normalizeText(row.title ?? '');
      if (!title) continue;
      const hits = kwWords.filter((w) => title.includes(w)).length;
      const ratio = hits / kwWords.length;
      if (ratio >= TITLE_MIN_RATIO && hits > bestScore) {
        bestScore = hits;
        best = row;
      }
    }
    if (best) return best;
  }

  if (amazonTitle) {
    const amzWords = tokenize(amazonTitle);
    if (amzWords.length > 0) {
      let best: AlibabaProductRow | null = null;
      let bestScore = 0;
      for (const row of scopedRows) {
        const title = normalizeText(row.title ?? '');
        if (!title) continue;
        const hits = amzWords.filter((w) => title.includes(w)).length;
        const ratio = hits / amzWords.length;
        if (ratio >= TITLE_MIN_RATIO && hits > bestScore) {
          bestScore = hits;
          best = row;
        }
      }
      if (best) return best;
    }
  }

  return null;
}
