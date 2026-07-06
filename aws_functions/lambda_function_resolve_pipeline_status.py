from datetime import datetime
import json
import re


def humanize_stage_error(raw):
    if not raw:
        return None

    text = str(raw).replace("\\n", " ").strip()

    if "Monthly usage hard limit exceeded" in text:
        return (
            "Apify monthly usage limit exceeded. "
            "Upgrade your Apify plan or wait for the billing cycle to reset."
        )

    if "platform-feature-disabled" in text:
        return "Apify feature disabled or account limit reached."

    json_start = text.find("{")
    if json_start >= 0:
        try:
            parsed = json.loads(text[json_start:])
            err = parsed.get("error") if isinstance(parsed, dict) else None
            if isinstance(err, dict):
                inner = err.get("message") or err.get("type")
                if inner:
                    prefix = text[:json_start].replace(":", "").strip()
                    if "apify" in prefix.lower():
                        http = re.search(r"HTTP\s*(\d+)", prefix, re.I)
                        code = f" (HTTP {http.group(1)})" if http else ""
                        return f"Apify error{code}: {inner}"
                    if prefix:
                        return f"{prefix}: {inner}"
                    return str(inner)
        except Exception:
            pass

    if len(text) > 280:
        return text[:277] + "…"

    return text


def extract_stage_message(stage_obj):
    status = stage_obj.get("status", "")
    raw = stage_obj.get("message")

    if status == "FAILED":
        raw = stage_obj.get("error") or raw

    human = humanize_stage_error(raw)
    if human:
        return human

    if status == "SKIPPED":
        return stage_obj.get("message") or f"{stage_obj.get('stage', 'stage')} skipped"

    return raw or stage_obj.get("message")


def extract_rows(stage_obj):

    for field in [
        "rows",
        "rows_processed",
        "filtered_count",
        "keywords_processed",
        "itemCount"
    ]:

        value = stage_obj.get(field)

        if value is not None:
            return value

    return 0

# def get_stage(primary_stage, fallback_stage, default_name):

#     stage_obj = primary_stage or fallback_stage

#     if not isinstance(stage_obj, dict):

#         return {
#             "stage": default_name,
#             "status": "SKIPPED",
#             "message": f"{default_name} stage skipped",
#             "rows": 0
#         }

#     return {
#         "stage": default_name,
#         "status": stage_obj.get("status", "SKIPPED"),
#         "message": stage_obj.get("message"),
#         "rows": extract_rows(stage_obj)
#     }
def get_stage(primary_stage, fallback_stage, default_name):

    stage_obj = primary_stage or fallback_stage

    if not isinstance(stage_obj, dict):
        return {
            "stage": default_name,
            "status": "SKIPPED",
            "message": f"{default_name} stage skipped",
            "rows": 0
        }

    return {
        "stage": default_name,
        "status": stage_obj.get("status", "SKIPPED"),
        "message": extract_stage_message(stage_obj),
        "rows": extract_rows(stage_obj)
    }


STAGE_LABELS = {
    "keyword_planner": "Keyword Planner",
    "google_trends": "Google Trends",
    "amazon": "Amazon",
    "alibaba": "Alibaba",
}


def is_filter_empty_stage(stage):
    msg = (stage.get("message") or "").lower()
    return (
        "remained after filtering" in msg
        or "after filtering" in msg
        or "filtered out" in msg
    )


def describe_empty_stage(key, stage):
    label = STAGE_LABELS.get(key, key.replace("_", " ").title())
    if is_filter_empty_stage(stage):
        return f"{label} results removed by active filters"
    detail = stage.get("message") or f"{label} returned no results"
    return f"{label}: {detail}"


def build_pipeline_user_message(pipeline_status, stages):
    failed = [
        (key, stage)
        for key, stage in stages.items()
        if stage.get("status") == "FAILED"
    ]
    empty = [
        (key, stage)
        for key, stage in stages.items()
        if stage.get("status") == "EMPTY"
    ]

    if pipeline_status == "FAILED" and failed:
        key, stage = failed[0]
        label = STAGE_LABELS.get(key, key.replace("_", " ").title())
        detail = stage.get("message") or "execution failed"
        return f"{label} failed — {detail}"

    if failed:
        key, stage = failed[0]
        label = STAGE_LABELS.get(key, key.replace("_", " ").title())
        detail = stage.get("message") or "see details below"
        return f"Core data collected — {label} failed: {detail}"

    if empty:
        key, stage = empty[0]
        return f"Core data collected — {describe_empty_stage(key, stage)}"

    if pipeline_status == "SUCCEEDED":
        return "All requested stages completed successfully"

    if pipeline_status == "PARTIALLY_SUCCEEDED":
        return "Completed with some optional stages skipped"

    return f"Pipeline execution completed with status {pipeline_status}"


def lambda_handler(event, context):
    amazon_stage = (
    event.get("amazon_fcl")
    or event.get("amazon_clean")
    or event.get("amazon_fetch")
)

    stages = {

        "keyword_planner":
            get_stage(
                event.get("kwp_clean"),
                event.get("kwp_fetch"),
                "keyword_planner"
            ),

        "google_trends":
            get_stage(
                event.get("trends_clean"),
                event.get("trends_fetch"),
                "google_trends"
            ),

        # "amazon":
        #     get_stage(
        #         event.get("amazon_fcl"),
        #         event.get("amazon_clean"),
        #         event.get("amazon_fetch"),
        #     ),

        "amazon": 
            get_stage(
                amazon_stage,
                None,
                "amazon"
            ),

        "alibaba":
            get_stage(
                event.get("alibaba_clean"),
                event.get("alibaba_fetch"),
                "alibaba"
            )
    }

    statuses = [
        s["status"]
        for s in stages.values()
    ]

    failed_count = statuses.count("FAILED")

    partial_count = len([
        x for x in statuses
        if x in ["EMPTY", "SKIPPED"]
    ])

    # ----------------------------------
    # FINAL PIPELINE STATUS
    # ----------------------------------

    if failed_count == len(statuses):

        pipeline_status = "FAILED"

    elif failed_count > 0 or partial_count > 0:

        pipeline_status = "PARTIALLY_SUCCEEDED"

    else:

        pipeline_status = "SUCCEEDED"

    message = build_pipeline_user_message(pipeline_status, stages)

    return {

        "pipeline_status": pipeline_status,

        "message": message,

        "stages": stages,

        "generated_at":
            datetime.utcnow().isoformat()
    }