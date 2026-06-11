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
 * At each category level, pick the highest-scoring organic listing
 * (reviews, rating, BSR, sales). Sponsored listings are excluded.
 */

export type AmazonProductRow = Record<string, unknown>;

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

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
 *
 * 1 word  → ["baby"]
 * 2 words → ["baby toys"]
 * 3+ words → full phrase, then drop leading words to reach parent categories:
 *   "electric breast pump" → ["electric breast pump", "breast pump", "pump"]
 */
export function buildAmazonCategoryLevels(keyword: string): string[] {
  const words = tokenizeKeyword(keyword);
  if (words.length === 0) return [];
  if (words.length === 1) return [words[0]];
  if (words.length === 2) return [words.join(' ')];

  const levels: string[] = [];
  // Most specific subcategory
  levels.push(words.join(' '));

  // Walk up: drop leading modifier words until a 2-word parent remains
  for (let start = 1; start <= words.length - 2; start += 1) {
    levels.push(words.slice(start).join(' '));
  }

  // 1-word broad category (final hierarchy fallback for long phrases)
  levels.push(words[words.length - 1]);

  return [...new Set(levels)];
}

/**
 * Levels from retailer-stripped core first, then full phrase if different.
 */
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

/**
 * Higher = better organic market signal (reviews, rating, lower BSR, sales).
 * Returns -1 for sponsored listings.
 */
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
    return levelWords.every((w) => cat.includes(w));
  });
}

function titleMatchesLevel(row: AmazonProductRow, levelPhrase: string): boolean {
  const title = normalizeText(row.title ?? row.product_title ?? '');
  if (!title) return false;

  const levelNorm = normalizeText(levelPhrase);
  if (title.includes(levelNorm)) return true;

  const levelWords = levelNorm.split(' ').filter((w) => w.length > 1);
  if (levelWords.length === 0) return false;
  return levelWords.every((w) => title.includes(w));
}

export function getAmazonRowAsin(row: AmazonProductRow): string | null {
  const asin = row.a_sin ?? row.asin;
  if (asin == null || asin === '') return null;
  return String(asin).trim().toUpperCase();
}

/** 0–100 title overlap — used only as a tiebreaker within a category level */
export function scoreTitleRelevance(kwpKeyword: string, row: AmazonProductRow): number {
  const title = normalizeText(row.title ?? row.product_title ?? '');
  const kwNorm = normalizeText(stripRetailerNoise(kwpKeyword));
  if (!title || !kwNorm) return 0;
  if (title.includes(kwNorm)) return 100;

  const words = kwNorm.split(' ').filter((w) => w.length > 1);
  if (words.length === 0) return 0;
  const hits = words.filter((w) => title.includes(w)).length;
  return Math.round((hits / words.length) * 85);
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

/** Best organic performer at a category level; title relevance breaks ties only */
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

/**
 * Match one Keyword Planner row to the best Amazon product.
 *
 * Pass order (category-first):
 * 1. Category field match at each level (specific → parent → broad)
 * 2. Title match at each level (when category metadata is missing)
 * 3. Exact keyword field match on the search keyword
 */
export function matchAmazonForKwpKeyword(
  kwpKeyword: string,
  allAmazonRows: AmazonProductRow[],
  scopedAmazonRows?: AmazonProductRow[],
  excludeAsins?: Set<string>
): AmazonProductRow | null {
  if (!kwpKeyword.trim()) return null;

  const candidates = buildCandidatePool(allAmazonRows, scopedAmazonRows, excludeAsins);
  if (!candidates.length) return null;

  const levels = buildAllMatchLevels(kwpKeyword);
  const kwNorm = normalizeText(kwpKeyword);

  // Pass 1: category / subcategory match — most specific level first
  for (const level of levels) {
    const hits = candidates.filter((row) =>
      categoryMatchesLevel(getProductCategoryTexts(row), level)
    );
    const best = pickBestPerformer(hits, kwpKeyword);
    if (best) return best;
  }

  // Pass 2: title match at each category level (products without category fields)
  for (const level of levels) {
    const hits = candidates.filter((row) => titleMatchesLevel(row, level));
    const best = pickBestPerformer(hits, kwpKeyword);
    if (best) return best;
  }

  // Pass 3: exact keyword field match on the KWP phrase
  const exactHits = candidates.filter(
    (row) => normalizeText(row.keyword ?? row.sub_keyword ?? '') === kwNorm
  );
  const exactBest = pickBestPerformer(exactHits, kwpKeyword);
  if (exactBest) return exactBest;

  return null;
}
