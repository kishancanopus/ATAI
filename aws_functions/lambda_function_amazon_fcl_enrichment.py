import json
import os
import tempfile
import boto3
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

s3 = boto3.client("s3")


def parse_s3_path(s3_uri: str):
    s3_uri = s3_uri.replace("s3://", "")
    bucket, key = s3_uri.split("/", 1)
    return bucket, key


def lambda_handler(event, context):
    try:
        print("FCL enrichment event:", event)

        amazon_file = event.get("amazon_file")
        fcl_percentage = event.get("fcl_percentage")
        if fcl_percentage is None:
            fcl_percentage = 0.25
        else:
            fcl_percentage = float(fcl_percentage)

        if not amazon_file:
            return {
                "stage": "amazon_fcl",
                "status": "EMPTY",
                "message": "No Amazon products remained after filtering",
                "keywords_processed": 0
            }

        bucket, key = parse_s3_path(amazon_file)

        # Download parquet locally
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp:
            tmp_path = tmp.name

        s3.download_file(bucket, key, tmp_path)

        # Load dataframe
        df = pd.read_parquet(tmp_path)

        if "keyword" not in df.columns or "amazon_price_usd" not in df.columns:
            return {
                "stage": "amazon_fcl",
                "status": "FAILED",
                "message": "Required Amazon columns missing",
                "keywords_processed": 0
            }

        # Keyword-level average (reference / analytics)
        avg_price_df = (
            df.groupby("keyword")["amazon_price_usd"]
            .mean()
            .reset_index()
            .rename(columns={"amazon_price_usd": "avg_amazon_price_by_keyword"})
        )

        df = df.merge(avg_price_df, on="keyword", how="left")

        # Per-product FCL: apply slider % to each row's Amazon price (consolidated table)
        df["estimated_local_price (fcl)"] = df["amazon_price_usd"] * (1 - fcl_percentage)

        # Overwrite parquet
        table = pa.Table.from_pandas(df)
        pq.write_table(table, tmp_path)

        s3.upload_file(tmp_path, bucket, key)

        try:
            os.remove(tmp_path)
        except:
            pass

        return {
            "stage": "amazon_fcl",
            "status": "SUCCEEDED",
            "message": "Amazon FCL enrichment completed",
            "fcl_percentage_used": fcl_percentage,
            "updated_file": amazon_file,
            "keywords_processed": int(df["keyword"].nunique())
        }

    except Exception as e:
        print("[ERROR]", str(e))
        return {
            "stage": "amazon_fcl",
            "status": "FAILED",
            "message": "Amazon FCL enrichment failed",
            "error": str(e),
            "keywords_processed": 0
        }