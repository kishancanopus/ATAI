/**
 * Keyword Planner → Amazon product matching (consolidated table).
 *
 * Category strategy by keyword word count:
 * - 1 word  ("Baby")           → broad Amazon category → best organic product
 * - 2 words ("Baby Toys")      → specific Amazon category → best organic product
 * - 3+ words ("Electric Breast Pump")
 *     → most specific subcategory first ("electric breast pump")
 *     → walk up one level by dropping leading modifiers ("breast pump")
 *     → then 1-word broad fallback if needed
 *
 * Consolidation uses two phases:
 * - Phase A (strict): category → title → partial title → exact keyword
 * - Phase B (fallback): unused root-pool products above similarity threshold
 *
 * At each level, pick the highest-scoring organic listing
 * (reviews, rating, BSR, sales). Sponsored listings are excluded.
 */

export type AmazonProductRow = Record<string, unknown>;

export type AmazonMatchType =
  | 'category'
  | 'title'
  | 'partial_title'
  | 'keyword'
  | 'fallback'
  | 'none';

export type AmazonMatchResult = {
  row: AmazonProductRow;
  matchType: AmazonMatchType;
};

export type KwpSeedInput = {
  /** Stable key for the KWP row (root::variant) */
  key: string;
  keyword: string;
  rootKeyword: string;
  searchVolume?: number;
};

const CATEGORY_FIELDS = [
  'category_leaf',
  'category',
  'search_category',
  'amazon_category',
  'subcategory',
  'category_path',
  'browse_node',
  'full_category',
] as const;

const SPONSORED_TRUTHY = new Set(['true', '1', 'yes']);

/** Title relevance weight when breaking ties within the same category level */
const TITLE_TIEBREAKER_WEIGHT = 0.08;

/** Minimum title/category similarity (0–100) for root-pool fallback */
export const ROOT_POOL_FALLBACK_MIN_SCORE = 40;

/** Minimum share of variant tokens that must appear in title for partial-title pass */
export const PARTIAL_TITLE_MIN_RATIO = 0.6;

/** Tokens too generic to count as the sole overlap signal */
const GENERIC_MATCH_TOKENS = new Set([
  'baby', 'new', 'best', 'top', 'set', 'kit', 'pack', 'with', 'for', 'and',
  'the', 'pro', 'plus', 'mini', 'large', 'small', 'free', 'premium', 'ultra',
  'home', 'portable', 'wireless', 'smart', 'easy', 'safe', 'soft', 'cute',
]);

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Light plural normalization: strollers → stroller */
function stemToken(word: string): string {
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

function tokenMatchesInText(token: string, text: string): boolean {
  if (!token || !text) return false;
  if (text.includes(token)) return true;
  const stemmed = stemToken(token);
  return stemmed !== token && text.includes(stemmed);
}

/** Significant tokens (length > 1) for matching */
export function tokenizeKeyword(keyword: string): string[] {
  return normalizeText(keyword).split(' ').filter((w) => w.length > 1);
}

/**
 * Retailers and noise tokens stripped before category matching.
 * "Walmart Cribs" → "cribs", "Carters Baby Clothes" → "baby clothes"
 */
const RETAILER_NOISE_TOKENS = new Set([
  'walmart', 'target', 'costco', 'sam', 'sams', 'bjs', 'kmart', 'sears',
  'kohls', 'jcpenney', 'macys', 'nordstrom', 'marshalls', 'tjmaxx',
  'homegoods', 'homesense', 'ross',
  'babylist', 'buybuybaby', 'buybuy', 'carters', 'oshkosh',
  'wayfair', 'ikea', 'pottery', 'barn', 'west', 'elm', 'crate', 'barrel',
  'overstock', 'cb2', 'restoration', 'hardware',
  'bestbuy', 'best', 'buy', 'staples', 'officedepot', 'costplus',
  'worldmarket', 'world', 'market',
  'amazon', 'ebay', 'etsy', 'chewy', 'zappos', 'jet',
  'walgreens', 'cvs', 'rite', 'aid', 'kroger', 'safeway',
  'cheap', 'cheapest', 'discount', 'deals', 'sale', 'clearance',
  'shop', 'shopping', 'store', 'stores', 'online',
  'near', 'me', 'local',
]);

export function stripRetailerNoise(keyword: string): string {
  const tokens = tokenizeKeyword(keyword);
  const core = tokens.filter((w) => !RETAILER_NOISE_TOKENS.has(w));
  return core.length > 0 ? core.join(' ') : tokens.join(' ');
}

/**
 * Category levels to try, most specific first.
 */
export function buildAmazonCategoryLevels(keyword: string): string[] {
  const words = tokenizeKeyword(keyword);
  if (words.length === 0) return [];
  if (words.length === 1) return [words[0]];
  if (words.length === 2) return [words.join(' ')];

  const levels: string[] = [];
  levels.push(words.join(' '));

  for (let start = 1; start <= words.length - 2; start += 1) {
    levels.push(words.slice(start).join(' '));
  }

  levels.push(words[words.length - 1]);

  return [...new Set(levels)];
}

export function buildAllMatchLevels(keyword: string): string[] {
  const core = stripRetailerNoise(keyword);
  const coreLevels = buildAmazonCategoryLevels(core);

  const full = tokenizeKeyword(keyword).join(' ');
  const fullLevels = full !== core ? buildAmazonCategoryLevels(full) : [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const l of [...coreLevels, ...fullLevels]) {
    if (!seen.has(l)) {
      seen.add(l);
      result.push(l);
    }
  }
  return result;
}

function splitCategoryPath(raw: string): string[] {
  return raw
    .split(/>|\/|\\|\|/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

/** All normalized category labels attached to a product row */
export function getProductCategoryTexts(row: AmazonProductRow): string[] {
  const texts = new Set<string>();

  for (const field of CATEGORY_FIELDS) {
    const raw = row[field];
    if (raw == null || raw === '') continue;

    if (typeof raw === 'string') {
      const normalized = normalizeText(raw);
      if (normalized) texts.add(normalized);
      if (/[>|/\\|]/.test(raw)) {
        for (const part of splitCategoryPath(raw)) {
          texts.add(part);
        }
      }
    }
  }

  return [...texts];
}

export function isSponsoredAmazonRow(row: AmazonProductRow): boolean {
  for (const key of ['is_sponsored', 'sponsored', 'is_ad', 'ad']) {
    const v = row[key];
    if (v === true || v === 1) return true;
    if (typeof v === 'string' && SPONSORED_TRUTHY.has(v.toLowerCase())) return true;
  }

  const listing = normalizeText(row.listing_type ?? row.result_type ?? row.placement ?? '');
  return listing.includes('sponsored') || listing === 'ad';
}

export function parseBestsellerRank(rank: unknown): number {
  if (typeof rank === 'number' && Number.isFinite(rank) && rank > 0) return rank;
  const s = String(rank ?? '');
  const match = s.match(/#?\s*([\d,]+)/);
  if (match) {
    const n = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Number.POSITIVE_INFINITY;
}

export function amazonOrganicPerformanceScore(row: AmazonProductRow): number {
  if (isSponsoredAmazonRow(row)) return -1;

  const reviews = Number(row.reviews_count ?? row.review_count ?? 0);
  const rating = Number(row.rating ?? row.star_rating ?? 0);
  const bsr = parseBestsellerRank(row.bestseller_rank ?? row.bsr ?? row.best_seller_rank);
  const sales = Number(row.estimated_monthly_sales ?? row.monthly_sales ?? row.units_sold ?? 0);

  const reviewScore = Math.log10(Math.max(reviews, 0) + 1) * 22;
  const ratingScore = (Math.min(Math.max(rating, 0), 5) / 5) * 28;
  const bsrScore =
    Number.isFinite(bsr) && bsr < Number.POSITIVE_INFINITY
      ? Math.max(0, 35 - Math.log10(bsr + 1) * 9)
      : 8;
  const salesScore = sales > 0 ? Math.log10(sales + 1) * 15 : 0;

  return reviewScore + ratingScore + bsrScore + salesScore;
}

function categoryMatchesLevel(categoryTexts: string[], levelPhrase: string): boolean {
  const levelNorm = normalizeText(levelPhrase);
  if (!levelNorm) return false;

  const levelWords = levelNorm.split(' ').filter((w) => w.length > 1);
  if (levelWords.length === 0) return false;

  return categoryTexts.some((cat) => {
    if (cat.includes(levelNorm) || levelNorm.includes(cat)) return true;
    return levelWords.every((w) => tokenMatchesInText(w, cat));
  });
}

function titleMatchesLevel(row: AmazonProductRow, levelPhrase: string): boolean {
  const title = normalizeText(row.title ?? row.product_title ?? '');
  if (!title) return false;

  const levelNorm = normalizeText(levelPhrase);
  if (title.includes(levelNorm)) return true;

  const levelWords = levelNorm.split(' ').filter((w) => w.length > 1);
  if (levelWords.length === 0) return false;
  return levelWords.every((w) => tokenMatchesInText(w, title));
}

/** ≥60% of variant tokens in title, with at least one non-generic token hit */
export function partialTitleMatches(kwpKeyword: string, row: AmazonProductRow): boolean {
  const title = normalizeText(row.title ?? row.product_title ?? '');
  if (!title) return false;

  const words = tokenizeKeyword(stripRetailerNoise(kwpKeyword));
  if (words.length < 2) return false;

  const hits = words.filter((w) => tokenMatchesInText(w, title)).length;
  if (hits / words.length < PARTIAL_TITLE_MIN_RATIO) return false;

  const significantHits = words.filter(
    (w) => !GENERIC_MATCH_TOKENS.has(w) && tokenMatchesInText(w, title)
  );
  return significantHits.length >= 1;
}

function hasSignificantTokenOverlap(kwpKeyword: string, row: AmazonProductRow): boolean {
  const words = tokenizeKeyword(stripRetailerNoise(kwpKeyword));
  const title = normalizeText(row.title ?? row.product_title ?? '');
  const categories = getProductCategoryTexts(row).join(' ');
  const haystack = `${title} ${categories}`;

  return words.some(
    (w) => !GENERIC_MATCH_TOKENS.has(w) && tokenMatchesInText(w, haystack)
  );
}

export function getAmazonRowAsin(row: AmazonProductRow): string | null {
  const asin = row.a_sin ?? row.asin;
  if (asin == null || asin === '') return null;
  return String(asin).trim().toUpperCase();
}

export function scoreTitleRelevance(kwpKeyword: string, row: AmazonProductRow): number {
  const title = normalizeText(row.title ?? row.product_title ?? '');
  const kwNorm = normalizeText(stripRetailerNoise(kwpKeyword));
  if (!title || !kwNorm) return 0;
  if (title.includes(kwNorm)) return 100;

  const words = kwNorm.split(' ').filter((w) => w.length > 1);
  if (words.length === 0) return 0;
  const hits = words.filter((w) => tokenMatchesInText(w, title)).length;
  return Math.round((hits / words.length) * 85);
}

export function scoreCategoryRelevance(kwpKeyword: string, row: AmazonProductRow): number {
  const kwWords = tokenizeKeyword(stripRetailerNoise(kwpKeyword));
  if (kwWords.length === 0) return 0;

  const categories = getProductCategoryTexts(row);
  if (categories.length === 0) return 0;

  let best = 0;
  for (const cat of categories) {
    const hits = kwWords.filter((w) => tokenMatchesInText(w, cat)).length;
    best = Math.max(best, Math.round((hits / kwWords.length) * 100));
  }
  return best;
}

export function scoreRootPoolSimilarity(kwpKeyword: string, row: AmazonProductRow): number {
  return Math.max(
    scoreTitleRelevance(kwpKeyword, row),
    scoreCategoryRelevance(kwpKeyword, row)
  );
}

function filterExcludedAsins(
  rows: AmazonProductRow[],
  excludeAsins?: Set<string>
): AmazonProductRow[] {
  if (!excludeAsins?.size) return rows;
  return rows.filter((row) => {
    const asin = getAmazonRowAsin(row);
    return !asin || !excludeAsins.has(asin);
  });
}

function pickBestPerformer(rows: AmazonProductRow[], kwpKeyword?: string): AmazonProductRow | null {
  if (rows.length === 0) return null;

  let best: AmazonProductRow | null = null;
  let bestCombined = -1;

  for (const row of rows) {
    const organic = amazonOrganicPerformanceScore(row);
    if (organic < 0) continue;
    const tiebreak = kwpKeyword ? scoreTitleRelevance(kwpKeyword, row) * TITLE_TIEBREAKER_WEIGHT : 0;
    const combined = organic + tiebreak;
    if (combined > bestCombined) {
      best = row;
      bestCombined = combined;
    }
  }

  return best;
}

function buildScopedUnusedPool(
  scopedAmazonRows: AmazonProductRow[] | undefined,
  excludeAsins?: Set<string>
): AmazonProductRow[] {
  if (!scopedAmazonRows?.length) return [];
  return filterExcludedAsins(filterOrganicPreferring(scopedAmazonRows), excludeAsins);
}

function pickBestSimilarRootFallback(
  rows: AmazonProductRow[],
  kwpKeyword: string,
  minScore: number = ROOT_POOL_FALLBACK_MIN_SCORE
): AmazonProductRow | null {
  const scored = rows
    .map((row) => ({ row, similarity: scoreRootPoolSimilarity(kwpKeyword, row) }))
    .filter(
      (x) =>
        x.similarity >= minScore && hasSignificantTokenOverlap(kwpKeyword, x.row)
    )
    .sort((a, b) => b.similarity - a.similarity);

  if (scored.length === 0) return null;

  const topSimilarity = scored[0].similarity;
  const topTier = scored
    .filter((x) => x.similarity === topSimilarity)
    .map((x) => x.row);

  return pickBestPerformer(topTier, kwpKeyword);
}

function filterOrganicPreferring(rows: AmazonProductRow[]): AmazonProductRow[] {
  const organic = rows.filter((r) => !isSponsoredAmazonRow(r));
  return organic.length > 0 ? organic : rows;
}

function buildCandidatePool(
  allAmazonRows: AmazonProductRow[],
  scopedAmazonRows: AmazonProductRow[] | undefined,
  excludeAsins?: Set<string>
): AmazonProductRow[] {
  const scoped = scopedAmazonRows?.length ? scopedAmazonRows : [];
  const primary = filterExcludedAsins(
    filterOrganicPreferring(scoped.length > 0 ? scoped : allAmazonRows),
    excludeAsins
  );
  if (primary.length > 0) return primary;

  if (scoped.length > 0) {
    const widened = filterExcludedAsins(filterOrganicPreferring(allAmazonRows), excludeAsins);
    if (widened.length > 0) return widened;
  }

  return [];
}

type MatchPhase = 'strict' | 'fallback' | 'all';

function matchAmazonInternal(
  kwpKeyword: string,
  allAmazonRows: AmazonProductRow[],
  scopedAmazonRows: AmazonProductRow[] | undefined,
  excludeAsins: Set<string> | undefined,
  phase: MatchPhase
): AmazonMatchResult | null {
  if (!kwpKeyword.trim()) return null;

  if (phase === 'strict' || phase === 'all') {
    const candidates = buildCandidatePool(allAmazonRows, scopedAmazonRows, excludeAsins);
    if (candidates.length) {
      const levels = buildAllMatchLevels(kwpKeyword);
      const kwNorm = normalizeText(kwpKeyword);

      for (const level of levels) {
        const hits = candidates.filter((row) =>
          categoryMatchesLevel(getProductCategoryTexts(row), level)
        );
        const best = pickBestPerformer(hits, kwpKeyword);
        if (best) return { row: best, matchType: 'category' };
      }

      for (const level of levels) {
        const hits = candidates.filter((row) => titleMatchesLevel(row, level));
        const best = pickBestPerformer(hits, kwpKeyword);
        if (best) return { row: best, matchType: 'title' };
      }

      const partialHits = candidates.filter((row) => partialTitleMatches(kwpKeyword, row));
      const partialBest = pickBestPerformer(partialHits, kwpKeyword);
      if (partialBest) return { row: partialBest, matchType: 'partial_title' };

      const exactHits = candidates.filter(
        (row) => normalizeText(row.keyword ?? row.sub_keyword ?? '') === kwNorm
      );
      const exactBest = pickBestPerformer(exactHits, kwpKeyword);
      if (exactBest) return { row: exactBest, matchType: 'keyword' };
    }

    if (phase === 'strict') return null;
  }

  if (phase === 'fallback' || phase === 'all') {
    const scopedUnused = buildScopedUnusedPool(scopedAmazonRows, excludeAsins);
    if (scopedUnused.length > 0) {
      const fallback = pickBestSimilarRootFallback(scopedUnused, kwpKeyword);
      if (fallback) return { row: fallback, matchType: 'fallback' };
    }
  }

  return null;
}

/**
 * Two-phase batch matching for consolidation.
 * Phase A: strict passes for all seeds (volume order) — reserves best strict matches.
 * Phase B: root-pool fallback only for still-unmatched seeds.
 */
export function matchAmazonForKwpSeedsBatch(
  seeds: KwpSeedInput[],
  allAmazonRows: AmazonProductRow[],
  amzByRoot: Map<string, AmazonProductRow[]>
): Map<string, AmazonMatchResult | null> {
  const results = new Map<string, AmazonMatchResult | null>();
  const usedAsins = new Set<string>();

  const ordered = [...seeds].sort(
    (a, b) => Number(b.searchVolume ?? 0) - Number(a.searchVolume ?? 0)
  );

  for (const seed of ordered) {
    const rootKey = seed.rootKeyword.toLowerCase().trim();
    const scopedAmz = amzByRoot.get(rootKey) ?? [];
    const strict = matchAmazonInternal(
      seed.keyword,
      allAmazonRows,
      scopedAmz,
      usedAsins,
      'strict'
    );
    results.set(seed.key, strict);
    const asin = strict ? getAmazonRowAsin(strict.row) : null;
    if (asin) usedAsins.add(asin);
  }

  for (const seed of ordered) {
    if (results.get(seed.key)) continue;

    const rootKey = seed.rootKeyword.toLowerCase().trim();
    const scopedAmz = amzByRoot.get(rootKey) ?? [];
    const fallback = matchAmazonInternal(
      seed.keyword,
      allAmazonRows,
      scopedAmz,
      usedAsins,
      'fallback'
    );
    results.set(seed.key, fallback);
    const asin = fallback ? getAmazonRowAsin(fallback.row) : null;
    if (asin) usedAsins.add(asin);
  }

  return results;
}

/** Human-readable label for consolidated table / exports */
export function formatAmazonMatchType(matchType: AmazonMatchType | undefined): string {
  switch (matchType) {
    case 'category':
      return 'Category';
    case 'title':
      return 'Title';
    case 'partial_title':
      return 'Partial title';
    case 'keyword':
      return 'Keyword';
    case 'fallback':
      return 'Root fallback';
    default:
      return '-';
  }
}

/**
 * Match one Keyword Planner row (all phases in one call — prefer batch for consolidation).
 */
export function matchAmazonForKwpKeyword(
  kwpKeyword: string,
  allAmazonRows: AmazonProductRow[],
  scopedAmazonRows?: AmazonProductRow[],
  excludeAsins?: Set<string>
): AmazonProductRow | null {
  const strict = matchAmazonInternal(
    kwpKeyword,
    allAmazonRows,
    scopedAmazonRows,
    excludeAsins,
    'strict'
  );
  if (strict) return strict.row;

  const fallback = matchAmazonInternal(
    kwpKeyword,
    allAmazonRows,
    scopedAmazonRows,
    excludeAsins,
    'fallback'
  );
  return fallback?.row ?? null;
}

export function matchAmazonForKwpKeywordWithType(
  kwpKeyword: string,
  allAmazonRows: AmazonProductRow[],
  scopedAmazonRows?: AmazonProductRow[],
  excludeAsins?: Set<string>
): AmazonMatchResult | null {
  const strict = matchAmazonInternal(
    kwpKeyword,
    allAmazonRows,
    scopedAmazonRows,
    excludeAsins,
    'strict'
  );
  if (strict) return strict;

  return matchAmazonInternal(
    kwpKeyword,
    allAmazonRows,
    scopedAmazonRows,
    excludeAsins,
    'fallback'
  );
}
