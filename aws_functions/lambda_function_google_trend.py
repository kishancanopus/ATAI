# # import json
# # import os
# # import boto3
# # import requests
# # import uuid
# # import time
# # from datetime import datetime, timezone
# # from concurrent.futures import ThreadPoolExecutor, as_completed
# # from pytrends.request import TrendReq

# # # ================= CONFIG =================
# # s3 = boto3.client("s3")

# # S3_RAW_BUCKET = os.environ["S3_RAW_BUCKET"]
# # SERPAPI_KEY = os.environ["SERPAPI_KEY"]
# # SERPAPI_ENDPOINT = "https://serpapi.com/search.json"

# # MAX_WORKERS = 3  # IMPORTANT: avoid 429

# # # ================= PYTRENDS =================
# # def get_pytrends():
# #     return TrendReq(hl="en-US", tz=360)

# # # ================= RETRY =================
# # def retry(func, retries=3):
# #     for i in range(retries):
# #         try:
# #             return func()
# #         except Exception as e:
# #             print(f"Retry {i+1} failed: {e}")
# #             time.sleep(2 ** i)
# #     raise RuntimeError("All retries failed")

# # # ================= FETCH =================
# # def fetch_pytrends(keyword, geo, timeframe):
# #     pytrends = get_pytrends()
# #     pytrends.build_payload([keyword], geo=geo, timeframe=timeframe)
# #     df = pytrends.interest_over_time()

# #     if df is None or df.empty:
# #         raise RuntimeError("Empty pytrends data")

# #     return [int(x) for x in df[keyword].tolist() if x >= 0]

# # def fetch_serpapi(keyword, geo, timeframe):
# #     params = {
# #         "engine": "google_trends",
# #         "q": keyword,
# #         "geo": geo,
# #         "date": timeframe,
# #         "data_type": "TIMESERIES",
# #         "api_key": SERPAPI_KEY,
# #     }

# #     r = requests.get(SERPAPI_ENDPOINT, params=params, timeout=30)
# #     r.raise_for_status()

# #     data = r.json()
# #     timeline = data.get("interest_over_time", {}).get("timeline_data", [])

# #     points = []
# #     for item in timeline:
# #         v = item.get("values", [{}])[0].get("value")
# #         if isinstance(v, list):
# #             v = v[0]
# #         try:
# #             points.append(int(v))
# #         except:
# #             pass

# #     if not points:
# #         raise RuntimeError("No data from SerpAPI")

# #     return points

# # def fetch_trend(keyword, geo, timeframe):
# #     try:
# #         return retry(lambda: fetch_pytrends(keyword, geo, timeframe))
# #     except:
# #         return retry(lambda: fetch_serpapi(keyword, geo, timeframe))

# # # ================= ANALYSIS =================
# # def analyze(keyword, geo, timeframe, window_months):
# #     try:
# #         points = fetch_trend(keyword, geo, timeframe)

# #         avg = round(sum(points) / len(points), 2)
# #         peak = max(points)

# #         if len(points) >= 6:
# #             last3 = sum(points[-3:]) / 3
# #             prev3 = sum(points[-6:-3]) / 3
# #         else:
# #             last3 = points[-1]
# #             prev3 = points[0]

# #         if prev3 == 0:
# #             trend = "stable"
# #             pct = 0
# #         else:
# #             pct = round(((last3 - prev3) / prev3) * 100, 2)
# #             trend = "rising" if pct > 5 else "falling" if pct < -5 else "stable"

# #         return {
# #             "keyword": keyword,
# #             "geo_code": geo,
# #             "window_months": window_months,
# #             "gt_interest_avg": avg,
# #             "gt_interest_peak": peak,
# #             "gt_interest_trend": trend,
# #             "gt_interest_change_pct": pct,
# #             "source": "google_trends"
# #         }

# #     except Exception as e:
# #         print(f"[FAIL] {keyword}: {e}")
# #         return None

# # # ================= TIMEFRAME =================
# # def get_timeframe(window_months):
# #     if window_months <= 1:
# #         return "today 1-m"
# #     elif window_months <= 3:
# #         return "today 3-m"
# #     elif window_months <= 12:
# #         return "today 12-m"
# #     return "today 5-y"

# # # ================= SAVE TO S3 =================
# # def save_results(results, execution_timestamp):

# #     now = datetime.now(timezone.utc)

# #     yyyy = now.strftime("%Y")
# #     mm = now.strftime("%m")
# #     dd = now.strftime("%d")

# #     timestamp = now.strftime("%Y-%m-%dT%H-%M-%SZ")

# #     key = f"raw/google_trends/{yyyy}/{mm}/{dd}/google_trends_{execution_timestamp}.json"

# #     s3.put_object(
# #         Bucket=S3_RAW_BUCKET,
# #         Key=key,
# #         Body=json.dumps(results).encode("utf-8"),
# #         ContentType="application/json",
# #     )

# #     return key


# # # ================= TRENDING SEARCHES =================
# # def get_trending_searches_pytrends(geo="US"):

# #     pytrends = get_pytrends()

# #     try:

# #         trending_df = pytrends.trending_searches(pn=geo)

# #         if trending_df is None or trending_df.empty:
# #             return []

# #         return trending_df[0].head(20).tolist()

# #     except Exception as e:
# #         print(f"Pytrends trending error: {e}")
# #         return []


# # # ================= LAMBDA HANDLER =================
# # def lambda_handler(event, context):

# #     mode = event.get("search_mode", "manual_search")

# #     # TRENDING MODE
# #     if mode == "trending":

# #         geo_code = event.get("geo", "US")

# #         trending_keywords = get_trending_searches_pytrends(geo_code)

# #         if not trending_keywords:
# #             return {
# #                 "mode": "trending",
# #                 "warning": "No trending keywords found",
# #                 "results": [],
# #             }

# #         results = [
# #             {
# #                 "keyword": kw,
# #                 "geo_code": geo_code,
# #                 "source": "google_trends_trending",
# #                 "data_collected_at": datetime.utcnow().strftime("%Y-%m-%d"),
# #             }
# #             for kw in trending_keywords
# #         ]

# #         return {
# #             "mode": "trending",
# #             "trending_keywords": trending_keywords,
# #             "results": results,
# #         }

# #     # ================= INPUT =================
# #     keywords = event.get("keyword")
# #     geo_code = event.get("geo")
# #     window_months = int(event.get("trend_window_months", 12))
# #     execution_timestamp = event.get("timestamp")
# #     if not keywords:
# #         raise ValueError("keyword is required")

# #     if not geo_code:
# #         raise ValueError("geo is required")

# #     if isinstance(keywords, str):
# #         keywords = [keywords]

# #     min_trend_score = event.get("min_trend_score")

# #     try:
# #         if min_trend_score is not None:
# #             min_trend_score = float(min_trend_score)
# #     except:
# #         min_trend_score = None

# #     # ================= COLLECT =================
# #     timeframe = get_timeframe(window_months)
# #     results = []

# #     with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
# #         futures = [
# #             executor.submit(analyze, kw, geo_code, timeframe, window_months)
# #             for kw in keywords
# #         ]

# #         for f in as_completed(futures):
# #             r = f.result()
# #             if r:
# #                 results.append(r)

# #     print("final result")
# #     print(results)
# #     if not results:
# #         raise RuntimeError("No Google Trends data collected")
# #         return {
# #             "status": "filtered_empty",
# #             "message": "No Google Trends data could be collected for any keyword (both pytrends and SerpAPI failed)",
# #             "raw_count": 0,
# #             "filtered_count": 0,
# #         }

# #     # ================= FILTER =================
# #     filtered_results = [
# #         r for r in results if r["geo_code"] == geo_code
# #     ]

# #     filtered_results = [
# #         r for r in filtered_results if r["window_months"] == window_months
# #     ]

# #     if min_trend_score is not None:

# #         filtered_results = [
# #             r
# #             for r in filtered_results
# #             if (r.get("gt_interest_avg") or 0) >= min_trend_score
# #         ]

# #     if not filtered_results:

# #         return {
# #             "status": "filtered_empty",
# #             "message": "All keywords removed by filters",
# #             "raw_count": len(results),
# #             "filtered_count": 0,
# #         }

# #     # ================= SAVE =================
# #     s3_key = save_results(filtered_results, execution_timestamp)

# #     return {
# #         "status": "success",
# #         "filtered_count": len(filtered_results),
# #         "s3_bucket": S3_RAW_BUCKET,
# #         "s3_key": s3_key,
# #         "results": filtered_results,
# #     }


# # lambda_function.py
# # Google Trends Lambda
# # FULLY COMPATIBLE WITH YOUR STEP FUNCTION
# # lambda_function.py
# # GOOGLE TRENDS LAMBDA
# # UPGRADED FOR 30 VARIANTS
# # Step Function Ready
# # Fast Batched Processing

import json
import os
import time
import boto3
import requests
from datetime import datetime, timezone
from pytrends.request import TrendReq

# ======================================================
# CONFIG
# ======================================================

s3 = boto3.client("s3")

S3_RAW_BUCKET = os.environ["S3_RAW_BUCKET"]
SERPAPI_KEY = os.environ.get("SERPAPI_KEY", "")

SERPAPI_ENDPOINT = "https://serpapi.com/search.json"

MAX_KEYWORDS = 30
BATCH_SIZE = 5
GLOBAL_TIMEOUT = 55
REQUEST_TIMEOUT = 8
# Weeks at or above this interest level count toward GT Sustainability (0–100).
GT_SUSTAINABILITY_THRESHOLD = 30


# ======================================================
# HELPERS
# ======================================================

def now():
    return time.time()


def get_pytrends():
    return TrendReq(
        hl="en-US",
        tz=360,
        timeout=(4, 8)
    )


def get_timeframe(months):

    if months <= 1:
        return "today 1-m"
    elif months <= 3:
        return "today 3-m"
    elif months <= 12:
        return "today 12-m"

    return "today 5-y"


def chunk(lst, size):
    for i in range(0, len(lst), size):
        yield lst[i:i + size]


# ======================================================
# PYTRENDS BATCH
# ======================================================

def fetch_batch(keywords, geo, timeframe):

    try:
        py = get_pytrends()

        py.build_payload(
            keywords,
            geo=geo,
            timeframe=timeframe
        )

        df = py.interest_over_time()

        if df is None or df.empty:
            return {}

        result = {}

        for kw in keywords:

            if kw not in df.columns:
                continue

            vals = []

            for x in df[kw].tolist():
                try:
                    vals.append(int(x))
                except:
                    pass

            if vals:
                result[kw] = vals

        return result

    except Exception as e:
        print(f"PyTrends Batch failed for {keywords}: {e}")
        return {}


# ======================================================
# SERPAPI FALLBACK
# ======================================================

def fetch_serpapi_batch(keywords, geo, timeframe):

    if not SERPAPI_KEY or not keywords:
        return {}

    try:
        # Create a mapping for case-insensitive lookup
        kw_map = {kw.lower().strip(): kw for kw in keywords}
        
        q_str = ",".join(keywords)
        params = {
            "engine": "google_trends",
            "q": q_str,
            "geo": geo,
            "date": timeframe,
            "data_type": "TIMESERIES",
            "api_key": SERPAPI_KEY
        }

        r = requests.get(
            SERPAPI_ENDPOINT,
            params=params,
            timeout=REQUEST_TIMEOUT
        )

        if r.status_code != 200:
            print(f"SerpApi Error: {r.status_code} - {r.text} | Params: {params}")
            return {}

        data = r.json()
        print(f"SerpApi Response received for {len(keywords)} keywords.")

        rows = data.get(
            "interest_over_time",
            {}
        ).get(
            "timeline_data",
            []
        )

        # Initialize result with empty lists for only the keywords we sent
        result_dict = {kw: [] for kw in keywords}

        for row in rows:
            values = row.get("values", [])
            for item in values:
                raw_q = item.get("query", "").lower().strip()
                # Use fuzzy match or exact lower match
                if raw_q in kw_map:
                    target_kw = kw_map[raw_q]
                    try:
                        v = item.get("value")
                        if isinstance(v, list):
                            v = v[0]
                        result_dict[target_kw].append(int(v))
                    except:
                        pass

        # Return only keywords that actually have data
        return {k: v for k, v in result_dict.items() if v}

    except Exception as e:
        print("SerpApi fallback error:", e)
        return {}


# ======================================================
# ANALYZE
# ======================================================

def compute_sustainability(pts, threshold=GT_SUSTAINABILITY_THRESHOLD):
    """Share of weeks (0–100) where interest stayed at or above the threshold."""
    if not pts:
        return 0
    weeks_above = sum(1 for p in pts if p >= threshold)
    return round((weeks_above / len(pts)) * 100, 2)


def analyze(keyword, pts, geo, months):

    if not pts:
        return None

    avg = round(sum(pts) / len(pts), 2)
    peak = max(pts)
    sustainability = compute_sustainability(pts)

    if len(pts) >= 6:
        last3 = sum(pts[-3:]) / 3
        prev3 = sum(pts[-6:-3]) / 3
    else:
        last3 = pts[-1]
        prev3 = pts[0]

    if prev3 == 0:
        pct = 0
        trend = "stable"
    else:
        pct = round(
            ((last3 - prev3) / prev3) * 100,
            2
        )

        if pct > 5:
            trend = "rising"
        elif pct < -5:
            trend = "falling"
        else:
            trend = "stable"

    return {
        "keyword": keyword,
        "geo_code": geo,
        "window_months": months,
        "gt_interest_avg": avg,
        "gt_interest_peak": peak,
        "gt_sustainability": sustainability,
        "gt_sustainability_threshold": GT_SUSTAINABILITY_THRESHOLD,
        "gt_interest_trend": trend,
        "gt_interest_change_pct": pct,
        "source": "google_trends"
    }


# ======================================================
# SAVE
# ======================================================

def save_results(results, timestamp):

    now_dt = datetime.now(timezone.utc)

    key = (
        f"raw/google_trends/"
        f"{now_dt.strftime('%Y/%m/%d')}/"
        f"google_trends_{timestamp}.json"
    )

    s3.put_object(
        Bucket=S3_RAW_BUCKET,
        Key=key,
        Body=json.dumps(results).encode("utf-8"),
        ContentType="application/json"
    )

    return key


# ======================================================
# MAIN HANDLER
# ======================================================

def lambda_handler(event, context):

    start = now()

    try:
        keywords = event.get("keyword", [])
        geo = event.get("geo", "US")
        months = int(
            event.get(
                "trend_window_months",
                12
            )
        )

        min_score = event.get(
            "min_trend_score"
        )

        timestamp = event.get(
            "timestamp",
            datetime.utcnow().strftime(
                "%Y-%m-%dT%H-%M-%SZ"
            )
        )

        if isinstance(keywords, str):
            keywords = [keywords]

        # remove duplicates
        keywords = list(dict.fromkeys(keywords))

        # max 30
        keywords = keywords[:MAX_KEYWORDS]

        if not keywords:
            return {
            "stage": "google_trends_fetch",
            "status": "EMPTY",
            "message": "No keywords provided",
            "filtered_count": 0,
            "raw_count": 0,
            "results": [],
            "s3_bucket": None,
            "s3_key": None
        }

        timeframe = get_timeframe(months)

        results = []

        all_pts_map = {}

        # ==================================================
        # 1. PROCESS PYTRENDS IN BATCHES OF 5
        # ==================================================

        for i, batch in enumerate(chunk(
            keywords,
            BATCH_SIZE
        )):
            print(f"Processing PyTrends Batch {i+1}: {batch}")
            if now() - start > GLOBAL_TIMEOUT:
                print("Global timeout reached during PyTrends processing.")
                break

            batch_data = fetch_batch(
                batch,
                geo,
                timeframe
            )
            if batch_data:
                print(f"PyTrends success for: {list(batch_data.keys())}")
            all_pts_map.update(batch_data)

        # ==================================================
        # 2. FALLBACK TO SERPAPI FOR ALL MISSING KEYWORDS
        # ==================================================
        missing_kws = [kw for kw in keywords if kw not in all_pts_map or not all_pts_map[kw]]

        if missing_kws:
            print(f"Fallback to SerpApi needed for {len(missing_kws)} keywords: {missing_kws}")
            # Note: SerpApi/Google Trends timeseries limits multi-keyword to 5 items max
            for i, serp_batch in enumerate(chunk(missing_kws, 5)):
                print(f"SerpApi Batch {i+1}: fetching {serp_batch}")
                serpapi_data = fetch_serpapi_batch(
                    serp_batch,
                    geo,
                    timeframe
                )
                if serpapi_data:
                    print(f"SerpApi success for: {list(serpapi_data.keys())}")
                all_pts_map.update(serpapi_data)

        # ==================================================
        # 3. ANALYZE AND APPEND RESULTS
        # ==================================================
        for kw in keywords:
            pts = all_pts_map.get(kw, [])
            row = analyze(
                kw,
                pts,
                geo,
                months
            )

            if row:
                results.append(row)

        raw_count = len(results)
        print(f"Collected {raw_count} raw results before filtering. min_score={min_score}")

        # ==================================================
        # FILTER
        # ==================================================

        if min_score is not None:
            try:
                min_score = float(min_score)

                results = [
                    x for x in results
                    if x.get("gt_sustainability", 0) >= min_score
                ]
                print(f"Filtered results: {len(results)} items remain above GT sustainability {min_score}")
            except Exception as fe:
                print(f"Filtering error: {fe}")
                pass

        filtered_count = len(results)

        # ==================================================
        # EMPTY
        # ==================================================

        if filtered_count == 0:
            return {
                "stage": "google_trends_fetch",
                "status": "EMPTY",
                "message": "No keywords passed Google Trends sustainability threshold",
                "filtered_count": 0,
                "raw_count": raw_count,
                "s3_bucket": None,
                "s3_key": None,
                "results": []
            }

        # ==================================================
        # SAVE
        # ==================================================

        s3_key = save_results(
            results,
            timestamp
        )

        return {
            "stage": "google_trends_fetch",
            "status": "SUCCEEDED",
            "message": "Google Trends data collected successfully",
            "filtered_count": filtered_count,
            "raw_count": raw_count,
            "s3_bucket": S3_RAW_BUCKET,
            "s3_key": s3_key,
            "results": results,
            "duration_sec": round(now() - start, 2)
        }

    except Exception as e:
        return {
            "stage": "google_trends_fetch",
            "status": "FAILED",
            "message": "Google Trends processing failed",
            "error": str(e),
            "filtered_count": 0,
            "raw_count": 0,
            "results": [],
            "s3_bucket": None,
            "s3_key": None
        }
