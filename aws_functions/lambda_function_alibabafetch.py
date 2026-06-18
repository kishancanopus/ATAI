import json
import os
import urllib.parse
import urllib.request
import urllib.error
import time
from datetime import datetime, timezone
import boto3

APIFY_BASE_URL = "https://api.apify.com/v2"
APIFY_TOKEN = os.environ.get("APIFY_TOKEN")
ACTOR_ID = os.environ.get("ACTOR_ID")
S3_RAW_BUCKET = os.environ.get("S3_RAW_BUCKET")

s3 = boto3.client("s3")


# =====================================================
# HELPERS
# =====================================================

def build_search_url(keyword):
    return f"https://www.alibaba.com/trade/search?keywords={urllib.parse.quote(keyword)}"


def api_request(url, method="GET", payload=None, timeout=30):
    req = urllib.request.Request(
        url,
        data=payload,
        method=method,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# =====================================================
# START ACTOR
# =====================================================

def start_actor(search_url, size):
    url = (
        f"{APIFY_BASE_URL}/acts/{ACTOR_ID}/runs"
        f"?token={APIFY_TOKEN}&waitForFinish=60"
    )

    payload = json.dumps({
        "search_url": search_url,
        "size": size,
        "skip_page_parameter": True
    }).encode("utf-8")

    return api_request(url, method="POST", payload=payload)


# =====================================================
# GET DATASET ITEMS
# =====================================================

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

    except Exception:
        return []


# =====================================================
# ABORT RUN
# =====================================================

def abort_run(run_id):
    try:
        url = (
            f"{APIFY_BASE_URL}/actor-runs/{run_id}/abort"
            f"?token={APIFY_TOKEN}"
        )
        api_request(url, method="POST")
        print(f"Run aborted: {run_id}")

    except Exception as e:
        print("Abort failed:", str(e))


# =====================================================
# SAVE TO S3
# =====================================================

def save_to_s3(run_id, items, keyword, timestamp):
    now = datetime.now(timezone.utc)

    key = (
        f"raw/alibaba/{ACTOR_ID}/"
        f"{now.strftime('%Y/%m/%d')}/"
        f"{run_id}_{timestamp}.json"
    )

    for row in items:
        row["keyword"] = keyword

    s3.put_object(
        Bucket=S3_RAW_BUCKET,
        Key=key,
        Body=json.dumps(items).encode("utf-8"),
        ContentType="application/json"
    )

    return key


# =====================================================
# MAIN
# =====================================================

def lambda_handler(event, context):
    start = time.time()

    try:
        keyword = event["keyword"]
        size = int(event.get("size", 10))
        timestamp = event.get("timestamp", datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ"))


        if size == 0:
            size = 25
            # print("[Lambda] Size is 0, skipping Apify call.")
            # s3_key = save_to_s3("size-zero-skip", [], keyword, timestamp)
            # return {
            #     "stage": "alibaba_fetch",
            #     "status": "SKIPPED",
            #     "message": "Alibaba fetch skipped because size=0",
            #     "data": {
            #         "keyword": keyword,
            #         "itemCount": 0,
            #         "s3_bucket": S3_RAW_BUCKET,
            #         "s3_key": s3_key
            #     }
            # }

        
        search_url = build_search_url(keyword)

        # -------------------------------------------------
        # Start Actor
        # -------------------------------------------------
        run = start_actor(search_url, size)["data"]

        run_id = run["id"]
        dataset_id = run["defaultDatasetId"]

        print("Started:", run_id)

        # -------------------------------------------------
        # Poll dataset
        # -------------------------------------------------
        items = []
        max_wait = 100
        interval = 3
        waited = 0

        while waited < max_wait:

            items = fetch_dataset(dataset_id, size)

            # Remove invalid rows
            items = [
                x for x in items
                if isinstance(x, dict) and "message" not in x
            ]

            print("Fetched:", len(items))

            # Enough rows received
            if len(items) >= size:
                items = items[:size]
                break

            time.sleep(interval)
            waited += interval

        # -------------------------------------------------
        # Abort actor after enough data
        # -------------------------------------------------
        abort_run(run_id)

        # -------------------------------------------------
        # No Data
        # -------------------------------------------------
        if len(items) == 0:
            return {
                "stage": "alibaba_fetch",
                "status": "EMPTY",
                "message": "No Alibaba products found",
                "data": {
                    "keyword": keyword,
                    "itemCount": 0
                }
            }

        # -------------------------------------------------
        # Save S3
        # -------------------------------------------------
        s3_key = save_to_s3(run_id, items, keyword, timestamp)

        return {
            "stage": "alibaba_fetch",
            "status": "SUCCEEDED",
            "message": "Alibaba fetch completed",
            "data": {
                "run_id": run_id,
                "itemCount": len(items),
                "s3_bucket": S3_RAW_BUCKET,
                "s3_key": s3_key,
                "keyword": keyword,
                "duration_sec": round(time.time() - start, 2)
            }
        }

    except Exception as e:
        err = str(e)
        message = "Alibaba fetch stage failed"
        if "Monthly usage hard limit exceeded" in err:
            message = (
                "Apify monthly usage limit exceeded. "
                "Upgrade your Apify plan or wait for the billing cycle to reset."
            )
        elif "HTTP 403" in err:
            message = "Apify access denied (HTTP 403). Check API token and account usage limits."
        return {
            "stage": "alibaba_fetch",
            "status": "FAILED",
            "message": message,
            "error": err,
            "data": None
        }