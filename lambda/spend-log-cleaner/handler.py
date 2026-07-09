"""
Aurora LiteLLM_SpendLogs rolling retention cleaner.

EventBridge triggers this Lambda daily (04:00 KST). It deletes spend log rows
older than RETENTION_DAYS, keeping only the most recent window. Deletion is
done in batches (ctid-based, same approach as the manual purge script) so a
single statement never locks the table for long or times out. New rows keep
being INSERTed meanwhile; autovacuum reclaims the freed space for reuse, so the
table settles at a steady size instead of growing forever.

Safety:
 - Rows to delete are decided solely by  "startTime" < cutoff  (cutoff = now-Nd).
 - Batched DELETE via ctid; each batch is its own statement. A statement
   timeout rolls back that batch only (no partial/duplicate deletes on retry).
 - No VACUUM FULL: it takes an ACCESS EXCLUSIVE lock and rewrites the table,
   which would block the live gateway and doesn't reliably shrink Aurora volume.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone

import boto3
import pg8000.native

logger = logging.getLogger()
logger.setLevel(logging.INFO)

RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "2"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "5000"))
# Guard against a runaway loop: cap batches per invocation. At BATCH_SIZE=5000
# this is 5M rows/run — far above a normal day's backlog once steady-state.
MAX_BATCHES = int(os.environ.get("MAX_BATCHES", "1000"))
# Per-statement timeout (ms). A batch that exceeds this rolls back and we stop
# cleanly; the next daily run picks up where this one left off.
STATEMENT_TIMEOUT_MS = int(os.environ.get("STATEMENT_TIMEOUT_MS", "120000"))

DELETE_SQL = (
    'DELETE FROM "LiteLLM_SpendLogs" WHERE ctid IN ('
    'SELECT ctid FROM "LiteLLM_SpendLogs" '
    'WHERE "startTime" < :cutoff LIMIT :batch)'
)


def get_db_connection():
    secret_arn = os.environ["DB_SECRET_ARN"]
    client = boto3.client("secretsmanager")
    secret = json.loads(client.get_secret_value(SecretId=secret_arn)["SecretString"])
    return pg8000.native.Connection(
        host=secret["host"],
        port=int(secret["port"]),
        user=secret["username"],
        password=secret["password"],
        database=os.environ.get("DB_NAME", "litellm"),
        timeout=240,
    )


def handler(event, context):
    # Allow an explicit override for testing/backfill; otherwise roll the window.
    retention_days = int(event.get("retention_days", RETENTION_DAYS)) if isinstance(event, dict) else RETENTION_DAYS
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    cutoff_str = cutoff.strftime("%Y-%m-%d %H:%M:%S")

    logger.info(
        f"Deleting LiteLLM_SpendLogs with startTime < {cutoff_str} "
        f"(retention={retention_days}d, batch={BATCH_SIZE})"
    )

    conn = get_db_connection()
    total_deleted = 0
    batches = 0
    try:
        # Bound each DELETE so a slow batch can't hang the whole invocation.
        conn.run(f"SET statement_timeout = {STATEMENT_TIMEOUT_MS}")

        while batches < MAX_BATCHES:
            conn.run(DELETE_SQL, cutoff=cutoff_str, batch=BATCH_SIZE)
            deleted = conn.row_count or 0
            total_deleted += deleted
            batches += 1
            logger.info(f"batch={deleted} total={total_deleted}")
            if deleted == 0:
                break
        else:
            logger.warning(
                f"Hit MAX_BATCHES={MAX_BATCHES}; {total_deleted} rows deleted, "
                "remainder will be cleaned on the next run."
            )

        logger.info(f"Cleanup complete: {total_deleted} rows deleted in {batches} batches")
        return {
            "statusCode": 200,
            "body": {
                "deleted": total_deleted,
                "batches": batches,
                "cutoff": cutoff.isoformat(),
                "retention_days": retention_days,
            },
        }
    finally:
        conn.close()
