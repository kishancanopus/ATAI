# AMAZON CLEAN LAMBDA FUNCTION
# v3: Apply user price/reviews/rating filters in clean when UI values are provided.
# Missing filter keys (not null) mean "no filter" — keep all normalized rows.

import json
import os
import re
from datetime import datetime, timezone
import tempfile

import pandas as pd
import boto3
import pyarrow as pa
import pyarrow.parquet as pq

s3 = boto3.client("s3")

OUTPUT_BUCKET = os.environ.get("OUTPUT_BUCKET", "atai-clean-layer")

# -----------------------
# Helpers
# -----------------------
def safe_get(d, *keys):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return None


def pick_filter(src, key):
    """Return a filter value only when the key exists and is non-null."""
    if not isinstance(src, dict) or key not in src:
        return None
    val = src[key]
    return None if val is None else val


def filter_source(event):
    nested = event.get("filters")
    if isinstance(nested, dict):
        return nested
    return event if isinstance(event, dict) else {}


def parse_price(val):
    if val is None:
        return None
    if isinstance(val, dict):
        v = val.get("value") or val.get("amount")
        try:
            return float(v)
        except:
            return None
    if isinstance(val, (int, float)):
        return float(val)

    m = re.search(r"([\d\.,]+)", str(val))
    if m:
        try:
            return float(m.group(1).replace(",", ""))
        except:
            return None
    return None


def parse_int(val):
    if val is None:
        return None
    m = re.search(r"(\d+)", str(val).replace(",", ""))
    return int(m.group(1)) if m else None


def parse_float(val):
    if val is None:
        return None
    m = re.search(r"(\d+(\.\d+)?)", str(val).replace(",", ""))
    return float(m.group(1)) if m else None


# -----------------------
# Extractors
# -----------------------
def extract_category(item):
    cat = safe_get(item, "category", "categories")

    if isinstance(cat, str):
        parts = [c.strip() for c in cat.split(">") if c.strip()]
        return parts[-1] if parts else cat

    return cat


def extract_image_url(item):
    img = safe_get(item, "imageUrl", "image", "thumbnail")
    if isinstance(img, list):
        return img[0]
    return img


# -----------------------
# Normalize item
# -----------------------
def normalize_item(item, keyword, geo, date, search_category):
    return {
        "keyword": keyword,
        "asin": safe_get(item, "asin"),
        "title": safe_get(item, "title"),
        "category": extract_category(item),
        "search_category": search_category,
        "amazon_price_usd": parse_price(safe_get(item, "price")),
        "reviews_count": parse_int(safe_get(item, "reviews_count")),
        "rating": parse_float(safe_get(item, "rating")),
        "bestseller_rank": parse_int(safe_get(item, "bestseller_rank")),
        "brand": safe_get(item, "brand"),
        "in_stock": safe_get(item, "in_stock"),
        "image_url": safe_get(item, "image"),
        "geo": geo,
        "data_collected_at": date,
        "source": "amazon",
        "full_category": safe_get(item, "category", "categories")
    }


# -----------------------
# Filter function
# -----------------------
def apply_amazon_filters(df, filters):
    if df.empty:
        return df

    price_min = filters.get("price_min")
    price_max = filters.get("price_max")
    reviews_min = filters.get("reviews_min")
    reviews_max = filters.get("reviews_max")
    min_rating = filters.get("min_rating")

    def is_active_min(val):
        if val is None:
            return False
        try:
            return float(val) > 0
        except:
            return False

    def is_active_max(val):
        if val is None:
            return False
        try:
            fval = float(val)
            return fval > 0 and fval < 999999
        except:
            return False

    has_price_min = is_active_min(price_min)
    has_price_max = is_active_max(price_max)
    has_reviews_min = is_active_min(reviews_min)
    has_reviews_max = is_active_max(reviews_max)
    has_rating_min = is_active_min(min_rating)

    if not (has_price_min or has_price_max or has_reviews_min or has_reviews_max or has_rating_min):
        print("No active Amazon user filters — keeping all rows")
        return df

    print(
        "Applying Amazon filters:",
        f"price_min={has_price_min}",
        f"price_max={has_price_max}",
        f"reviews_min={has_reviews_min}",
        f"reviews_max={has_reviews_max}",
        f"rating_min={has_rating_min}",
    )
    print(f"Rows before filtering: {len(df)}")

    filtered_rows = []

    for _, row in df.iterrows():
        price = row.get("amazon_price_usd")
        reviews = row.get("reviews_count")
        rating = row.get("rating")

        if has_price_min:
            if price is None or price < float(price_min):
                continue
        if has_price_max:
            if price is None or price > float(price_max):
                continue
        if has_reviews_min:
            if reviews is None or reviews < int(reviews_min):
                continue
        if has_reviews_max:
            if reviews is None or reviews > int(reviews_max):
                continue
        if has_rating_min:
            if rating is None or rating < float(min_rating):
                continue

        filtered_rows.append(row)

    df_filtered = pd.DataFrame(filtered_rows)
    print(f"Rows after filtering: {len(df_filtered)}")
    return df_filtered


# -----------------------
# S3 Processing
# -----------------------
def s3_json_to_parquet(input_bucket, input_key, output_bucket, output_key, filters, search_category):
    obj = s3.get_object(Bucket=input_bucket, Key=input_key)
    data = json.load(obj["Body"])

    if isinstance(data, dict) and "items" in data:
        items = data["items"]
    elif isinstance(data, list):
        items = data
    else:
        items = [data]

    keyword = data.get("keyword") if isinstance(data, dict) else None
    geo = data.get("country") if isinstance(data, dict) else None

    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    normalized = []
    for it in items:
        try:
            normalized.append(normalize_item(it, keyword, geo, date, search_category))
        except Exception as e:
            print("Normalize error:", e)

    df = pd.DataFrame(normalized)
    print(f"Total normalized rows: {len(df)}")

    if df.empty:
        return 0, None, None

    df = apply_amazon_filters(df, filters)

    if df.empty:
        return 0, None, None

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".parquet")
    pq.write_table(pa.Table.from_pandas(df), tmp.name)
    s3.upload_file(tmp.name, output_bucket, output_key)

    target_node = None
    fallback_node = None
    full_cat = df.iloc[0].get("full_category", "")
    if isinstance(full_cat, str):
        parts = [c.strip() for c in full_cat.split(">") if c.strip()]
        if len(parts) >= 3:
            target_node, fallback_node = parts[2], parts[1]
        elif len(parts) >= 2:
            target_node, fallback_node = parts[1], parts[0]
        elif len(parts) >= 1:
            target_node, fallback_node = parts[0], parts[0]

    print(f"Browse nodes -> target={target_node} fallback={fallback_node}")

    return len(df), target_node, fallback_node


# -----------------------
# Output Key
# -----------------------
def generate_output_key(input_key, search_mode):
    timestamp = input_key.split("/")[-1].replace(".json", "")
    return f"clean/{search_mode}/amazon/{timestamp}.parquet"


def build_amazon_filters(event):
    src = filter_source(event)
    return {
        "amazon_filters_on": bool(pick_filter(src, "enable_amazon")),
        "price_min": pick_filter(src, "amz_price_min"),
        "price_max": pick_filter(src, "amz_price_max"),
        "reviews_min": pick_filter(src, "reviews_min"),
        "reviews_max": pick_filter(src, "reviews_max"),
        "min_rating": pick_filter(src, "rating_min"),
    }


# -----------------------
# LAMBDA HANDLER
# -----------------------
def lambda_handler(event, context):
    try:
        print("Event:", event)

        input_bucket = event.get("input_bucket")
        input_key = event.get("input_key")
        search_mode = event.get("search_mode", "manual_search")
        search_category = event.get("search_category")

        if not input_bucket or not input_key:
            return {
                "stage": "amazon_clean",
                "status": "FAILED",
                "message": "Missing input bucket or key",
                "rows_processed": 0
            }

        filters = build_amazon_filters(event)
        print("Amazon user filters:", filters)

        output_bucket = OUTPUT_BUCKET
        output_key = generate_output_key(input_key, search_mode)

        rows, target_node, fallback_node = s3_json_to_parquet(
            input_bucket,
            input_key,
            output_bucket,
            output_key,
            filters,
            search_category
        )

        if rows == 0:
            return {
                "stage": "amazon_clean",
                "status": "EMPTY",
                "message": "No Amazon products remained after normalization/filtering",
                "rows_processed": 0,
                "target_browse_node": None,
                "fallback_browse_node": None,
                "output_file": None
            }

        return {
            "stage": "amazon_clean",
            "status": "SUCCEEDED",
            "message": f"Amazon clean stage completed — {rows} rows written to Parquet",
            "rows_processed": rows,
            "target_browse_node": target_node,
            "fallback_browse_node": fallback_node,
            "output_file": f"s3://{output_bucket}/{output_key}"
        }

    except Exception as e:
        print("[ERROR]", str(e))
        return {
            "stage": "amazon_clean",
            "status": "FAILED",
            "message": "Amazon clean stage failed",
            "error": str(e),
            "rows_processed": 0
        }
