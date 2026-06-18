import json
import os
import boto3
import pyarrow as pa
import pyarrow.parquet as pq
from datetime import datetime

s3 = boto3.client("s3")

def load_json(data_bytes):
    data = json.loads(data_bytes)

    if not isinstance(data, list):
        return pa.Table.from_pylist([])

    if not data:
        return pa.Table.from_pylist([])

    return pa.Table.from_pylist(data)

def generate_output_key(input_key, search_mode):
    parts = input_key.split("/")
    timestamp = parts[-1].replace(".json", "")

    return f"clean/{search_mode}/google_keyword_planner/{timestamp}.parquet"

def lambda_handler(event, context):

    input_bucket = event.get("input_bucket")
    input_key = event.get("input_key")
    search_mode = event.get("search_mode", "manual_search")
    search_category = event.get("search_category")

    if not input_bucket or not input_key:
        return {
            "stage": "keyword_planner_clean",
            "status": "FAILED",
            "message": "Missing input bucket or key",
            "rows": 0
        }

    obj = s3.get_object(Bucket=input_bucket, Key=input_key)
    raw = obj["Body"].read()

    table = load_json(raw)

    if table.num_rows == 0:
        return {
        "stage": "keyword_planner_clean",
        "status": "EMPTY",
        "message": "No rows available after cleaning",
        "rows": 0
    }   

    # ADD META
    table = table.append_column("search_category", pa.array([search_category]*table.num_rows))

    tmp = "/tmp/output.parquet"
    pq.write_table(table, tmp)

    output_bucket = "atai-clean-layer"
    output_key = generate_output_key(input_key, search_mode)

    s3.upload_file(tmp, output_bucket, output_key)
    os.remove(tmp)

    return {
        "stage": "keyword_planner_clean",
        "status": "SUCCEEDED",
        "message": "Keyword Planner clean stage completed",
        "rows": table.num_rows,
        "input_file": f"s3://{input_bucket}/{input_key}",
        "output_file": f"s3://{output_bucket}/{output_key}"
    }