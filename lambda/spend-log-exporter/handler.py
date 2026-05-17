"""
Aurora spend_logs → S3 exporter via aws_s3 extension.

EventBridge triggers this Lambda hourly. It connects to Aurora and runs
aws_s3.query_export_to_s3() to export the last hour's spend logs directly
from Aurora to S3 in CSV format.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone

import boto3
import psycopg2

logger = logging.getLogger()
logger.setLevel(logging.INFO)

S3_BUCKET = os.environ["S3_BUCKET_NAME"]
S3_PREFIX = os.environ.get("S3_PREFIX", "spend-logs")
S3_REGION = os.environ.get("S3_REGION", "ap-northeast-2")
EXPORT_INTERVAL_HOURS = int(os.environ.get("EXPORT_INTERVAL_HOURS", "1"))


def get_db_connection():
    secret_arn = os.environ["DB_SECRET_ARN"]
    client = boto3.client("secretsmanager")
    secret = json.loads(client.get_secret_value(SecretId=secret_arn)["SecretString"])
    return psycopg2.connect(
        host=secret["host"],
        port=secret["port"],
        user=secret["username"],
        password=secret["password"],
        dbname=os.environ.get("DB_NAME", "litellm"),
        connect_timeout=10,
    )


def ensure_extension(conn):
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS aws_s3 CASCADE;")
    conn.commit()


def export_to_s3(conn, start_time, end_time, s3_key):
    query = f"""
    SELECT * FROM aws_s3.query_export_to_s3(
        'SELECT
            request_id,
            call_type,
            api_key,
            spend,
            total_tokens,
            prompt_tokens,
            completion_tokens,
            starttime,
            endtime,
            completionstarttimestamp,
            model,
            model_id,
            model_group,
            api_base,
            "user",
            metadata,
            cache_hit,
            cache_key,
            request_tags,
            team_id,
            end_user,
            requester_ip_address,
            messages,
            response,
            request_body,
            response_body
        FROM "LiteLLM_SpendLogs"
        WHERE starttime >= ''{start_time.isoformat()}''
          AND starttime < ''{end_time.isoformat()}''
        ORDER BY starttime',
        aws_commons.create_s3_uri(
            '{S3_BUCKET}',
            '{s3_key}',
            '{S3_REGION}'
        ),
        options := 'FORMAT CSV, HEADER TRUE'
    );
    """
    with conn.cursor() as cur:
        cur.execute(query)
        result = cur.fetchone()
    conn.commit()
    return result


def handler(event, context):
    now = datetime.now(timezone.utc)
    end_time = now.replace(minute=0, second=0, microsecond=0)
    start_time = end_time - timedelta(hours=EXPORT_INTERVAL_HOURS)

    s3_key = f"{S3_PREFIX}/{start_time.strftime('%Y/%m/%d')}/{start_time.strftime('%H')}00-{end_time.strftime('%H')}00.csv"

    logger.info(f"Exporting spend logs: {start_time} ~ {end_time} → s3://{S3_BUCKET}/{s3_key}")

    conn = get_db_connection()
    try:
        ensure_extension(conn)
        result = export_to_s3(conn, start_time, end_time, s3_key)
        rows_exported = result[0] if result else 0
        logger.info(f"Export complete: {rows_exported} rows → s3://{S3_BUCKET}/{s3_key}")
        return {
            "statusCode": 200,
            "body": {
                "rows": rows_exported,
                "s3_key": s3_key,
                "period": f"{start_time.isoformat()} ~ {end_time.isoformat()}",
            },
        }
    finally:
        conn.close()
