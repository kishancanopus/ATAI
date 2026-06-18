# AMAZON CLEAN LAMBDA FUNCTION

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
        "amazon_price_usd": parse_int(safe_get(item, "price")),
        "reviews_count": parse_int(safe_get(item, "reviews_count")),
        "rating":parse_float(safe_get(item, "rating")),
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
# 🔥 FIXED FILTER FUNCTION (ROW BASED)
# -----------------------
def apply_amazon_filters(df, filters):

    if not filters.get("amazon_filters_on", False):
        print("🟡 Filters OFF")
        return df

    print("🟢 Applying Amazon filters")

    price_min = filters.get("price_min")
    price_max = filters.get("price_max")
    reviews_min = filters.get("reviews_min")
    reviews_max = filters.get("reviews_max")
    min_rating = filters.get("min_rating")

    filtered_rows = []

    print(f"📊 Before filter: {len(df)}")

    for _, row in df.iterrows():

        price = row.get("amazon_price_usd")
        reviews = row.get("reviews_count")
        rating = row.get("rating")

        # PRICE
        if price_min is not None and (price is None or price < float(price_min)):
            continue
        if price_max is not None and (price is None or price > float(price_max)):
            continue

        # REVIEWS
        if reviews_min is not None and (reviews is None or reviews < int(reviews_min)):
            continue
        if reviews_max is not None and (reviews is None or reviews > int(reviews_max)):
            continue

        # RATING
        if min_rating is not None and (rating is None or rating < float(min_rating)):
            continue

        filtered_rows.append(row)

    df_filtered = pd.DataFrame(filtered_rows)

    print(f"📊 After filter: {len(df_filtered)}")

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

    keyword = data.get("keyword")
    geo = data.get("country")

    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    normalized = []
    for it in items:
        try:
            normalized.append(normalize_item(it, keyword, geo, date, search_category))
        except Exception as e:
            print("Error:", e)

    df = pd.DataFrame(normalized)
    
    # Apply filters
    df = apply_amazon_filters(df, filters)
    size = filters.get("size")
    if isinstance(size, int) and size > 0:
        df = df[:size]

    # Write parquet
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".parquet")
    pq.write_table(pa.Table.from_pandas(df), tmp.name)

    s3.upload_file(tmp.name, output_bucket, output_key)

    # Extract Browse Nodes for Alibaba stage
    target_node = None
    fallback_node = None
    if not df.empty:
        full_cat = df.iloc[0].get("full_category", "")
        if isinstance(full_cat, str):
            parts = [c.strip() for c in full_cat.split(">") if c.strip()]
            if len(parts) >= 3:
                target_node, fallback_node = parts[2], parts[1]
            elif len(parts) >= 2:
                target_node, fallback_node = parts[1], parts[0]
            elif len(parts) >= 1:
                target_node, fallback_node = parts[0], parts[0]

    return len(df), target_node, fallback_node

# -----------------------
# Output Key
# -----------------------
def generate_output_key(input_key, search_mode):
    # ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    # return f"clean/{search_mode}/amazon/{ts}.parquet"

    timestamp = input_key.split("/")[-1].replace(".json", "")
    return f"clean/{search_mode}/amazon/{timestamp}.parquet"

# -----------------------
# 🚀 LAMBDA HANDLER
# -----------------------
def lambda_handler(event, context):
    try:
        print("🚀 Event:", event)

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

        filters = {
            "amazon_filters_on": event.get("enable_amazon", False),
            "price_min": event.get("amz_price_min"),
            "price_max": event.get("amz_price_max"),
            "reviews_min": event.get("reviews_min"),
            "reviews_max": event.get("reviews_max"),
            "min_rating": event.get("rating_min"),
            # "size": event.get("size")
        }

        print("🔍 Filters:", filters)

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
                "message": "No Amazon products remained after filtering",
                "rows_processed": 0,
                "target_browse_node": None,
                "fallback_browse_node": None,
                "output_file": None
            }


        return {
            "stage": "amazon_clean",
            "status": "SUCCEEDED",
            "message": "Amazon clean stage completed",
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


