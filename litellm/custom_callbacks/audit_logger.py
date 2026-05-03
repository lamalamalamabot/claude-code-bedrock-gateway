"""
감사 로그 콜백
모든 LLM 요청/응답 메타데이터를 DynamoDB에 기록
(프롬프트/응답 내용은 기록하지 않음)
"""

import logging
import os
import time
from datetime import datetime
from uuid import uuid4

import boto3
from litellm.integrations.custom_logger import CustomLogger

logger = logging.getLogger(__name__)

AUDIT_TABLE_NAME = os.environ.get("AUDIT_TABLE_NAME", "llm-gateway-audit")
AWS_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
TTL_DAYS = 90

_dynamodb_resource = boto3.resource("dynamodb", region_name=AWS_REGION)
_audit_table = _dynamodb_resource.Table(AUDIT_TABLE_NAME)


class AuditLogger(CustomLogger):
    """LiteLLM 요청에 대한 감사 로그를 DynamoDB에 기록하는 콜백"""

    def _extract_metadata(self, kwargs):
        """kwargs에서 사용자/팀/요청 메타데이터를 추출한다."""
        metadata = kwargs.get("metadata") or {}
        if not metadata:
            litellm_params = kwargs.get("litellm_params") or {}
            metadata = litellm_params.get("metadata") or {}

        user = metadata.get("user_api_key_user_id", "unknown")
        team = metadata.get("user_api_key_team_id", "unknown")
        model = kwargs.get("model", "unknown")
        request_id = kwargs.get("litellm_call_id") or str(uuid4())
        endpoint = metadata.get("endpoint", "")

        return user, team, model, request_id, endpoint

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        """비동기 성공 이벤트 감사 로그를 DynamoDB에 기록한다."""
        try:
            user, team, model, request_id, endpoint = self._extract_metadata(kwargs)

            input_tokens = getattr(response_obj.usage, "prompt_tokens", 0) or 0
            output_tokens = getattr(response_obj.usage, "completion_tokens", 0) or 0
            cost = kwargs.get("response_cost", 0) or 0
            latency_ms = round((end_time - start_time).total_seconds() * 1000, 2)
            timestamp = datetime.utcnow().isoformat() + "Z"
            expiry = int(time.time()) + TTL_DAYS * 24 * 3600

            item = {
                "userId": user,
                "sk": f"{timestamp}#{request_id}",
                "teamId": team,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost_usd": str(cost),
                "latency_ms": int(latency_ms),
                "status": "200",
                "endpoint": endpoint,
                "request_id": request_id,
                "timestamp": timestamp,
                "expiry": expiry,
            }

            _audit_table.put_item(Item=item)

        except Exception:
            logger.exception("Failed to write audit log for success event")

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        """동기 성공 이벤트 감사 로그를 DynamoDB에 기록한다."""
        try:
            user, team, model, request_id, endpoint = self._extract_metadata(kwargs)

            input_tokens = getattr(response_obj.usage, "prompt_tokens", 0) or 0
            output_tokens = getattr(response_obj.usage, "completion_tokens", 0) or 0
            cost = kwargs.get("response_cost", 0) or 0
            latency_ms = round((end_time - start_time).total_seconds() * 1000, 2)
            timestamp = datetime.utcnow().isoformat() + "Z"
            expiry = int(time.time()) + TTL_DAYS * 24 * 3600

            item = {
                "userId": user,
                "sk": f"{timestamp}#{request_id}",
                "teamId": team,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost_usd": str(cost),
                "latency_ms": int(latency_ms),
                "status": "200",
                "endpoint": endpoint,
                "request_id": request_id,
                "timestamp": timestamp,
                "expiry": expiry,
            }

            _audit_table.put_item(Item=item)

        except Exception:
            logger.exception("Failed to write audit log for success event")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        """비동기 실패 이벤트 감사 로그를 DynamoDB에 기록한다."""
        try:
            user, team, model, request_id, endpoint = self._extract_metadata(kwargs)

            latency_ms = round((end_time - start_time).total_seconds() * 1000, 2)
            timestamp = datetime.utcnow().isoformat() + "Z"
            expiry = int(time.time()) + TTL_DAYS * 24 * 3600

            exception = kwargs.get("exception") or kwargs.get("original_exception")
            error_message = str(exception) if exception else "unknown error"

            item = {
                "userId": user,
                "sk": f"{timestamp}#{request_id}",
                "teamId": team,
                "model": model,
                "input_tokens": 0,
                "output_tokens": 0,
                "cost_usd": "0",
                "latency_ms": int(latency_ms),
                "status": "error",
                "endpoint": endpoint,
                "request_id": request_id,
                "timestamp": timestamp,
                "error_message": error_message,
                "expiry": expiry,
            }

            _audit_table.put_item(Item=item)

        except Exception:
            logger.exception("Failed to write audit log for failure event")

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        """동기 실패 이벤트 감사 로그를 DynamoDB에 기록한다."""
        try:
            user, team, model, request_id, endpoint = self._extract_metadata(kwargs)

            latency_ms = round((end_time - start_time).total_seconds() * 1000, 2)
            timestamp = datetime.utcnow().isoformat() + "Z"
            expiry = int(time.time()) + TTL_DAYS * 24 * 3600

            exception = kwargs.get("exception") or kwargs.get("original_exception")
            error_message = str(exception) if exception else "unknown error"

            item = {
                "userId": user,
                "sk": f"{timestamp}#{request_id}",
                "teamId": team,
                "model": model,
                "input_tokens": 0,
                "output_tokens": 0,
                "cost_usd": "0",
                "latency_ms": int(latency_ms),
                "status": "error",
                "endpoint": endpoint,
                "request_id": request_id,
                "timestamp": timestamp,
                "error_message": error_message,
                "expiry": expiry,
            }

            _audit_table.put_item(Item=item)

        except Exception:
            logger.exception("Failed to write audit log for failure event")


audit_logger = AuditLogger()
