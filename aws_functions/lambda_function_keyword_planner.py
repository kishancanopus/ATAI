import os
import json
import boto3
import uuid
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException

# ================= ENV CONFIG =================
DEVELOPER_TOKEN = os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"]
CLIENT_ID = os.environ["GOOGLE_ADS_CLIENT_ID"]
CLIENT_SECRET = os.environ["GOOGLE_ADS_CLIENT_SECRET"]
REFRESH_TOKEN = os.environ["GOOGLE_ADS_REFRESH_TOKEN"]
LOGIN_CUSTOMER_ID = os.environ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"]
CUSTOMER_ID = os.environ["GOOGLE_ADS_CUSTOMER_ID"]

S3_RAW_BUCKET = os.environ["S3_RAW_BUCKET"]
s3 = boto3.client("s3")

LANGUAGE_ID = "1000"
GEO_ID_MAP = {
    "US": "2840", "CA": "2124", "MX": "2484",
    "GT": "2320", "SV": "2222", "HN": "2340",
    "NI": "2558", "CR": "2188", "PA": "2591",
    "CO": "2170", "AR": "2032",
}

# # INIT GOOGLE ADS CLIENT
# def get_google_ads_client():
#     config = {
#         "developer_token": DEVELOPER_TOKEN,
#         "client_id": CLIENT_ID,
#         "client_secret": CLIENT_SECRET,
#         "refresh_token": REFRESH_TOKEN,
#         "login_customer_id": LOGIN_CUSTOMER_ID,
#         "use_proto_plus": True,
#     }
#     return GoogleAdsClient.load_from_dict(config)


# ================= CLIENT =================
def get_client():
    return GoogleAdsClient.load_from_dict({
        "developer_token": DEVELOPER_TOKEN,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": REFRESH_TOKEN,
        "login_customer_id": LOGIN_CUSTOMER_ID,
        "use_proto_plus": True,
    })

# ================= RETRY =================
def safe_api_call(func, retries=3):
    for i in range(retries):
        try:
            return func()
        except Exception as e:
            print(f"Retry {i+1} failed: {e}")
            time.sleep(2 ** i)
    return []

# ================= FETCH =================
def fetch_for_keyword(client, keyword, geo_code, geo_id):
    service = client.get_service("KeywordPlanIdeaService")

    request = client.get_type("GenerateKeywordIdeasRequest")
    request.customer_id = CUSTOMER_ID
    request.keyword_seed.keywords.append(keyword)
    request.geo_target_constants.append(f"geoTargetConstants/{geo_id}")
    request.language = f"languageConstants/{LANGUAGE_ID}"

    def api_call():
        return service.generate_keyword_ideas(request=request)

    response = safe_api_call(api_call)

    rows = []

    for idea in response:
        metrics = idea.keyword_idea_metrics
        if not metrics:
            continue

        monthly = [m.monthly_searches for m in metrics.monthly_search_volumes]

        cpc = None
        if metrics.low_top_of_page_bid_micros and metrics.high_top_of_page_bid_micros:
            cpc = round(
                (metrics.low_top_of_page_bid_micros + metrics.high_top_of_page_bid_micros)
                / 2 / 1_000_000,
                2
            )

        rows.append({
            "root_keyword": keyword,
            "sub_keyword": idea.text,
            "geo_country": geo_code,
            "avg_monthly_searches": metrics.avg_monthly_searches,
            "cpc_usd": cpc,
            "trend_direction": "rising" if monthly and monthly[-1] > monthly[0] else "stable",
            "source": "google_keyword_planner"
        })

    return rows

# ================= PARALLEL =================
def fetch_all(client, keywords, geo_code, geo_id):
    results = []

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [
            executor.submit(fetch_for_keyword, client, kw, geo_code, geo_id)
            for kw in keywords
        ]

        for f in as_completed(futures):
            results.extend(f.result())

    return results

# TREND DIRECTION
def get_trend_direction(monthly_volumes):

    if len(monthly_volumes) < 2:
        return "stable"

    if monthly_volumes[-1] > monthly_volumes[0]:
        return "rising"

    elif monthly_volumes[-1] < monthly_volumes[0]:
        return "falling"

    return "stable"


# FETCH KEYWORD PLANNER DATA
def fetch_keyword_planner_data(client, keywords, geo_code, geo_id):

    service = client.get_service("KeywordPlanIdeaService")

    lang_resource = f"languageConstants/{LANGUAGE_ID}"
    geo_resource = f"geoTargetConstants/{geo_id}"

    rows = []

    print(f"Fetching data for keywords in Geo ID: {geo_id} ({geo_code})")

    for root_keyword in keywords:

        request = client.get_type("GenerateKeywordIdeasRequest")
        request.customer_id = CUSTOMER_ID
        request.keyword_seed.keywords.append(root_keyword)
        request.geo_target_constants.append(geo_resource)
        request.language = lang_resource

        try:

            response = service.generate_keyword_ideas(request=request)

            for idea in response:

                metrics = idea.keyword_idea_metrics

                if not metrics:
                    continue

                monthly = [
                    m.monthly_searches
                    for m in metrics.monthly_search_volumes
                ]

                competition_map = {
                    1: 0.33,
                    2: 0.66,
                    3: 0.9
                }

                cpc_usd = None

                if (
                    metrics.low_top_of_page_bid_micros
                    and metrics.high_top_of_page_bid_micros
                ):
                    cpc_usd = round(
                        (
                            metrics.low_top_of_page_bid_micros
                            + metrics.high_top_of_page_bid_micros
                        ) / 2 / 1_000_000,
                        2
                    )

                rows.append({
                    "root_keyword": root_keyword,
                    "sub_keyword": idea.text,
                    "geo_country": geo_code,
                    "avg_monthly_searches": metrics.avg_monthly_searches,
                    "cpc_usd": cpc_usd,
                    "competition_index": competition_map.get(metrics.competition),
                    "trend_direction": get_trend_direction(monthly),
                    "data_collected_at": datetime.utcnow().strftime("%Y-%m-%d"),
                    "source": "google_keyword_planner"
                })

        except Exception as e:
            print(f"Error fetching for {root_keyword}: {e}")
            continue

    return rows


# SAVE TO S3
def save_to_s3(data, execution_timestamp):

    now = datetime.now(timezone.utc)

    yyyy = now.strftime("%Y")
    mm = now.strftime("%m")
    dd = now.strftime("%d")
    ts = now.strftime("%Y-%m-%dT%H-%M-%SZ")

    s3_key = (
        f"raw/google_keyword_planner/{yyyy}/{mm}/{dd}/keyword_planner_{execution_timestamp}.json"
    )

    s3.put_object(
        Bucket=S3_RAW_BUCKET,
        Key=s3_key,
        Body=json.dumps(data, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json"
    )

    return s3_key


# LAMBDA HANDLER
def lambda_handler(event, context):

    # -------- VALIDATE INPUT --------
    keywords = event.get("keyword")
    if not isinstance(keywords, list) or not keywords:
        return {
            "stage": "keyword_planner_fetch",
            "status": "FAILED",
            "message": "Invalid keyword input",
            "item_count": 0,
            "s3_bucket": None,
            "s3_key": None
        }
    execution_timestamp = event.get("timestamp")

    geo_code = event.get("geo", "US")
    geo_id = GEO_ID_MAP.get(geo_code, "2840")

    min_monthly_searches = event.get("min_monthly_searches")
    max_monthly_searches = event.get("max_monthly_searches")
    variant_limit_max = event.get("variant_limit")
    blacklisted_words = event.get("blacklisted_words", [])
    
    if blacklisted_words is None:
        blacklisted_words = []

    if isinstance(blacklisted_words, str):
        blacklisted_words = [blacklisted_words]
    blacklisted_words = [w.lower() for w in blacklisted_words]

    try:
        if min_monthly_searches is not None:
            min_monthly_searches = int(min_monthly_searches)
    except:
        min_monthly_searches = None

    try:
        if max_monthly_searches is not None:
            max_monthly_searches = int(max_monthly_searches)
    except:
        max_monthly_searches = None

    try:
        if variant_limit_max is not None:
            variant_limit_max = int(variant_limit_max)
    except:
        variant_limit_max = None

    print(f"Geo Code: {geo_code} -> Geo ID: {geo_id}")
    print(f"Min Searches: {min_monthly_searches}")
    print(f"Max Searches: {max_monthly_searches}")
    print(f"Variant Limit: {variant_limit_max}")
    print(f"Blacklist Keyword : {blacklisted_words}")

    # -------- FETCH KEYWORD DATA --------
    client = get_client()
    try:
        results = fetch_all(client, keywords, geo_code, geo_id)

    except GoogleAdsException as ex:
        return {
            "stage": "keyword_planner_fetch",
            "status": "FAILED",
            "message": "Google Ads API failed",
            "error": [e.message for e in ex.failure.errors],
            "item_count": 0,
            "s3_bucket": None,
            "s3_key": None
        }

    if not results:
        return {
            "stage": "keyword_planner_fetch",
            "status": "EMPTY",
            "message": "No keyword planner data returned",
            "item_count": 0,
            "limited_variants": {
                "selected_variants": []
            },
            "s3_bucket": None,
            "s3_key": None
        }

    if max_monthly_searches is not None and max_monthly_searches == 0:
        max_monthly_searches = None
        
    # APPLY MIN MAX FILTER
    filtered_results = []
    print("Applying Filters--------")
    for r in results:
        searches = r.get("avg_monthly_searches") or 0
        if min_monthly_searches is not None and searches < min_monthly_searches:
            continue
        if max_monthly_searches is not None and searches > max_monthly_searches:
            continue
        filtered_results.append(r)

    results = filtered_results

    # BLACKLIST FILTER
    if blacklisted_words and len(blacklisted_words) != 0:
        clean_results = []
        for r in results:
            keyword_text = r.get("sub_keyword", "").lower()
            if any(b in keyword_text for b in blacklisted_words):
                continue
            clean_results.append(r)
        results = clean_results

    # SORT BY SEARCH VOLUME
    results.sort(
        key=lambda x: x.get("avg_monthly_searches", 0) or 0,
        reverse=True
    )

    # LIMIT VARIANTS    
    if variant_limit_max and isinstance(variant_limit_max, int):
        results = results[:variant_limit_max]

    # SAVE TO S3
    s3_key = save_to_s3(results, execution_timestamp)

    # BUILD RESPONSE
    limited_variants = {
        "selected_variants": [
            {
                "keyword": r["sub_keyword"],
                "search_volume": r.get("avg_monthly_searches", 0),
                "cpc_usd": r.get("cpc_usd"),
                "trend": r.get("trend_direction")
            }
            for r in results
        ]
    }

    return {
        "stage": "keyword_planner_fetch",
        "status": "SUCCEEDED",
        "message": "Filtered Keyword Planner data saved to S3",
        "item_count": len(results),
        "limited_variants": limited_variants,
        "s3_bucket": S3_RAW_BUCKET,
        "s3_key": s3_key
    }