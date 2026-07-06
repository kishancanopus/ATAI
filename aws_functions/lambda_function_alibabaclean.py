# ALIBABA CLEAN LAMBDA — adapted for "Alibaba Category Scraper" actor output
#
# New actor schema (key fields used below):
#   productId, productUrl, title, price ("$1.80"), currency,
#   minOrderQuantity, minOrderUnit, soldCount, mainImage,
#   supplierId, supplierName, supplierUrl, supplierCountry,
#   goldSupplierYears, overallRating, reviewCount,
#   productScore, serviceScore, shippingScore,
#   isGoldSupplier, isTradeAssurance, isTrustedSupplier, isPromotedProduct,
#   capabilities, badges, certifications, sellingPoints,
#   keyword (injected by fetch lambda), scrapedAt
#
import json
import os
import re
import tempfile
from datetime import datetime, timezone

import boto3
import pandas as pd

# Optional pyarrow (Lambda layer / container image)
try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    PYARROW_AVAILABLE = True
except Exception:
    PYARROW_AVAILABLE = False

s3            = boto3.client("s3")
OUTPUT_BUCKET = os.environ.get("OUTPUT_BUCKET", "atai-clean-layer")


# ─────────────────────────────────────────────────────────────────────────────
# PRICE PARSING
# New actor returns price as a string like "$1.80", "$2.50 - $5.00", etc.
# ─────────────────────────────────────────────────────────────────────────────

def parse_price_string(price_str):
    """
    Parse a price string such as "$1.80", "$2 - $5", "1.80" etc.
    Returns (price_min, price_max) as floats or (None, None).
    """
    if not price_str:
        return None, None
    # Strip currency symbols and whitespace
    cleaned = re.sub(r"[^\d.\-–—]", " ", str(price_str)).strip()
    # Find all numbers
    nums = re.findall(r"\d+(?:\.\d+)?", cleaned)
    if not nums:
        return None, None
    floats = [float(n) for n in nums]
    return min(floats), max(floats)


# ─────────────────────────────────────────────────────────────────────────────
# MOQ PARSING
# ─────────────────────────────────────────────────────────────────────────────

def parse_moq(val):
    if val is None:
        return None
    try:
        return int(val)
    except Exception:
        m = re.search(r"(\d+)", str(val).replace(",", ""))
        return int(m.group(1)) if m else None


# ─────────────────────────────────────────────────────────────────────────────
# ORDERS / SOLD COUNT
# ─────────────────────────────────────────────────────────────────────────────

def parse_orders(val):
    """
    soldCount from the new actor is already an int; keep as-is.
    Also handle legacy string formats like "1000+" just in case.
    """
    if val is None:
        return None
    try:
        return int(val)
    except Exception:
        m = re.search(r"([\d,]+)", str(val))
        if m:
            return int(m.group(1).replace(",", ""))
    return None


# ─────────────────────────────────────────────────────────────────────────────
# SHIPPING TO EL SALVADOR DETECTION
# New actor rarely exposes shipTo fields; default to None (unknown) unless
# a future version adds shipping data.
# ─────────────────────────────────────────────────────────────────────────────

def detect_ships_to_sv(item):
    """
    Returns True / False / None.
    The "Alibaba Category Scraper" actor does not expose shipTo data, so this
    returns None (unknown) for all rows unless the item has legacy fields.
    """
    sv_patterns     = re.compile(r"\b(el salvador|salvador|sv|sv\.)\b", re.I)
    global_patterns = re.compile(r"\b(global|worldwide|all countries|every country|any country|all regions)\b", re.I)

    candidates = []
    for key in ("shipTo", "shipToCountries", "shipToCountriesList", "shipping", "shippingTo"):
        v = item.get(key)
        if v is not None:
            candidates.append(v)

    if not candidates:
        return None

    found_sv            = False
    any_specific        = False

    for v in candidates:
        joined = ", ".join(str(x) for x in v) if isinstance(v, list) else str(v)
        if sv_patterns.search(joined):
            found_sv = True
            break
        if global_patterns.search(joined):
            found_sv = True
            break
        if "," in joined or isinstance(v, list):
            entries = [e.strip() for e in re.split(r"[,|;/]+", joined) if e.strip()]
            if entries:
                any_specific = True
                if any(sv_patterns.search(e) for e in entries):
                    found_sv = True
                    break

    if found_sv:
        return True
    if any_specific:
        return False
    return None


# ─────────────────────────────────────────────────────────────────────────────
# CATEGORY EXTRACTION
# New actor does not return a category field; fall back to search keyword.
# ─────────────────────────────────────────────────────────────────────────────

def extract_category(item):
    cats = item.get("categories") or item.get("category") or item.get("categoryList")
    if isinstance(cats, list):
        return " > ".join([str(x).strip() for x in cats if x])
    if isinstance(cats, str):
        return cats
    return None


# ─────────────────────────────────────────────────────────────────────────────
# SUPPLIER VERIFICATION FLAG
# ─────────────────────────────────────────────────────────────────────────────

def is_verified_supplier(item):
    """
    Returns True if the supplier is considered verified / trusted.
    Combines isTrustedSupplier, isGoldSupplier, and isTradeAssurance.
    """
    return bool(
        item.get("isTrustedSupplier")
        or item.get("isGoldSupplier")
        or item.get("isTradeAssurance")
    )


# ─────────────────────────────────────────────────────────────────────────────
# STRIP HTML TAGS FROM TITLE
# ─────────────────────────────────────────────────────────────────────────────

def strip_html(text):
    if not text:
        return text
    return re.sub(r"<[^>]+>", "", str(text)).strip()


# ─────────────────────────────────────────────────────────────────────────────
# NORMALIZE ONE ITEM  ← main mapping function
# ─────────────────────────────────────────────────────────────────────────────

def normalize_item(item, data_collected_at, keyword, search_category=None):
    # ── identifiers ──────────────────────────────────────────────────────────
    pid          = item.get("productId") or item.get("id") or None
    product_link = item.get("productUrl") or item.get("url") or item.get("link")
    title        = strip_html(item.get("title") or item.get("subject"))
    category     = extract_category(item)

    # ── price ─────────────────────────────────────────────────────────────────
    # New actor: price is a pre-formatted string like "$1.80"
    raw_price    = item.get("price")
    min_p, max_p = parse_price_string(raw_price)

    # ── orders / sold count ───────────────────────────────────────────────────
    orders = parse_orders(
        item.get("soldCount") or item.get("ordersCount") or item.get("orders_count")
    )

    # ── MOQ ───────────────────────────────────────────────────────────────────
    moq = parse_moq(
        item.get("minOrderQuantity") or item.get("moq") or item.get("minimumOrderQuantity")
    )

    # ── supplier info ─────────────────────────────────────────────────────────
    supplier_name    = item.get("supplierName") or item.get("company") or None
    supplier_country = item.get("supplierCountry") or None
    supplier_link    = item.get("supplierUrl") or item.get("supplierProfileUrl") or None

    # overallRating from new actor (float 0-5)
    supplier_rating = None
    raw_rating = item.get("overallRating") or item.get("rating")
    if raw_rating is not None:
        try:
            supplier_rating = float(raw_rating)
        except Exception:
            pass

    # ── trust / verification ──────────────────────────────────────────────────
    gold_supplier_years  = item.get("goldSupplierYears")
    verified             = is_verified_supplier(item)
    trade_assurance      = bool(item.get("isTradeAssurance"))

    # ── review count ──────────────────────────────────────────────────────────
    review_count = None
    try:
        review_count = int(item.get("reviewCount") or 0) or None
    except Exception:
        pass

    # ── scores ────────────────────────────────────────────────────────────────
    def safe_float(v):
        try:
            return float(v) if v is not None else None
        except Exception:
            return None

    product_score  = safe_float(item.get("productScore"))
    service_score  = safe_float(item.get("serviceScore"))
    shipping_score = safe_float(item.get("shippingScore"))

    # ── capabilities (list → joined string) ───────────────────────────────────
    caps = item.get("capabilities") or []
    if isinstance(caps, list):
        capabilities = "; ".join(str(c) for c in caps if c and str(c) != "[object Object]")
    else:
        capabilities = str(caps) if caps else None

    # ── shipping to SV ────────────────────────────────────────────────────────
    ships_to_sv  = detect_ships_to_sv(item)

    # ── geo fallback ──────────────────────────────────────────────────────────
    geo = supplier_country or item.get("geo") or item.get("country") or None

    # ── weight: new actor does not expose weight; keep None ───────────────────
    weight_kg = None

    # ── availability ──────────────────────────────────────────────────────────
    availability = item.get("availability") or item.get("availabilityStatus") or None

    return {
        "keyword":              keyword,
        "product_id":           str(pid) if pid is not None else None,
        "title":                title,
        "category":             category,
        "search_category":      search_category,
        "alibaba_price_min_usd": min_p,
        "alibaba_price_max_usd": max_p,
        "orders_count":         orders,
        "moq":                  moq,
        "weight_kg":            weight_kg,
        "ships_to_sv":          ships_to_sv,
        "availability_status":  availability,
        "supplier_name":        supplier_name,
        "supplier_country":     supplier_country,
        "supplier_rating":      supplier_rating,
        "supplier_link":        supplier_link,
        "gold_supplier_years":  gold_supplier_years,
        "review_count":         review_count,
        "product_score":        product_score,
        "service_score":        service_score,
        "shipping_score":       shipping_score,
        "is_verified_supplier": verified,
        "is_trade_assurance":   trade_assurance,
        "capabilities":         capabilities,
        "geo":                  geo,
        "data_collected_at":    data_collected_at,
        "source":               "alibaba",
        "product_link":         product_link,
    }


# ─────────────────────────────────────────────────────────────────────────────
# ALIBABA FILTERS
# Null / empty / zero filter values mean "do not apply this filter".
# ─────────────────────────────────────────────────────────────────────────────

def _filter_value_is_active(val):
    """True when a filter parameter should be applied (non-null, non-empty, non-zero)."""
    if val is None:
        return False
    if isinstance(val, float) and pd.isna(val):
        return False
    if isinstance(val, bool):
        return val is True
    if isinstance(val, str):
        stripped = val.strip().lower()
        if stripped in ("", "null", "none", "undefined", "false", "0"):
            return False
        try:
            return float(stripped) != 0.0
        except ValueError:
            return stripped == "true"
    if isinstance(val, (int, float)):
        return float(val) != 0.0
    return True


def _verified_supplier_filter_active(val):
    if val is True:
        return True
    if isinstance(val, str):
        return val.strip().lower() == "true"
    return False


def apply_alibaba_filters(df, filters):
    if df.empty:
        return df

    if not filters.get("enable_alibaba", False):
        print("Alibaba filters OFF — saving all rows")
        return df

    margin_min            = filters.get("margin_min")
    moq_max               = filters.get("moq_max")
    min_rating            = filters.get("min_rating")
    verified_supplier_val = filters.get("verified_supplier")

    has_margin  = _filter_value_is_active(margin_min)
    has_moq     = _filter_value_is_active(moq_max)
    has_rating  = _filter_value_is_active(min_rating)
    is_verified_only = _verified_supplier_filter_active(verified_supplier_val)

    if not (has_margin or has_moq or has_rating or is_verified_only):
        print(f"No active Alibaba filters — keeping all {len(df)} rows")
        return df

    print(
        "Applying Alibaba filters:",
        f"margin={has_margin}",
        f"moq={has_moq}",
        f"rating={has_rating}",
        f"verified={is_verified_only}",
    )
    print(f"Rows before filtering: {len(df)}")

    keep = pd.Series(True, index=df.index)

    if has_margin:
        median_price = df["alibaba_price_min_usd"].dropna().median()
        if pd.isna(median_price):
            print("WARN margin filter skipped — no usable prices for median")
        else:
            max_allowed = median_price * (1 - float(margin_min))
            keep &= df["alibaba_price_min_usd"].notna()
            keep &= df["alibaba_price_min_usd"] <= max_allowed

    if has_moq:
        keep &= df["moq"].notna()
        keep &= df["moq"] <= int(moq_max)

    if has_rating:
        keep &= df["supplier_rating"].notna()
        keep &= df["supplier_rating"] >= float(min_rating)

    if is_verified_only:
        keep &= df["is_verified_supplier"].fillna(False).astype(bool)

    df_filtered = df[keep].reset_index(drop=True)
    print(f"Rows after filtering: {len(df_filtered)}")
    return df_filtered


# ─────────────────────────────────────────────────────────────────────────────
# FILENAME / DATE HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def extract_date_from_filename(key):
    fn = key.split("/")[-1] if isinstance(key, str) else ""
    m  = re.search(r"_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.json$", fn)
    if m:
        try:
            dt = datetime.strptime(m.group(1), "%Y-%m-%dT%H-%M-%SZ")
            return dt.strftime("%Y-%m-%d")
        except Exception:
            pass
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def generate_output_key(input_key: str, search_mode: str) -> str:
    timestamp = input_key.split("/")[-1].replace(".json", "")
    return f"clean/{search_mode}/alibaba/{timestamp}.parquet"


# ─────────────────────────────────────────────────────────────────────────────
# S3 READ → NORMALIZE → FILTER → WRITE
# ─────────────────────────────────────────────────────────────────────────────

COLS = [
    "keyword",
    "product_id",
    "title",
    "category",
    "search_category",
    "alibaba_price_min_usd",
    "alibaba_price_max_usd",
    "orders_count",
    "moq",
    "weight_kg",
    "ships_to_sv",
    "availability_status",
    "supplier_name",
    "supplier_country",
    "supplier_rating",
    "supplier_link",
    "gold_supplier_years",
    "review_count",
    "product_score",
    "service_score",
    "shipping_score",
    "is_verified_supplier",
    "is_trade_assurance",
    "capabilities",
    "geo",
    "data_collected_at",
    "source",
    "product_link",
]


def s3_json_to_table(input_bucket, input_key, output_bucket, output_key, filters, search_category):
    obj = s3.get_object(Bucket=input_bucket, Key=input_key)
    raw = json.load(obj["Body"])

    # Normalise the outer envelope
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict) and "items" in raw and isinstance(raw["items"], list):
        items = raw["items"]
    elif isinstance(raw, dict) and isinstance(raw.get("data", {}).get("content"), list):
        items = raw["data"]["content"]
    else:
        items = [raw] if isinstance(raw, dict) else []

    data_collected_at = extract_date_from_filename(input_key)
    normalized = []

    for it in items:
        try:
            keyword = it.get("keyword", "")
            if not keyword:
                print("[WARN] Item missing 'keyword' field; skipping.")
                continue
            normalized.append(normalize_item(it, data_collected_at, keyword, search_category))
        except Exception as exc:
            print("[WARN] normalize_item failed:", exc)
            continue

    df = pd.DataFrame(normalized, columns=COLS)
    original_count = len(df)

    # ── Coerce numeric types ──────────────────────────────────────────────────
    df["alibaba_price_min_usd"] = pd.to_numeric(df["alibaba_price_min_usd"], errors="coerce")
    df["alibaba_price_max_usd"] = pd.to_numeric(df["alibaba_price_max_usd"], errors="coerce")
    df["orders_count"]          = pd.to_numeric(df["orders_count"],          errors="coerce").astype("Int64")
    df["moq"]                   = pd.to_numeric(df["moq"],                   errors="coerce").astype("Int64")
    df["weight_kg"]             = pd.to_numeric(df["weight_kg"],             errors="coerce")
    df["supplier_rating"]       = pd.to_numeric(df["supplier_rating"],       errors="coerce")
    df["product_score"]         = pd.to_numeric(df["product_score"],         errors="coerce")
    df["service_score"]         = pd.to_numeric(df["service_score"],         errors="coerce")
    df["shipping_score"]        = pd.to_numeric(df["shipping_score"],        errors="coerce")
    df["review_count"]          = pd.to_numeric(df["review_count"],          errors="coerce").astype("Int64")
    df["gold_supplier_years"]   = pd.to_numeric(df["gold_supplier_years"],   errors="coerce").astype("Int64")

    # ── Apply filters ─────────────────────────────────────────────────────────
    df = apply_alibaba_filters(df, filters)

    # ── Hard cap on row count (size=0 / null = no cap, same as fetch lambdas) ─
    size = filters.get("size")
    try:
        size = int(size) if size is not None else None
    except (TypeError, ValueError):
        size = None
    if size is not None and size > 0:
        print(f"Applying results cap: {size}")
        df = df[:size]

    filtered_count = len(df)

    # ── Write output ──────────────────────────────────────────────────────────
    if PYARROW_AVAILABLE:
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp:
            tmp_path = tmp.name
        table = pa.Table.from_pandas(df)
        pq.write_table(table, tmp_path)
        s3.upload_file(tmp_path, output_bucket, output_key)
        try:
            os.remove(tmp_path)
        except Exception:
            pass
    else:
        # CSV fallback
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w", encoding="utf-8") as tmp:
            tmp_path = tmp.name
        df.to_csv(tmp_path, index=False)
        s3.upload_file(tmp_path, output_bucket, output_key.replace(".parquet", ".csv"))
        try:
            os.remove(tmp_path)
        except Exception:
            pass

    return original_count, filtered_count


# ─────────────────────────────────────────────────────────────────────────────
# LAMBDA HANDLER
# ─────────────────────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    try:
        print("[INFO] Alibaba clean lambda triggered:", event)

        input_bucket    = event.get("input_bucket")
        input_key       = event.get("input_key")
        search_mode     = event.get("search_mode") or "manual_search"
        search_category = event.get("search_category")

        if not input_bucket or not input_key:
            return {
                "stage":         "alibaba_clean",
                "status":        "FAILED",
                "message":       "Missing input_bucket or input_key",
                "rows_processed": 0,
            }

        if search_mode == "category_search" and not search_category:
            return {
                "stage":         "alibaba_clean",
                "status":        "FAILED",
                "message":       "Missing search_category for category search",
                "rows_processed": 0,
            }

        if search_mode == "manual_search":
            search_category = None

        filters = {
            "enable_alibaba":    event.get("enable_alibaba"),
            "margin_min":        event.get("margin_min"),
            "moq_max":           event.get("moq_max"),
            "min_rating":        event.get("supplier_rating_min"),
            "verified_supplier": event.get("verified_supplier"),
            "size":              event.get("size"),
        }

        output_key = generate_output_key(input_key, search_mode)

        # Ensure clean/ prefix exists
        try:
            s3.put_object(Bucket=OUTPUT_BUCKET, Key="clean/")
        except Exception:
            pass

        rows_before, rows_after = s3_json_to_table(
            input_bucket, input_key,
            OUTPUT_BUCKET, output_key,
            filters, search_category,
        )

        if rows_after == 0:
            return {
                "stage":              "alibaba_clean",
                "status":             "EMPTY",
                "message":            "No Alibaba products remained after filtering",
                "rows_processed":     rows_before,
                "rows_after_filtered": 0,
                "input_file":         f"s3://{input_bucket}/{input_key}",
                "output_file":        None,
            }

        ext = ".parquet" if PYARROW_AVAILABLE else ".csv"
        return {
            "stage":              "alibaba_clean",
            "status":             "SUCCEEDED",
            "message":            "Alibaba clean stage completed",
            "rows_processed":     rows_before,
            "rows_after_filtered": rows_after,
            "input_file":         f"s3://{input_bucket}/{input_key}",
            "output_file":        f"s3://{OUTPUT_BUCKET}/{output_key.replace('.parquet', ext)}",
        }

    except Exception as exc:
        print("[ERROR]", str(exc))
        return {
            "stage":         "alibaba_clean",
            "status":        "FAILED",
            "message":       "Alibaba clean stage failed",
            "error":         str(exc),
            "rows_processed": 0,
        }