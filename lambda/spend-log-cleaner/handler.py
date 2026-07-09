"""
Aurora LiteLLM_SpendLogs rolling retention cleaner.

EventBridge triggers this Lambda daily (04:05 KST). It deletes spend log rows
older than RETENTION_DAYS, keeping only the most recent window. Deletion runs in
batches so a single statement never locks the table for long. New rows keep
being INSERTed meanwhile; autovacuum reclaims the freed space for reuse, so the
table settles at a steady size instead of growing forever.

Performance / safety design:
 - Keyset cursor, not re-scan. The naive `WHERE startTime < cutoff ORDER BY
   startTime LIMIT N` re-scans the oldest rows from the front on every batch;
   as dead tuples pile up faster than autovacuum clears them, each batch gets
   slower (roughly O(n^2) over a big backlog). We instead resume from the last
   (startTime, request_id) processed, using the existing [startTime, request_id]
   index. request_id is the unique PK, so the composite cursor strictly advances
   every batch — no re-scan, no risk of skipping or resticking on rows that
   share a startTime.
 - FOR UPDATE SKIP LOCKED lets this run safely alongside another deleter (a
   manual purge, an overlapping retry): each takes different rows instead of
   forming the circular wait that causes deadlock (SQLSTATE 40P01). Rows another
   deleter holds are skipped this pass and swept by the next daily run.
 - Batches auto-commit (pg8000.native has no implicit transaction), so progress
   survives a Lambda timeout — the next daily run resumes from the DB state.
 - Direct pg8000 connection (not the RDS Data API), so we aren't bound by the
   Data API's ~45s statement / 1MB response limits that forced the old 5000-row
   batches; 50k keeps round-trips low while keeping per-batch lock time short.
 - Transient errors (deadlock, serialization failure) are retried per batch.
 - No VACUUM FULL: it takes an ACCESS EXCLUSIVE lock and rewrites the table,
   which would block the live gateway and doesn't reliably shrink Aurora volume.
"""

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

import boto3
import pg8000.native

logger = logging.getLogger()
logger.setLevel(logging.INFO)

RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "2"))
# Starting batch size. On a clean table 50k deletes in <1s, but a bloated
# live table (dead-tuple buildup, lock contention with in-flight INSERTs, slow
# Aurora I/O) can push a big batch past the statement timeout. So this is only
# the *starting* size — a batch that times out is retried at half the size
# (see _run_batch), down to MIN_BATCH_SIZE. Steady-state daily runs stay large;
# a slow backlog run self-throttles instead of crashing.
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "10000"))
MIN_BATCH_SIZE = int(os.environ.get("MIN_BATCH_SIZE", "500"))
# Runaway-loop backstop. At BATCH_SIZE=10000 this is 10M rows/run.
MAX_BATCHES = int(os.environ.get("MAX_BATCHES", "5000"))
# Per-statement timeout (ms). A batch exceeding this is cancelled by Postgres
# (SQLSTATE 57014); the connection stays usable (autocommit, no aborted tx), so
# we shrink the batch and retry. Progress from committed batches is kept.
STATEMENT_TIMEOUT_MS = int(os.environ.get("STATEMENT_TIMEOUT_MS", "60000"))
# Transient errors are retried per batch with linear backoff.
MAX_RETRY = int(os.environ.get("MAX_RETRY", "6"))
RETRY_BACKOFF_SECONDS = float(os.environ.get("RETRY_BACKOFF_SECONDS", "2"))
# A backlog run can be hundreds of batches; only log every Nth to keep
# CloudWatch volume down (retries/shrinks and the final summary always log).
PROGRESS_LOG_EVERY = int(os.environ.get("PROGRESS_LOG_EVERY", "20"))

# SQLSTATEs safe to retry: the batch rolled back cleanly (nothing committed) so
# a retry can't double-delete. 40P01 = deadlock_detected, 40001 =
# serialization_failure (both wait then retry same size); 57014 =
# statement_timeout (retry at a smaller size — the batch was too big/slow).
RETRYABLE_SQLSTATES = {"40P01", "40001", "57014"}
STATEMENT_TIMEOUT_SQLSTATE = "57014"

# Keyset-paginated batch delete. `doomed` is MATERIALIZED so it's evaluated
# exactly once: the same fixed set feeds both the DELETE and the next-cursor
# lookup. We report both how many rows we targeted (`found`, for loop control)
# and how many we actually deleted (`deleted`, for reporting), plus the last
# (startTime, request_id) of the batch to resume from.
DELETE_SQL = (
    'WITH doomed AS MATERIALIZED ('
    '  SELECT request_id, "startTime" FROM "LiteLLM_SpendLogs" '
    '  WHERE "startTime" < :cutoff '
    '    AND ("startTime", request_id) > (:cur_ts, :cur_id) '
    '  ORDER BY "startTime", request_id '
    '  LIMIT :batch '
    '  FOR UPDATE SKIP LOCKED'
    '), del AS ('
    '  DELETE FROM "LiteLLM_SpendLogs" t USING doomed d '
    '  WHERE t.request_id = d.request_id RETURNING 1'
    ') SELECT '
    '  (SELECT count(*) FROM doomed) AS found, '
    '  (SELECT count(*) FROM del) AS deleted, '
    '  (SELECT "startTime" FROM doomed ORDER BY "startTime" DESC, request_id DESC LIMIT 1) AS max_ts, '
    '  (SELECT request_id FROM doomed ORDER BY "startTime" DESC, request_id DESC LIMIT 1) AS max_id'
)

# request_id sorts as text; '' is <= any real id, and epoch is before any real
# startTime, so this initial cursor selects from the very oldest row.
EPOCH_CURSOR_TS = "1970-01-01 00:00:00.000000"
EPOCH_CURSOR_ID = ""
_TS_FMT = "%Y-%m-%d %H:%M:%S.%f"


def _sqlstate(exc):
    """Extract the PostgreSQL SQLSTATE from a pg8000 DatabaseError, if present."""
    args = getattr(exc, "args", None)
    if args and isinstance(args[0], dict):
        return args[0].get("C")
    return None


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


def _run_batch(conn, cutoff_str, cur_ts, cur_id, batch_size):
    """Run one keyset batch, retrying transient errors and shrinking on timeout.

    Returns (found, deleted, max_ts, max_id, batch_size) — the trailing value is
    the (possibly reduced) batch size that succeeded, so the caller can keep
    using the smaller size for subsequent batches instead of timing out again.
    max_ts/max_id are the last keyset of the batch (None when nothing found).
    """
    for attempt in range(1, MAX_RETRY + 1):
        try:
            rows = conn.run(
                DELETE_SQL,
                cutoff=cutoff_str,
                cur_ts=cur_ts,
                cur_id=cur_id,
                batch=batch_size,
            )
            r = rows[0]  # single row: [found, deleted, max_ts, max_id]
            return int(r[0] or 0), int(r[1] or 0), r[2], r[3], batch_size
        except pg8000.native.DatabaseError as exc:
            state = _sqlstate(exc)
            if state not in RETRYABLE_SQLSTATES or attempt >= MAX_RETRY:
                raise
            if state == STATEMENT_TIMEOUT_SQLSTATE and batch_size > MIN_BATCH_SIZE:
                # Batch too big/slow for the statement timeout — halve and retry
                # immediately (no backoff; the work just needs to be smaller).
                batch_size = max(MIN_BATCH_SIZE, batch_size // 2)
                logger.warning(
                    f"Batch timed out (57014, attempt {attempt}/{MAX_RETRY}); "
                    f"shrinking batch to {batch_size} and retrying"
                )
                continue
            wait = RETRY_BACKOFF_SECONDS * attempt
            logger.warning(
                f"Transient DB error {state} on batch (attempt {attempt}/"
                f"{MAX_RETRY}); retrying in {wait}s"
            )
            time.sleep(wait)
    # Loop exhausted without returning or raising (shouldn't happen: the last
    # attempt either returns or re-raises). Defensive guard.
    raise RuntimeError("batch retries exhausted without result")


def handler(event, context):
    # Allow an explicit override for testing/backfill; otherwise roll the window.
    retention_days = (
        int(event.get("retention_days", RETENTION_DAYS))
        if isinstance(event, dict)
        else RETENTION_DAYS
    )
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    cutoff_str = cutoff.strftime("%Y-%m-%d %H:%M:%S")

    logger.info(
        f"Deleting LiteLLM_SpendLogs with startTime < {cutoff_str} "
        f"(retention={retention_days}d, batch={BATCH_SIZE})"
    )

    conn = get_db_connection()
    total_deleted = 0
    batches = 0
    cur_ts, cur_id = EPOCH_CURSOR_TS, EPOCH_CURSOR_ID
    batch_size = BATCH_SIZE  # may shrink if batches time out; stays shrunk
    try:
        conn.run(f"SET statement_timeout = {STATEMENT_TIMEOUT_MS}")

        while batches < MAX_BATCHES:
            found, deleted, max_ts, max_id, batch_size = _run_batch(
                conn, cutoff_str, cur_ts, cur_id, batch_size
            )
            total_deleted += deleted
            batches += 1

            # Nothing older than cutoff remains (past the cursor) -> done.
            if found == 0:
                break

            # A backlog run can be hundreds of batches; log a progress line only
            # periodically (and on the final batch below) to keep CloudWatch
            # volume sane. _run_batch already logs every shrink/retry.
            if batches % PROGRESS_LOG_EVERY == 0:
                logger.info(
                    f"progress: {total_deleted} deleted in {batches} batches "
                    f"(batch_size={batch_size})"
                )

            # Advance the keyset cursor to the last row of this batch. request_id
            # is unique, so (max_ts, max_id) is strictly greater than the current
            # cursor -> the next batch always makes progress.
            cur_ts = max_ts.strftime(_TS_FMT)
            cur_id = max_id
        else:
            logger.warning(
                f"Hit MAX_BATCHES={MAX_BATCHES}; {total_deleted} rows deleted, "
                "remainder will be cleaned on the next run."
            )

        logger.info(
            f"Cleanup complete: {total_deleted} rows deleted in {batches} batches"
        )
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
