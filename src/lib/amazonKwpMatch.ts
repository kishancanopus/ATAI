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
 * At each level, pick the highest-confidence organic listing
 * (reviews, rating, BSR, sales + category alignment + disqualifier checks).
 * Sponsored listings are excluded.
 *
 * v2 changes:
 *   - Marketing qualifier stripping ("Best Rice Cooker" → "Rice Cooker" for matching)
 *   - Product-type disqualifier detection (rejects accessories/consumables matching by title tokens)
 *   - Synonym expansion ("fridge" ↔ "refrigerator", etc.) in title + category scoring
 *   - Confidence scoring (0–100) replaces binary accept/reject thresholds
 *   - All candidates in a hit set evaluated; highest-confidence non-disqualified row wins
 *   - Per-keyword diagnostic logging (always on — disable via LOG_AMAZON_MATCH_DIAGNOSTICS=false)
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
  /** Confidence score 0–100 (added in v2) */
  confidence?: number;
  /** True when accepted at fallback quality (70–89) rather than high confidence (≥90) */
  isFallbackQuality?: boolean;
};

export type KwpSeedInput = {
  /** Stable key for the KWP row (root::variant) */
  key: string;
  keyword: string;
  rootKeyword: string;
  searchVolume?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

/**
 * Pure marketing / ranking qualifier tokens stripped from the search keyword
 * *before* it enters category/title matching.
 *
 * Intentionally narrow — only unambiguous sentiment/ranking words.
 * Product-spec qualifiers ("top load", "commercial", "professional") are kept
 * because they narrow the product type.
 */
export const MARKETING_QUALIFIER_TOKENS = new Set([
  'best', 'good', 'great', 'cheap', 'cheapest', 'affordable', 'budget',
  'recommended', 'popular', 'highly', 'well',
]);

/**
 * Words that, when present in a candidate title but absent from the (cleaned)
 * search keyword, strongly indicate a product-type mismatch:
 *   - accessory / consumable / replacement part for the real product
 *   - adjacent product from a different category
 *
 * Applied as a −50 confidence penalty when triggered.
 * Does NOT fire when the keyword itself contains the word (e.g. "Vacuum Cleaner",
 * "Air Filter", "Mattress Topper", "Replacement Water Filter" are all safe).
 */
export const GENERIC_DISQUALIFIER_WORDS = new Set([
  // Cleaning consumables (not cleaning appliances)
  'cleaner', 'cleaning', 'detergent', 'descaler', 'deodorizer',
  'disinfectant', 'sanitizer', 'wipes',
  // Replacement parts / accessories
  'accessory', 'accessories', 'replacement', 'spare', 'refill',
  'cartridge', 'hose', 'brush', 'nozzle', 'attachment', 'adapter',
  'seal', 'gasket', 'belt', 'valve',
  // Bedding / padding adjacent to furniture
  'mattress', 'mattresses', 'topper', 'liner', 'insert',
  // Covers / protection items
  'slipcover',
  // Organization / support accessories
  'stand', 'rack', 'mount', 'bracket', 'organizer',
  // Paper / filter media (consumable, not appliance)
  'pellets', 'tablets',
  // Informational products
  'manual', 'guide',
]);

/**
 * Synonym pairs for token-level matching.
 * When scoring title / category relevance, each token is also checked against
 * its synonyms so "fridge" matches "refrigerator" in a product title.
 * Mapping is one-directional (expand query tokens → accepted title tokens).
 */
export const KEYWORD_SYNONYMS: Record<string, string[]> = {
  fridge: ['refrigerator', 'frig'],
  frig: ['refrigerator', 'fridge'],
  washer: ['washing machine'],
  dryer: ['clothes dryer', 'tumble dryer'],
  tv: ['television', 'monitor'],
  sofa: ['couch', 'settee'],
  couch: ['sofa', 'settee'],
  stroller: ['pram', 'pushchair', 'baby carriage'],
  diaper: ['nappy'],
  nappy: ['diaper'],
  phone: ['smartphone', 'mobile phone'],
  cooktop: ['stovetop', 'hob'],
  hob: ['cooktop', 'stovetop'],
  microwave: ['microwave oven'],
  dishwasher: ['dish washer'],
};

/** Confidence score thresholds */
export const CONFIDENCE_ACCEPT_HIGH = 90;
export const CONFIDENCE_ACCEPT_FALLBACK = 70;
export const CONFIDENCE_MIN_ACCEPT = 50;

/** Format confidence for UI / logs (2 decimal places). */
export function formatMatchConfidence(confidence: number | null | undefined): string {
  if (confidence == null || !Number.isFinite(confidence)) return '';
  return Number(confidence).toFixed(2);
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

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

/**
 * Synonym-aware token matching.
 * Returns true when `token` OR any of its synonyms appears in `text`.
 */
function tokenWithSynonymsMatchesText(token: string, text: string): boolean {
  if (tokenMatchesInText(token, text)) return true;
  const syns = KEYWORD_SYNONYMS[token];
  if (!syns) return false;
  return syns.some((syn) => {
    // Each synonym may be a multi-word phrase (e.g. "washing machine")
    if (text.includes(syn)) return true;
    return syn.split(' ').every((w) => tokenMatchesInText(w, text));
  });
}

/** Significant tokens (length > 1) for matching */
export function tokenizeKeyword(keyword: string): string[] {
  return normalizeText(keyword).split(' ').filter((w) => w.length > 1);
}

// ---------------------------------------------------------------------------
// Keyword cleaning pipeline
// ---------------------------------------------------------------------------

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
  'bestbuy', 'staples', 'officedepot', 'costplus',
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
 * Strip pure marketing / ranking qualifiers from a keyword before token matching.
 * "Best Rice Cooker" → "Rice Cooker"
 * "Top Load Washing Machine" → unchanged ("top" is a product spec here, not marketing)
 */
export function stripMarketingQualifiers(keyword: string): string {
  const tokens = tokenizeKeyword(keyword);
  const filtered = tokens.filter((w) => !MARKETING_QUALIFIER_TOKENS.has(w));
  // Guard: if stripping removes everything, keep original
  return (filtered.length > 0 ? filtered : tokens).join(' ');
}

/**
 * Full keyword cleaning pipeline for matching:
 * stripRetailerNoise → stripMarketingQualifiers
 * Used as the primary token set for category/title level building.
 */
export function cleanKeywordForMatching(keyword: string): string {
  return stripMarketingQualifiers(stripRetailerNoise(keyword));
}

// ---------------------------------------------------------------------------
// Category levels
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Product row helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Disqualifier detection (Problem 2)
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the candidate title contains a product-type disqualifier
 * word that is NOT present in the (cleaned) search keyword.
 *
 * Examples that trigger:
 *   keyword="Washing Machine", title="OxiClean Washing Machine Cleaner" → true
 *   keyword="Baby Crib",       title="Crib Mattress"                   → true
 *
 * Examples that do NOT trigger (keyword contains the disqualifier word):
 *   keyword="Vacuum Cleaner",  title="Dyson Vacuum Cleaner"            → false
 *   keyword="Air Filter",      title="3M Air Filter"                   → false
 *   keyword="Mattress Topper", title="Memory Foam Mattress Topper"     → false
 */
export function isDisqualifiedByProductType(
  kwpKeyword: string,
  row: AmazonProductRow
): boolean {
  const cleanedKeyword = normalizeText(cleanKeywordForMatching(kwpKeyword));
  const keywordTokens = new Set(
    cleanedKeyword.split(' ').filter((w) => w.length > 1)
  );
  // Also include stemmed forms of keyword tokens for comparison
  const keywordStemmed = new Set([...keywordTokens].map(stemToken));

  const title = normalizeText(String(row.title ?? row.product_title ?? ''));
  const titleTokens = title.split(' ').filter((w) => w.length > 1);

  for (const token of titleTokens) {
    const stemmed = stemToken(token);
    if (
      !GENERIC_DISQUALIFIER_WORDS.has(token) &&
      !GENERIC_DISQUALIFIER_WORDS.has(stemmed)
    ) {
      continue;
    }
    // Keyword already mentions this word → intended product type, not a mismatch
    if (
      keywordTokens.has(token) ||
      keywordTokens.has(stemmed) ||
      keywordStemmed.has(token) ||
      keywordStemmed.has(stemmed)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Confidence scoring (Problem 1 + 2)
// ---------------------------------------------------------------------------

/**
 * Compute a 0–100 confidence score for a candidate product match.
 *
 * Scoring formula:
 *   category alignment:  scoreCategoryRelevance(cleanedKw, row) × 0.20  → 0–20
 *   title overlap:       scoreTitleRelevance(cleanedKw, row)    × 0.50  → 0–50
 *   match type bonus:    category=20, title=15, partial_title=10, keyword=8, fallback=5
 *   performance:         min(organicScore / 10, 10)                      → 0–10
 *   exact title bonus:   +15 bonus if titleScore is 100 (exact match)
 *   disqualifier:        −50 if product-type mismatch detected
 *   ─────────────────────────────────────────────────────────────
 *   total clamped to [0, 100]
 *
 * Thresholds:
 *   ≥ 90 → high confidence, accept
 *   70–89 → accept, flag as isFallbackQuality
 *   < 70  → reject (blank result preferred over wrong match)
 */
export function computeMatchConfidence(
  kwpKeyword: string,
  row: AmazonProductRow,
  matchType: AmazonMatchType,
  organicScore: number
): { confidence: number; isFallbackQuality: boolean; disqualified: boolean } {
  const cleanedKeyword = cleanKeywordForMatching(kwpKeyword);

  // Category alignment: 0–20
  const catScore = scoreCategoryRelevance(cleanedKeyword, row);
  const catComponent = catScore * 0.2;

  // Title overlap (synonym-aware): 0–50
  const titleScore = scoreTitleRelevance(cleanedKeyword, row);
  const titleComponent = titleScore * 0.5;

  // Match type bonus: 0–20
  const matchTypeBonusMap: Record<AmazonMatchType, number> = {
    category: 20,
    title: 15,
    partial_title: 10,
    keyword: 8,
    fallback: 5,
    none: 0,
  };
  const matchTypeBonus = matchTypeBonusMap[matchType] ?? 0;

  // Organic performance: 0–10
  const perfComponent = Math.min(organicScore / 10, 10);

  // Exact title phrase match bonus: +15
  const exactTitleBonus = titleScore >= 100 ? 15 : 0;

  // Disqualifier: −50 penalty
  const disqualified = isDisqualifiedByProductType(kwpKeyword, row);
  const disqualifierPenalty = disqualified ? -50 : 0;

  const raw =
    catComponent +
    titleComponent +
    matchTypeBonus +
    perfComponent +
    exactTitleBonus +
    disqualifierPenalty;
  const confidence = Math.round(Math.max(0, Math.min(100, raw)) * 100) / 100;

  return {
    confidence,
    isFallbackQuality:
      confidence >= CONFIDENCE_ACCEPT_FALLBACK && confidence < CONFIDENCE_ACCEPT_HIGH,
    disqualified,
  };
}

// ---------------------------------------------------------------------------
// Diagnostic logging
// ---------------------------------------------------------------------------

/** Structured diagnostic log entry for a single keyword match attempt */
export interface MatchDiagnostic {
  keyword: string;
  cleanedKeyword: string;
  candidatesEvaluated: number;
  acceptedTitle: string | null;
  acceptedMatchType: AmazonMatchType | null;
  confidence: number | null;
  isFallbackQuality: boolean;
  rejectionReason: string | null;
  disqualifiedCount: number;
}

/**
 * Emit a per-keyword diagnostic log line.
 * Set environment variable LOG_AMAZON_MATCH_DIAGNOSTICS=false to suppress.
 */
export function logMatchDiagnostic(d: MatchDiagnostic): void {
  if (process.env.LOG_AMAZON_MATCH_DIAGNOSTICS === 'false') return;

  const accepted = d.acceptedTitle
    ? `✅ "${d.acceptedTitle.slice(0, 60)}" (${d.acceptedMatchType}, conf=${formatMatchConfidence(d.confidence)}${d.isFallbackQuality ? ', FALLBACK' : ''})`
    : `❌ no match`;

  const rejection = d.rejectionReason ? ` | reason="${d.rejectionReason}"` : '';

  console.log(
    `[AmazonMatch] kw="${d.keyword}" cleaned="${d.cleanedKeyword}" ` +
      `pool=${d.candidatesEvaluated} disqualified=${d.disqualifiedCount} ` +
      `→ ${accepted}${rejection}`
  );
}

// ---------------------------------------------------------------------------
// Scoring functions (synonym-aware)
// ---------------------------------------------------------------------------

function categoryMatchesLevel(categoryTexts: string[], levelPhrase: string): boolean {
  const levelNorm = normalizeText(levelPhrase);
  if (!levelNorm) return false;

  const levelWords = levelNorm.split(' ').filter((w) => w.length > 1);
  if (levelWords.length === 0) return false;

  return categoryTexts.some((cat) => {
    if (cat.includes(levelNorm) || levelNorm.includes(cat)) return true;
    return levelWords.every((w) => tokenWithSynonymsMatchesText(w, cat));
  });
}

function titleMatchesLevel(row: AmazonProductRow, levelPhrase: string): boolean {
  const title = normalizeText(row.title ?? row.product_title ?? '');
  if (!title) return false;

  const levelNorm = normalizeText(levelPhrase);
  if (title.includes(levelNorm)) return true;

  const levelWords = levelNorm.split(' ').filter((w) => w.length > 1);
  if (levelWords.length === 0) return false;
  return levelWords.every((w) => tokenWithSynonymsMatchesText(w, title));
}

/** ≥60% of variant tokens in title, with at least one non-generic token hit */
export function partialTitleMatches(kwpKeyword: string, row: AmazonProductRow): boolean {
  const title = normalizeText(row.title ?? row.product_title ?? '');
  if (!title) return false;

  const words = tokenizeKeyword(stripRetailerNoise(kwpKeyword));
  if (words.length < 2) return false;

  const hits = words.filter((w) => tokenWithSynonymsMatchesText(w, title)).length;
  if (hits / words.length < PARTIAL_TITLE_MIN_RATIO) return false;

  const significantHits = words.filter(
    (w) => !GENERIC_MATCH_TOKENS.has(w) && tokenWithSynonymsMatchesText(w, title)
  );
  return significantHits.length >= 1;
}

function hasSignificantTokenOverlap(kwpKeyword: string, row: AmazonProductRow): boolean {
  const words = tokenizeKeyword(stripRetailerNoise(kwpKeyword));
  const title = normalizeText(row.title ?? row.product_title ?? '');
  const categories = getProductCategoryTexts(row).join(' ');
  const haystack = `${title} ${categories}`;

  return words.some(
    (w) => !GENERIC_MATCH_TOKENS.has(w) && tokenWithSynonymsMatchesText(w, haystack)
  );
}

export function getAmazonRowAsin(row: AmazonProductRow): string | null {
  const asin = row.a_sin ?? row.asin;
  if (asin == null || asin === '') return null;
  return String(asin).trim().toUpperCase();
}

/**
 * Title token coverage score (0–100), synonym-aware.
 * 100 = exact phrase in title; partial = proportional token hits.
 */
export function scoreTitleRelevance(kwpKeyword: string, row: AmazonProductRow): number {
  const title = normalizeText(row.title ?? row.product_title ?? '');
  const kwNorm = normalizeText(cleanKeywordForMatching(kwpKeyword));
  if (!title || !kwNorm) return 0;
  if (title.includes(kwNorm)) return 100;

  const words = kwNorm.split(' ').filter((w) => w.length > 1);
  if (words.length === 0) return 0;
  const hits = words.filter((w) => tokenWithSynonymsMatchesText(w, title)).length;
  if (hits === words.length) return 100;
  return Math.round((hits / words.length) * 85);
}

/**
 * Category alignment score (0–100), synonym-aware.
 * Checks keyword tokens against all product category fields.
 */
export function scoreCategoryRelevance(kwpKeyword: string, row: AmazonProductRow): number {
  const kwWords = tokenizeKeyword(cleanKeywordForMatching(kwpKeyword));
  if (kwWords.length === 0) return 0;

  const categories = getProductCategoryTexts(row);
  if (categories.length === 0) return 0;

  let best = 0;
  for (const cat of categories) {
    const hits = kwWords.filter((w) => tokenWithSynonymsMatchesText(w, cat)).length;
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

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

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

/**
 * Evaluate every row in `rows` for confidence; return the highest-confidence
 * non-disqualified candidate, or null if none meets the threshold.
 *
 * This replaces the binary "take first hit" approach — all candidates in the
 * matched set are evaluated, so a disqualified top-ranked product does not
 * block a better-fitting candidate lower in the list.
 */
function pickBestConfidentCandidate(
  rows: AmazonProductRow[],
  kwpKeyword: string,
  matchType: AmazonMatchType
): { row: AmazonProductRow; confidence: number; isFallbackQuality: boolean } | null {
  let bestAccepted: {
    row: AmazonProductRow;
    confidence: number;
    isFallbackQuality: boolean;
    organic: number;
  } | null = null;

  for (const row of rows) {
    const organic = amazonOrganicPerformanceScore(row);
    if (organic < 0) continue; // skip sponsored

    const { confidence, isFallbackQuality, disqualified } = computeMatchConfidence(
      kwpKeyword,
      row,
      matchType,
      organic
    );

    if (confidence < CONFIDENCE_MIN_ACCEPT) continue;
    if (disqualified) continue;

    if (
      bestAccepted === null ||
      confidence > bestAccepted.confidence ||
      (confidence === bestAccepted.confidence && organic > bestAccepted.organic)
    ) {
      bestAccepted = { row, confidence, isFallbackQuality, organic };
    }
  }

  if (!bestAccepted) return null;
  return {
    row: bestAccepted.row,
    confidence: bestAccepted.confidence,
    isFallbackQuality: bestAccepted.isFallbackQuality,
  };
}

/**
 * Legacy: pick best organic performer (used in root-pool fallback where
 * confidence has already been checked externally).
 */
function pickBestPerformer(rows: AmazonProductRow[], kwpKeyword?: string): AmazonProductRow | null {
  if (rows.length === 0) return null;

  let best: AmazonProductRow | null = null;
  let bestCombined = -1;

  for (const row of rows) {
    const organic = amazonOrganicPerformanceScore(row);
    if (organic < 0) continue;
    const tiebreak = kwpKeyword
      ? scoreTitleRelevance(kwpKeyword, row) * TITLE_TIEBREAKER_WEIGHT
      : 0;
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

// ---------------------------------------------------------------------------
// Core matching logic
// ---------------------------------------------------------------------------

type MatchPhase = 'strict' | 'fallback' | 'all';

function matchAmazonInternal(
  kwpKeyword: string,
  allAmazonRows: AmazonProductRow[],
  scopedAmazonRows: AmazonProductRow[] | undefined,
  excludeAsins: Set<string> | undefined,
  phase: MatchPhase
): AmazonMatchResult | null {
  if (!kwpKeyword.trim()) return null;

  // Build match levels from the cleaned keyword (marketing qualifiers stripped)
  // and the original keyword as a fallback union, so:
  //   "Best Rice Cooker" → tries "rice cooker" first, then "best rice cooker"
  //   "Top Load Washing Machine" → unchanged (no marketing qualifiers)
  const cleanedKeyword = cleanKeywordForMatching(kwpKeyword);
  const cleanedLevels = buildAllMatchLevels(cleanedKeyword);
  const originalLevels = buildAllMatchLevels(kwpKeyword);
  const allLevels = [
    ...cleanedLevels,
    ...originalLevels.filter((l) => !cleanedLevels.includes(l)),
  ];
  const kwNorm = normalizeText(cleanedKeyword);

  if (phase === 'strict' || phase === 'all') {
    const candidates = buildCandidatePool(allAmazonRows, scopedAmazonRows, excludeAsins);

    if (candidates.length) {
      // --- Category pass ---
      for (const level of allLevels) {
        const hits = candidates.filter((row) =>
          categoryMatchesLevel(getProductCategoryTexts(row), level)
        );
        const best = pickBestConfidentCandidate(hits, kwpKeyword, 'category');
        if (best) {
          return {
            row: best.row,
            matchType: 'category',
            confidence: best.confidence,
            isFallbackQuality: best.isFallbackQuality,
          };
        }
      }

      // --- Title pass ---
      for (const level of allLevels) {
        const hits = candidates.filter((row) => titleMatchesLevel(row, level));
        const best = pickBestConfidentCandidate(hits, kwpKeyword, 'title');
        if (best) {
          return {
            row: best.row,
            matchType: 'title',
            confidence: best.confidence,
            isFallbackQuality: best.isFallbackQuality,
          };
        }
      }

      // --- Partial title pass ---
      const partialHits = candidates.filter((row) => partialTitleMatches(kwpKeyword, row));
      const partialBest = pickBestConfidentCandidate(partialHits, kwpKeyword, 'partial_title');
      if (partialBest) {
        return {
          row: partialBest.row,
          matchType: 'partial_title',
          confidence: partialBest.confidence,
          isFallbackQuality: partialBest.isFallbackQuality,
        };
      }

      // --- Exact keyword pass ---
      const exactHits = candidates.filter(
        (row) => normalizeText(row.keyword ?? row.sub_keyword ?? '') === kwNorm
      );
      const exactBest = pickBestConfidentCandidate(exactHits, kwpKeyword, 'keyword');
      if (exactBest) {
        return {
          row: exactBest.row,
          matchType: 'keyword',
          confidence: exactBest.confidence,
          isFallbackQuality: exactBest.isFallbackQuality,
        };
      }
    }

    if (phase === 'strict') return null;
  }

  if (phase === 'fallback' || phase === 'all') {
    const scopedUnused = buildScopedUnusedPool(scopedAmazonRows, excludeAsins);
    if (scopedUnused.length > 0) {
      // Similarity-ranked candidates, checked with full confidence gate
      const scored = scopedUnused
        .map((row) => ({ row, similarity: scoreRootPoolSimilarity(kwpKeyword, row) }))
        .filter(
          (x) =>
            x.similarity >= ROOT_POOL_FALLBACK_MIN_SCORE &&
            hasSignificantTokenOverlap(kwpKeyword, x.row)
        )
        .sort((a, b) => b.similarity - a.similarity);

      for (const { row } of scored) {
        const organic = amazonOrganicPerformanceScore(row);
        if (organic < 0) continue;
        const { confidence, isFallbackQuality, disqualified } = computeMatchConfidence(
          kwpKeyword,
          row,
          'fallback',
          organic
        );
        if (confidence >= CONFIDENCE_MIN_ACCEPT && !disqualified) {
          return { row, matchType: 'fallback', confidence, isFallbackQuality };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public batch API (two-phase, preserves existing architecture)
// ---------------------------------------------------------------------------

/** Outcome of batch Amazon matching for one KWP seed (match + human-readable reason). */
export type AmazonSeedMatchOutcome = {
  match: AmazonMatchResult | null;
  diagnosticReason: string;
};

/**
 * Explain why a keyword has or lacks an Amazon product match.
 * Does not change matching — diagnostic only.
 */
export function resolveAmazonMatchDiagnosticReason(
  seed: KwpSeedInput,
  match: AmazonMatchResult | null,
  allAmazonRows: AmazonProductRow[],
  amzByRoot: Map<string, AmazonProductRow[]>,
  usedAsins: Set<string>,
  options?: { amazonEnabled?: boolean }
): string {
  if (options?.amazonEnabled === false) {
    return 'Amazon stage disabled in filters';
  }

  if (match) {
    const label = formatAmazonMatchType(match.matchType);
    const parts = [`Matched via ${label}`];
    if (match.confidence != null) parts.push(`confidence ${formatMatchConfidence(match.confidence)}`);
    if (match.isFallbackQuality) parts.push('fallback quality');
    return parts.join(' · ');
  }

  const rootKey = seed.rootKeyword.toLowerCase().trim();
  const scoped = amzByRoot.get(rootKey) ?? [];

  if (allAmazonRows.length === 0) {
    return 'No Amazon products fetched for this search';
  }
  if (scoped.length === 0) {
    return 'No Amazon products in root execution pool';
  }

  const organicScoped = scoped.filter((r) => !isSponsoredAmazonRow(r));
  const poolForCheck = organicScoped.length > 0 ? organicScoped : scoped;

  const withAvailableAsin = poolForCheck.filter((r) => {
    const asin = getAmazonRowAsin(r);
    return !asin || !usedAsins.has(asin);
  });
  if (withAvailableAsin.length === 0 && poolForCheck.some((r) => getAmazonRowAsin(r))) {
    return 'ASIN deduplication — candidates already assigned to higher-volume keywords';
  }

  if (organicScoped.length === 0) {
    return 'Only sponsored listings available (organic required)';
  }

  const disqualifiedCount = poolForCheck.filter((r) =>
    isDisqualifiedByProductType(seed.keyword, r)
  ).length;

  if (disqualifiedCount > 0 && disqualifiedCount >= poolForCheck.length) {
    return 'Product-type disqualification — all candidates are accessories/parts mismatch';
  }

  if (disqualifiedCount > 0) {
    return `Confidence threshold not met (${disqualifiedCount} candidate(s) disqualified by product-type check)`;
  }

  return 'Confidence threshold not met (category/title/keyword/fallback passes)';
}

/**
 * Two-phase batch matching for consolidation.
 *
 * Phase A: strict passes for all seeds (volume order) — reserves best strict matches.
 * Phase B: root-pool fallback only for still-unmatched seeds.
 * ASIN deduplication enforced between and within phases.
 *
 * Emits a per-keyword diagnostic log for every seed after both phases complete.
 */
export function matchAmazonForKwpSeedsBatch(
  seeds: KwpSeedInput[],
  allAmazonRows: AmazonProductRow[],
  amzByRoot: Map<string, AmazonProductRow[]>,
  options?: { amazonEnabled?: boolean }
): Map<string, AmazonSeedMatchOutcome> {
  const results = new Map<string, AmazonSeedMatchOutcome>();
  const matchOnly = new Map<string, AmazonMatchResult | null>();
  const usedAsins = new Set<string>();

  const ordered = [...seeds].sort(
    (a, b) => Number(b.searchVolume ?? 0) - Number(a.searchVolume ?? 0)
  );

  // Phase A: strict
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
    matchOnly.set(seed.key, strict);
    const asin = strict ? getAmazonRowAsin(strict.row) : null;
    if (asin) usedAsins.add(asin);
  }

  // Phase B: fallback for unmatched
  for (const seed of ordered) {
    if (matchOnly.get(seed.key)) continue;

    const rootKey = seed.rootKeyword.toLowerCase().trim();
    const scopedAmz = amzByRoot.get(rootKey) ?? [];
    const fallback = matchAmazonInternal(
      seed.keyword,
      allAmazonRows,
      scopedAmz,
      usedAsins,
      'fallback'
    );
    matchOnly.set(seed.key, fallback);
    const asin = fallback ? getAmazonRowAsin(fallback.row) : null;
    if (asin) usedAsins.add(asin);
  }

  for (const seed of ordered) {
    const match = matchOnly.get(seed.key) ?? null;
    const diagnosticReason = resolveAmazonMatchDiagnosticReason(
      seed,
      match,
      allAmazonRows,
      amzByRoot,
      usedAsins,
      options
    );
    results.set(seed.key, { match, diagnosticReason });
  }

  // Emit diagnostic logs
  for (const seed of ordered) {
    const outcome = results.get(seed.key)!;
    const result = outcome.match;
    const cleanedKeyword = cleanKeywordForMatching(seed.keyword);
    const rootKey = seed.rootKeyword.toLowerCase().trim();
    const pool = [...allAmazonRows, ...(amzByRoot.get(rootKey) ?? [])];
    const uniquePool = [...new Map(pool.map((r) => [getAmazonRowAsin(r) ?? Math.random(), r])).values()];

    const disqualifiedCount = uniquePool.filter((r) =>
      isDisqualifiedByProductType(seed.keyword, r)
    ).length;

    const acceptedTitle = result
      ? String(result.row.title ?? result.row.product_title ?? '')
      : null;

    logMatchDiagnostic({
      keyword: seed.keyword,
      cleanedKeyword,
      candidatesEvaluated: uniquePool.length,
      acceptedTitle,
      acceptedMatchType: result?.matchType ?? null,
      confidence: result?.confidence ?? null,
      isFallbackQuality: result?.isFallbackQuality ?? false,
      rejectionReason: result ? null : outcome.diagnosticReason,
      disqualifiedCount,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public single-keyword API (preserves existing call signatures)
// ---------------------------------------------------------------------------

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
 * Match one Keyword Planner row (all phases in one call).
 * Prefer `matchAmazonForKwpSeedsBatch` for consolidation (better ASIN dedup).
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
  if (strict) {
    _logSingleKeywordDiagnostic(kwpKeyword, strict, allAmazonRows);
    return strict.row;
  }

  const fallback = matchAmazonInternal(
    kwpKeyword,
    allAmazonRows,
    scopedAmazonRows,
    excludeAsins,
    'fallback'
  );
  _logSingleKeywordDiagnostic(kwpKeyword, fallback, allAmazonRows);
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

/** Internal helper — diagnostic for single-keyword public API */
function _logSingleKeywordDiagnostic(
  kwpKeyword: string,
  result: AmazonMatchResult | null,
  pool: AmazonProductRow[]
): void {
  const cleanedKeyword = cleanKeywordForMatching(kwpKeyword);
  const disqualifiedCount = pool.filter((r) => isDisqualifiedByProductType(kwpKeyword, r)).length;
  logMatchDiagnostic({
    keyword: kwpKeyword,
    cleanedKeyword,
    candidatesEvaluated: pool.length,
    acceptedTitle: result
      ? String(result.row.title ?? result.row.product_title ?? '')
      : null,
    acceptedMatchType: result?.matchType ?? null,
    confidence: result?.confidence ?? null,
    isFallbackQuality: result?.isFallbackQuality ?? false,
    rejectionReason: result
      ? null
      : pool.length === 0
      ? 'empty candidate pool'
      : disqualifiedCount > 0
      ? `all ${disqualifiedCount} candidate(s) disqualified`
      : 'no candidate reached confidence threshold',
    disqualifiedCount,
  });
}
