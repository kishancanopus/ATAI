import json
import os
import urllib.request
import time
from datetime import datetime, timezone
import boto3

# ─────────────────────────────────────────────────────────────────────────────
# REQUIRED LAMBDA ENVIRONMENT VARIABLES
# Set these in the AWS Lambda Console → Configuration → Environment variables
#
# ─────────────────────────────────────────────────────────────────────────────

APIFY_BASE_URL  = "https://api.apify.com/v2"
APIFY_TOKEN     = os.environ.get("APIFY_TOKEN")

# Actor ID — use env-var; fall back to the confirmed working actor slug
ACTOR_ID        = os.environ.get("ACTOR_ID_ALIBABA") or os.environ.get("ACTOR_ID")
S3_RAW_BUCKET   = os.environ.get("S3_RAW_BUCKET")

s3 = boto3.client("s3")


# ─────────────────────────────────────────────
# LOW-LEVEL HTTP
# ─────────────────────────────────────────────

def api_request(url, method="GET", payload=None, timeout=30):
    req = urllib.request.Request(
        url,
        data=payload,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ─────────────────────────────────────────────
# START ACTOR
# ─────────────────────────────────────────────

def start_actor(keyword, max_items):
    """
    Alibaba Category Scraper input schema:
      searchKeywords  (string)   – the keyword(s) to search
      maxItems        (integer)  – max products to collect (1-10000)
    """
    url = (
        f"{APIFY_BASE_URL}/acts/{ACTOR_ID}/runs"
        f"?token={APIFY_TOKEN}&waitForFinish=60"
    )

    payload = json.dumps({
        "searchKeywords": keyword,
        "maxItems": max_items,
    }).encode("utf-8")

    return api_request(url, method="POST", payload=payload)


# ─────────────────────────────────────────────
# FETCH DATASET ITEMS
# ─────────────────────────────────────────────

def fetch_dataset(dataset_id, limit):
    url = (
        f"{APIFY_BASE_URL}/datasets/{dataset_id}/items"
        f"?token={APIFY_TOKEN}"
        f"&clean=true"
        f"&format=json"
        f"&limit={limit}"
    )
    try:
        return api_request(url)
    except Exception as exc:
        print("[WARN] fetch_dataset error:", exc)
        return []


# ─────────────────────────────────────────────
# ABORT RUN
# ─────────────────────────────────────────────

def abort_run(run_id):
    try:
        url = (
            f"{APIFY_BASE_URL}/actor-runs/{run_id}/abort"
            f"?token={APIFY_TOKEN}"
        )
        api_request(url, method="POST")
        print(f"[INFO] Run aborted: {run_id}")
    except Exception as exc:
        print("[WARN] Abort failed:", exc)


# ─────────────────────────────────────────────
# SAVE TO S3
# ─────────────────────────────────────────────

def save_to_s3(run_id, items, keyword, timestamp):
    now = datetime.now(timezone.utc)
    key = (
        f"raw/alibaba/{ACTOR_ID}/"
        f"{now.strftime('%Y/%m/%d')}/"
        f"{run_id}_{timestamp}.json"
    )

    # Stamp each row with the search keyword so the clean step can read it
    for row in items:
        row["keyword"] = keyword

    s3.put_object(
        Bucket=S3_RAW_BUCKET,
        Key=key,
        Body=json.dumps(items).encode("utf-8"),
        ContentType="application/json",
    )
    return key


# ─────────────────────────────────────────────
# LAMBDA HANDLER
# ─────────────────────────────────────────────

def lambda_handler(event, context):
    start = time.time()

    try:
        keyword   = event["keyword"]
        size      = int(event.get("size", 10))
        timestamp = event.get(
            "timestamp",
            datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ"),
        )

        # If size is 0, default to 25 so we always get some data
        if size == 0:
            size = 25

        # ── Start actor ──────────────────────────────────────
        print(f"[INFO] Starting Alibaba Category Scraper | keyword={keyword!r} | maxItems={size}")
        run = start_actor(keyword, size)["data"]

        run_id     = run["id"]
        dataset_id = run["defaultDatasetId"]
        print(f"[INFO] Run started: {run_id}")

        # ── Poll dataset until we have enough rows ────────────
        items    = []
        max_wait = 120   # seconds
        interval = 5
        waited   = 0

        while waited < max_wait:
            items = fetch_dataset(dataset_id, size)

            # Drop error-sentinel rows (actor sometimes emits {message: "..."})
            items = [x for x in items if isinstance(x, dict) and "message" not in x]

            print(f"[INFO] Fetched {len(items)} items (waited {waited}s)")

            if len(items) >= size:
                items = items[:size]
                break

            time.sleep(interval)
            waited += interval

        # ── Abort actor to save Apify compute units ───────────
        abort_run(run_id)

        # ── No data ───────────────────────────────────────────
        if not items:
            return {
                "stage":   "alibaba_fetch",
                "status":  "EMPTY",
                "message": "No Alibaba products found",
                "data": {
                    "keyword":   keyword,
                    "itemCount": 0,
                },
            }

        # ── Persist to S3 ─────────────────────────────────────
        s3_key = save_to_s3(run_id, items, keyword, timestamp)

        return {
            "stage":   "alibaba_fetch",
            "status":  "SUCCEEDED",
            "message": "Alibaba fetch completed",
            "data": {
                "run_id":       run_id,
                "itemCount":    len(items),
                "s3_bucket":    S3_RAW_BUCKET,
                "s3_key":       s3_key,
                "keyword":      keyword,
                "duration_sec": round(time.time() - start, 2),
            },
        }

    except Exception as exc:
        err = str(exc)
        message = "Alibaba fetch stage failed"
        if "Monthly usage hard limit exceeded" in err:
            message = (
                "Apify monthly usage limit exceeded. "
                "Upgrade your Apify plan or wait for the billing cycle to reset."
            )
        elif "HTTP 403" in err or "403" in err:
            message = "Apify access denied (HTTP 403). Check API token and account usage limits."
        elif "HTTP 404" in err or "404" in err:
            message = (
                "Apify actor not found (HTTP 404). "
                "Verify ACTOR_ID_ALIBABA env-var matches the 'Alibaba Category Scraper' actor ID."
            )

        print(f"[ERROR] {message} | {err}")
        return {
            "stage":   "alibaba_fetch",
            "status":  "FAILED",
            "message": message,
            "error":   err,
            "data":    None,
        }