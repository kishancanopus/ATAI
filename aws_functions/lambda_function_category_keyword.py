import os
import json
from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException


def get_google_ads_client():
    config = {
        "developer_token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_ADS_REFRESH_TOKEN"],
        "login_customer_id": os.environ.get("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
        "use_proto_plus": True,
    }
    return GoogleAdsClient.load_from_dict(config)


def get_geo_target_constant(client, country_code):
    """
    Convert country code (US, IN, etc.) to geo target constant resource name
    """
    geo_service = client.get_service("GeoTargetConstantService")

    query = f"""
        SELECT geo_target_constant.resource_name
        FROM geo_target_constant
        WHERE geo_target_constant.country_code = '{country_code}'
        LIMIT 1
    """

    ga_service = client.get_service("GoogleAdsService")
    response = ga_service.search(
        customer_id=os.environ["GOOGLE_ADS_CUSTOMER_ID"],
        query=query,
    )

    for row in response:
        return row.geo_target_constant.resource_name

    raise Exception("Invalid country code")


def fetch_keyword_ideas(search_term, geo_target, limit, min_searches, max_searches):
    client = get_google_ads_client()

    keyword_service = client.get_service("KeywordPlanIdeaService")
    keyword_plan_network = client.enums.KeywordPlanNetworkEnum.GOOGLE_SEARCH

    geo_resource = get_geo_target_constant(client, geo_target)

    request = client.get_type("GenerateKeywordIdeasRequest")
    request.customer_id = os.environ["GOOGLE_ADS_CUSTOMER_ID"]
    request.keyword_plan_network = keyword_plan_network
    request.geo_target_constants.append(geo_resource)
    request.language = "languageConstants/1000"  # English
    request.keyword_seed.keywords.append(search_term)

    response = keyword_service.generate_keyword_ideas(request=request)

    keywords = []

    for idea in response:
        searches = idea.keyword_idea_metrics.avg_monthly_searches or 0

         # MIN MAX FILTER
        if searches >= min_searches and searches <= max_searches:
            keywords.append({
                "keyword": idea.text,
                "avg_monthly_searches": searches,
                "competition": str(idea.keyword_idea_metrics.competition)
            })

    # Sort by relevance (Google already returns by relevance,
    # but we sort by avg monthly searches as secondary safety)
    keywords_sorted = sorted(
        keywords,
        key=lambda x: x["avg_monthly_searches"] or 0,
        reverse=True
    )

    return keywords_sorted[:limit]

def fetch_keyword_ideas_multi(search_terms, geo_target, limit, min_searches, max_searches):
    client = get_google_ads_client()

    keyword_service = client.get_service("KeywordPlanIdeaService")
    keyword_plan_network = client.enums.KeywordPlanNetworkEnum.GOOGLE_SEARCH

    geo_resource = get_geo_target_constant(client, geo_target)

    all_keywords = {}
    # using dict for deduplication

    for term in search_terms:
        request = client.get_type("GenerateKeywordIdeasRequest")
        request.customer_id = os.environ["GOOGLE_ADS_CUSTOMER_ID"]
        request.keyword_plan_network = keyword_plan_network
        request.geo_target_constants.append(geo_resource)
        request.language = "languageConstants/1000"
        request.keyword_seed.keywords.append(term)

        response = keyword_service.generate_keyword_ideas(request=request)

        for idea in response:
            keyword_text = idea.text
            searches = idea.keyword_idea_metrics.avg_monthly_searches or 0

            if min_searches <= searches <= max_searches:
                # Deduplicate by keyword
                if keyword_text not in all_keywords:
                    all_keywords[keyword_text] = {
                        "keyword": keyword_text,
                        "avg_monthly_searches": searches,
                        "competition": str(idea.keyword_idea_metrics.competition)
                    }

    # Convert to list
    keywords = list(all_keywords.values())

    # Global sort
    keywords_sorted = sorted(
        keywords,
        key=lambda x: x["avg_monthly_searches"],
        reverse=True
    )

    return keywords_sorted[:limit]

# def lambda_handler(event, context):
#     """
#     Expected JSON Input:
#     {
#         "search_term": "pets and animals",
#         "geo": "US",
#         "limit": 10
#     }
#     """

#     try:
#         body = event if isinstance(event, dict) else json.loads(event["body"])

#         search_term = body["search_term"]
#         geo = body.get("geo", "US")
#         limit = int(body.get("limit", 10))

#         min_searches = int(body.get("min_searches", 0))
#         max_searches = int(body.get("max_searches", 100000000))

#         results = fetch_keyword_ideas(search_term, geo, limit, min_searches, max_searches)

#         return {
#             "statusCode": 200,
#             "body": json.dumps({
#                 "search_term": search_term,
#                 "geo": geo,
#                 "filters": {
#                     "min_searches": min_searches,
#                     "max_searches": max_searches,
#                     "variant_limit" : limit
#                 },
#                 "keywords": results
#             })
#         }

#     except GoogleAdsException as ex:
#         return {
#             "statusCode": 500,
#             "body": json.dumps({"error": str(ex)})
#         }

#     except Exception as e:
#         return {
#             "statusCode": 500,
#             "body": json.dumps({"error": str(e)})
#         }
def lambda_handler(event, context):
    try:
        body = event if isinstance(event, dict) else json.loads(event["body"])

        raw_search_term = body["search_term"]
        geo = body.get("geo", "US")
        limit = int(body.get("limit", 10))

        min_searches = int(body.get("min_searches", 0))
        max_searches = int(body.get("max_searches", 100000000))

        # ✅ Get blacklist words
        blacklisted_words = body.get("blacklisted_words", [])

        if blacklisted_words is None:
            blacklisted_words = []

        if isinstance(blacklisted_words, str):
            blacklisted_words = [blacklisted_words]

        blacklisted_words = [w.lower().strip() for w in blacklisted_words]

        # ✅ Split multiple search terms
        search_terms = [
            term.strip()
            for term in raw_search_term.split(",")
            if term.strip()
        ]

        results = fetch_keyword_ideas_multi(
            search_terms,
            geo,
            limit * 5,   # fetch more before filtering
            min_searches,
            max_searches
        )

        # =========================
        # BLACKLIST FILTER
        # =========================
        if blacklisted_words:
            clean_results = []

            for r in results:
                keyword_text = r["keyword"].lower()

                if any(word in keyword_text for word in blacklisted_words):
                    continue

                clean_results.append(r)

            results = clean_results

        # Final limit after blacklist
        results = results[:limit]

        return {
            "statusCode": 200,
            "body": json.dumps({
                "search_term": raw_search_term,
                "geo": geo,
                "filters": {
                    "min_searches": min_searches,
                    "max_searches": max_searches,
                    "variant_limit": limit,
                    "blacklisted_words": blacklisted_words
                },
                "keywords": results
            })
        }

    except GoogleAdsException as ex:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(ex)})
        }

    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }