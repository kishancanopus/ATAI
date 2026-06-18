import os
import json
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone
import time
import boto3

# ---------- ENV VARS ----------
APIFY_TOKEN = os.environ.get("APIFY_TOKEN")
ACTOR_ID = os.environ.get("ACTOR_ID")
APIFY_BASE_URL = "https://api.apify.com/v2"
S3_RAW_BUCKET = os.environ.get("S3_RAW_BUCKET")

# boto3 client
s3_client = boto3.client("s3")


# ---------- HELPERS ----------

def build_search_url(keyword: str) -> str:
    return f"https://www.amazon.com/s?k={urllib.parse.quote(keyword)}"


def start_apify_actor(keyword: str, country: str = "US", size: int = 10, wait_seconds: int = 100):
    """
    Start Apify actor.
    Reduced wait to 60s to leave room for polling inside Lambda.
    """

    print(f"[Apify] Starting actor | keyword={keyword} | size={size}")
    if not APIFY_TOKEN:
        raise RuntimeError("APIFY_TOKEN env var is not set")
    if not ACTOR_ID:
        raise RuntimeError("ACTOR_ID env var is not set")

    run_url = f"{APIFY_BASE_URL}/acts/{ACTOR_ID}/runs"
    query = urllib.parse.urlencode({
        "token": APIFY_TOKEN,
        "waitForFinish": wait_seconds
    })
    full_run_url = f"{run_url}?{query}"
    search_url = build_search_url(keyword)
    input_body = {
        "categoryOrProductUrls": [
        {"url": search_url}
    ],
        "categoryUrls": [{"url": search_url}],
        "startUrls": [{"url": search_url}],
        "searchUrls": [search_url],
        "searchKeywords": [keyword],
        "searchKeywordsRaw": keyword,
        "maxItemsPerStartUrl": size,
        "maxSearchPagesPerStartUrl": 3,
        "scrapeProductDetails": True,
        "scrapeProductVariantPrices": False,
        "maxProductsVariantsAsSeparateResults": 0
    }

    print("[Apify] Actor input:", json.dumps(input_body, indent=2))

    data_bytes = json.dumps(input_body).encode("utf-8")
    req = urllib.request.Request(
        full_run_url,
        data=data_bytes,
        method="POST",
        headers={"Content-Type": "application/json"}
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            run_json = json.loads(resp.read().decode("utf-8"))
            print("[Apify] Run started:", run_json)
            return run_json
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Apify start run failed (HTTP {e.code}): {body}")
    except Exception as e:
        raise RuntimeError(f"Apify start run failed: {e}")


def fetch_dataset_items(dataset_id: str, clean: bool = True):
    """
    Fetch dataset items from Apify.
    """
    if not APIFY_TOKEN:
        raise RuntimeError("APIFY_TOKEN env var is not set")

    items_url = f"{APIFY_BASE_URL}/datasets/{dataset_id}/items"
    items_query = urllib.parse.urlencode({
        "token": APIFY_TOKEN,
        "clean": "true" if clean else "false",
        "format": "json"
    })
    full_items_url = f"{items_url}?{items_query}"

    req = urllib.request.Request(full_items_url, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=50) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Apify dataset fetch failed (HTTP {e.code}): {body}")
    except Exception as e:
        raise RuntimeError(f"Apify dataset fetch failed: {e}")


def abort_apify_run(run_id: str):
    url = f"{APIFY_BASE_URL}/actor-runs/{run_id}/abort?token={APIFY_TOKEN}"

    req = urllib.request.Request(url, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            print(f"[Apify] Run aborted successfully: {run_id}")
            return result
    except Exception as e:
        print(f"[Apify] Abort failed: {e}")

def save_raw_to_s3(run_id: str, payload, execution_timestamp, actor_id: str = None):
    """
    Save JSON to S3 with timestamped path.
    """
    if not S3_RAW_BUCKET:
        raise RuntimeError("S3_RAW_BUCKET env var is not set")

    now = datetime.now(timezone.utc)
    yyyy = now.strftime("%Y")
    mm = now.strftime("%m")
    dd = now.strftime("%d")
    file_timestamp = now.strftime("%Y-%m-%dT%H-%M-%SZ")

    s3_key = f"raw/amazon/{actor_id}/{yyyy}/{mm}/{dd}/{run_id}_{execution_timestamp}.json"

    body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    s3_client.put_object(
        Bucket=S3_RAW_BUCKET,
        Key=s3_key,
        Body=body_bytes,
        ContentType="application/json"
    )

    print(f"[S3] Saved to: s3://{S3_RAW_BUCKET}/{s3_key}")
    return s3_key


def transform_items(items):
    cleaned = []

    for i in items:
        cleaned.append({
            "title": i.get("title"),
            "asin": i.get("asin"),
            "category": i.get("breadCrumbs"),
            "price": (i.get("price") or {}).get("value"),
            "currency": (i.get("price") or {}).get("currency"),
            "rating": i.get("stars"),
            "reviews_count": i.get("reviewsCount"),
            "bestseller_rank": (i.get("bestsellerRanks")[0]["rank"] if i.get("bestsellerRanks") else None),
            "brand": i.get("brand"),
            "in_stock": i.get("inStock"),
            "image": i.get("thumbnailImage"),
            "product_url": i.get("url")
        })

    return cleaned

def safe_int(val):
    if val is None:
        return None
    if isinstance(val, int):
        return val
    try:
        return int(str(val).strip())
    except:
        return None

import re

def normalize_text(text):
    if not text:
        return ""

    text = text.lower()
    text = re.sub(r'[^a-z0-9\s]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()

    return text


def calculate_relevance_score(keyword, item):
    """
    Lightweight keyword-to-product relevance scoring.
    """

    keyword_norm = normalize_text(keyword)
    title_norm = normalize_text(item.get("title", ""))

    keyword_words = keyword_norm.split()

    score = 0

    # ---------------------------------------------------
    # 1. Exact phrase match
    # ---------------------------------------------------
    if keyword_norm in title_norm:
        score += 100

    # ---------------------------------------------------
    # 2. Full word coverage
    # ---------------------------------------------------
    matched_words = 0

    for word in keyword_words:
        if word in title_norm:
            matched_words += 1
            score += 15

    if matched_words == len(keyword_words):
        score += 50

    # ---------------------------------------------------
    # 3. Prefix / fuzzy-ish match
    # ---------------------------------------------------
    for word in keyword_words:
        title_words = title_norm.split()

        for tw in title_words:
            if tw.startswith(word[:4]):
                score += 3

    # ---------------------------------------------------
    # 4. Organic boost
    # ---------------------------------------------------
    if not item.get("isSponsored"):
        score += 20

    # ---------------------------------------------------
    # 5. Rating boost
    # ---------------------------------------------------
    rating = item.get("stars") or 0
    reviews = item.get("reviewsCount") or 0

    try:
        score += float(rating) * 2
    except:
        pass

    try:
        if int(reviews) > 100:
            score += 5
    except:
        pass

    return score


# ---------- MAIN HANDLER ----------

def lambda_handler(event, context):
    try:
        keyword = event.get("keyword")
        if not keyword:
            raise ValueError("Missing required field: keyword")
        execution_timestamp = event.get("timestamp")
        country = event.get("country", "US")
        size = safe_int(event.get("size", 10))

        if size == 0:
            size = 25
            # print("[Lambda] Size is 0, skipping Apify call.")
            # payload = {
            #     "keyword": keyword,
            #     "country": country,
            #     "items": []
            # }
            # s3_key = save_raw_to_s3("size-zero-skip", payload, execution_timestamp, actor_id=ACTOR_ID)
            # return {
            #     "status": "SUCCESS",
            #     "message": "Result cap is 0, skipping Apify call",
            #     "itemCount": 0,
            #     "s3_bucket": S3_RAW_BUCKET,
            #     "s3_key": s3_key
            # }

        # 1) Start Apify actor (60s wait to fit timeout)
        run_resp = start_apify_actor(keyword, country, size, wait_seconds=60)
        run_data = run_resp.get("data") or run_resp

        run_id = run_data.get("id") or run_resp.get("id")
        print("[Lambda] RUN ID:", run_id)

        dataset_id = run_data.get("defaultDatasetId") or run_data.get("datasetId")
        if not dataset_id:
            raise RuntimeError(
                f"No dataset id found in run response: {json.dumps(run_data)[:1000]}"
            )

        print("[Lambda] Dataset ID:", dataset_id)

        # 2) POLL DATASET — tuned for 2 minutes
        max_retries = 4          # total ~80 seconds of waiting
        wait_each = 20           # seconds between checks
        items = []

        for i in range(max_retries):
            items = fetch_dataset_items(dataset_id, clean=True)
            print(f"[Lambda] Attempt {i+1} — items found:", len(items))

            if len(items) > 0:
                break

            print(f"[Lambda] Waiting {wait_each}s for Apify to write data...")
            time.sleep(wait_each)

        if len(items) == 0:
                print("[Lambda] No items fetched from Apify")
                abort_apify_run(run_id)
                return {
                    "stage": "amazon_fetch",
                    "status": "EMPTY",
                    "message": "No Amazon products found on Apify",
                    "actorRunId": run_id,
                    "itemCount": 0,
                    "items": [],
                    "s3_bucket": None,
                    "s3_key": None
                    }

        # 3) Process Results: Word count logic & Organic Filter
        # Requirement: 
        # 1 word -> broad category (Breadcrumb Level 1)
        # 2 words -> specific category (Breadcrumb Level 2)
        # 3+ words -> specific subcategory (Breadcrumb Level 3)
        
        word_count = len(keyword.split())
        target_breadcrumb_level = 1 if word_count == 1 else (2 if word_count == 2 else 3)
        
        print(f"[Lambda] Keyword words={word_count}, Target Breadcrumb Depth={target_breadcrumb_level}")

        # Filter for organic ONLY and favor the target depth
        organic_items = [it for it in items if not it.get("isSponsored")]
        
        if len(organic_items) == 0:
            print("[Lambda] No organic items found; falling back to all items.")
            organic_items = items

        # Cap results to requested size (applied here to final processed list)
        # if size > 0:
        #      organic_items = organic_items[:size]

        # cleaned_items = transform_items(organic_items)

        # ---------------------------------------------------
        # Relevance Ranking Layer
        # ---------------------------------------------------

        scored_items = []

        for item in organic_items:
            relevance_score = calculate_relevance_score(keyword, item)

            item["relevance_score"] = relevance_score

            scored_items.append(item)

        # Sort by highest relevance
        scored_items.sort(
            key=lambda x: x.get("relevance_score", 0),
            reverse=True
        )

        print("[Lambda] Top ranked products:")

        for idx, item in enumerate(scored_items[:5]):
            print(
                f"{idx+1}. Score={item.get('relevance_score')} | "
                f"Title={item.get('title')}"
            )

        # Final result limit
        final_items = scored_items[:size]

        cleaned_items = transform_items(final_items)
        
        payload = {
            "keyword": keyword,
            "country": country,
            "target_breadcrumb_level": target_breadcrumb_level,
            "items": cleaned_items
        }

        # 4) Save to S3
        s3_key = save_raw_to_s3(run_id, payload, execution_timestamp, actor_id=ACTOR_ID,)

        # Abort Apify Actor
        print("[Lambda] Aborting Apify run to stop further crawling...")
        abort_apify_run(run_id)

        return {
            "stage": "amazon_fetch",
            "status": "SUCCEEDED",
            "message": "Amazon raw dataset saved to S3",
            "actorRunId": run_id,
            "itemCount": len(items),
            "s3_bucket": S3_RAW_BUCKET,
            "s3_key": s3_key
        }

    except Exception as e:
        err = str(e)
        print("[ERROR]", err)
        message = "Amazon fetch stage failed"
        if "Monthly usage hard limit exceeded" in err:
            message = (
                "Apify monthly usage limit exceeded. "
                "Upgrade your Apify plan or wait for the billing cycle to reset."
            )
        elif "HTTP 403" in err:
            message = "Apify access denied (HTTP 403). Check API token and account usage limits."
        elif "HTTP 401" in err:
            message = "Apify authentication failed (HTTP 401). Check APIFY_TOKEN configuration."
        return {
            "stage": "amazon_fetch",
            "status": "FAILED",
            "message": message,
            "error": err,
            "itemCount": 0,
            "s3_bucket": None,
            "s3_key": None
        }

