/**
 * Keyword Planner → Amazon product matching.
 *
 * Strategy by keyword word count:
 * - 1 word  → broad Amazon category
 * - 2 words → specific category
 * - 3+ words → most specific subcategory, then walk up to parent categories
 *
 * Within each category level, picks the best organic performer (reviews, rating, BSR).
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
] as const;

const SPONSORED_TRUTHY = new Set(['true', '1', 'yes']);

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
 * Retailers, distributors, and comparison-site brands that carry products
 * but are not themselves product categories on Amazon.
 * Stripped before category matching so "Walmart Cribs" → "Cribs".
 */
const RETAILER_NOISE_TOKENS = new Set([
  // Mass retailers
  'walmart', 'target', 'costco', 'sam', 'sams', 'bjs', 'kmart', 'sears',
  'kohls', 'jcpenney', 'macys', 'nordstrom', 'marshalls', 'tjmaxx',
  'homegoods', 'homesense', 'ross',
  // Baby / kids specialty
  'babylist', 'buybuybaby', 'buybuy', 'carters', 'oshkosh',
  // Home / furniture
  'wayfair', 'ikea', 'pottery', 'barn', 'west', 'elm', 'crate', 'barrel',
  'overstock', 'cb2', 'restoration', 'hardware',
  // Electronics / general
  'bestbuy', 'best', 'buy', 'staples', 'officedepot', 'costplus',
  'worldmarket', 'world', 'market',
  // Online
  'amazon', 'ebay', 'etsy', 'chewy', 'zappos', 'jet',
  // Grocery / pharmacy
  'walmart', 'walgreens', 'cvs', 'rite', 'aid', 'kroger', 'safeway',
  // Comparison / listing intent
  'cheap', 'cheapest', 'discount', 'deals', 'sale', 'clearance',
  'buy', 'shop', 'shopping', 'store', 'stores', 'online',
  'near', 'me', 'local',
]);

/**
 * Strip retailer/noise tokens from the keyword, returning the core product intent.
 * e.g. "Walmart Cribs" → "Cribs", "Target Baby Toys" → "Baby Toys"
 * Falls back to the full tokenized form if stripping empties it.
 */
export function stripRetailerNoise(keyword: string): string {
  const tokens = tokenizeKeyword(keyword);
  const core = tokens.filter((w) => !RETAILER_NOISE_TOKENS.has(w));
  return core.length > 0 ? core.join(' ') : tokens.join(' ');
}

/**
 * Category phrases to try, most specific first.
 * 3+ words: "electric breast pump" → "breast pump" (stops at 2-word parent).
 */
export function buildAmazonCategoryLevels(keyword: string): string[] {
  const words = tokenizeKeyword(keyword);
  if (words.length === 0) return [];
  if (words.length === 1) return [words[0]];
  if (words.length === 2) return [words.join(' ')];

  const levels: string[] = [];
  for (let len = words.length; len >= 2; len -= 1) {
    levels.push(words.slice(0, len).join(' '));
  }
  return levels;
}

/**
 * Build all category level phrases to try:
 * 1. Levels from the retailer-stripped core intent (primary)
 * 2. Levels from the full original keyword (fallback — catches branded products)
 * Deduplicates, preserving order.
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
 * Higher = better organic market signal (reviews, rating, lower BSR).
 * Returns -1 for sponsored listings so they sort last / can be filtered out.
 */
export function amazonOrganicPerformanceScore(row: AmazonProductRow): number {
  if (isSponsoredAmazonRow(row)) return -1;

  const reviews = Number(row.reviews_count ?? row.review_count ?? 0);
  const rating = Number(row.rating ?? row.star_rating ?? 0);
  const bsr = parseBestsellerRank(row.bestseller_rank ?? row.bsr ?? row.best_seller_rank);
  const sales = Number(row.estimated_monthly_sales ?? row.monthly_sales ?? row.units_sold ?? 0);

  const reviewScore = Math.log10(Math.max(reviews, 0) + 1) * 22;
  const ratingScore = Math.min(Math.max(rating, 0), 5) / 5 * 28;
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
    if (cat.includes(levelNorm)) return true;
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

function pickBestPerformer(rows: AmazonProductRow[]): AmazonProductRow | null {
  if (rows.length === 0) return null;

  let best = rows[0];
  let bestScore = amazonOrganicPerformanceScore(best);

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const score = amazonOrganicPerformanceScore(row);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  return bestScore >= 0 ? best : null;
}

function filterOrganicPreferring(rows: AmazonProductRow[]): AmazonProductRow[] {
  const organic = rows.filter((r) => !isSponsoredAmazonRow(r));
  return organic.length > 0 ? organic : rows;
}

/**
 * Match one KWP keyword to the best Amazon product in the candidate pool.
 *
 * Pass order:
 * 1. Category matching using retailer-stripped core intent + full phrase levels
 * 2. Title matching using the same level sequence
 * 3. Exact keyword field match on the original keyword
 * 4. Title matching on the stripped core alone (broadest fallback)
 */
export function matchAmazonForKwpKeyword(
  kwpKeyword: string,
  allAmazonRows: AmazonProductRow[],
  scopedAmazonRows?: AmazonProductRow[]
): AmazonProductRow | null {
  const scoped = scopedAmazonRows?.length ? scopedAmazonRows : [];
  const pool = scoped.length > 0 ? scoped : allAmazonRows;
  if (!pool.length || !kwpKeyword.trim()) return null;

  const candidates = filterOrganicPreferring(pool);

  // All levels to try: core-intent first (retailer stripped), then full phrase
  const levels = buildAllMatchLevels(kwpKeyword);

  // Pass 1: category field matching
  for (const level of levels) {
    const hits = candidates.filter((row) =>
      categoryMatchesLevel(getProductCategoryTexts(row), level)
    );
    const best = pickBestPerformer(hits);
    if (best) return best;
  }

  // Pass 2: title matching
  for (const level of levels) {
    const hits = candidates.filter((row) => titleMatchesLevel(row, level));
    const best = pickBestPerformer(hits);
    if (best) return best;
  }

  // Pass 3: exact keyword field match on original phrase
  const kwNorm = normalizeText(kwpKeyword);
  const exactHits = candidates.filter(
    (row) => normalizeText(row.keyword ?? row.sub_keyword ?? '') === kwNorm
  );
  const exactBest = pickBestPerformer(exactHits);
  if (exactBest) return exactBest;

  // Pass 4: broadest title fallback on stripped core (single remaining product word)
  const core = stripRetailerNoise(kwpKeyword);
  if (core !== normalizeText(kwpKeyword)) {
    const coreWords = tokenizeKeyword(core);
    if (coreWords.length > 0) {
      // Require all core words to appear in the title
      const coreHits = candidates.filter((row) => {
        const title = normalizeText(row.title ?? row.product_title ?? '');
        return coreWords.every((w) => title.includes(w));
      });
      return pickBestPerformer(coreHits);
    }
  }

  return null;
}
