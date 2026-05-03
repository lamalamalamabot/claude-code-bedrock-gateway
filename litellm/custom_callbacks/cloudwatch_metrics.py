"""
CloudWatch 커스텀 메트릭 콜백
LLMGateway 네임스페이스에 요청 수, 토큰 사용량, 비용, 지연시간 등 기록
"""

import logging
import os
from datetime import datetime

import boto3

from litellm.integrations.custom_logger import CustomLogger

logger = logging.getLogger(__name__)

CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "LLMGateway")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

cloudwatch_client = boto3.client("cloudwatch", region_name=AWS_REGION)


class CloudWatchMetrics(CustomLogger):
    """LiteLLM 요청 메트릭을 CloudWatch에 발행하는 콜백"""

    def _extract_metadata(self, kwargs):
        """kwargs에서 user, team, model 메타데이터를 추출한다."""
        metadata = kwargs.get("litellm_params", {}).get("metadata", {}) or {}
        user = metadata.get("user_api_key_user_id", "unknown")
        team = metadata.get("user_api_key_team_id", "unknown")
        model = kwargs.get("model", "unknown")
        return user, team, model

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            user, team, model = self._extract_metadata(kwargs)

            # 토큰 사용량 추출
            usage = getattr(response_obj, "usage", None)
            prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
            completion_tokens = getattr(usage, "completion_tokens", 0) or 0

            # 비용 추출
            cost = kwargs.get("response_cost", 0) or 0

            # 지연시간 계산 (ms)
            latency_ms = 0
            if isinstance(start_time, datetime) and isinstance(end_time, datetime):
                latency_ms = (end_time - start_time).total_seconds() * 1000

            timestamp = end_time if isinstance(end_time, datetime) else datetime.utcnow()

            team_user_model_dims = [
                {"Name": "team", "Value": str(team)},
                {"Name": "user", "Value": str(user)},
                {"Name": "model", "Value": str(model)},
            ]

            metric_data = [
                {
                    "MetricName": "request_count",
                    "Dimensions": team_user_model_dims,
                    "Timestamp": timestamp,
                    "Value": 1,
                    "Unit": "Count",
                },
                {
                    "MetricName": "input_token_count",
                    "Dimensions": team_user_model_dims,
                    "Timestamp": timestamp,
                    "Value": float(prompt_tokens),
                    "Unit": "Count",
                },
                {
                    "MetricName": "output_token_count",
                    "Dimensions": team_user_model_dims,
                    "Timestamp": timestamp,
                    "Value": float(completion_tokens),
                    "Unit": "Count",
                },
                {
                    "MetricName": "cost_usd",
                    "Dimensions": team_user_model_dims,
                    "Timestamp": timestamp,
                    "Value": float(cost),
                    "Unit": "None",
                },
                {
                    "MetricName": "latency_ms",
                    "Dimensions": [{"Name": "model", "Value": str(model)}],
                    "Timestamp": timestamp,
                    "Value": float(latency_ms),
                    "Unit": "Milliseconds",
                },
            ]

            cloudwatch_client.put_metric_data(
                Namespace=CW_NAMESPACE,
                MetricData=metric_data,
            )

        except Exception:
            logger.exception("Failed to publish CloudWatch metrics for success event")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        try:
            _, team, _ = self._extract_metadata(kwargs)

            # 에러 타입 추출
            exception = kwargs.get("exception", None)
            error_type = type(exception).__name__ if exception else "UnknownError"

            timestamp = end_time if isinstance(end_time, datetime) else datetime.utcnow()

            cloudwatch_client.put_metric_data(
                Namespace=CW_NAMESPACE,
                MetricData=[
                    {
                        "MetricName": "error_count",
                        "Dimensions": [
                            {"Name": "team", "Value": str(team)},
                            {"Name": "error_type", "Value": error_type},
                        ],
                        "Timestamp": timestamp,
                        "Value": 1,
                        "Unit": "Count",
                    },
                ],
            )

        except Exception:
            logger.exception("Failed to publish CloudWatch metrics for failure event")

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            user, team, model = self._extract_metadata(kwargs)

            usage = getattr(response_obj, "usage", None)
            prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
            completion_tokens = getattr(usage, "completion_tokens", 0) or 0
            cost = kwargs.get("response_cost", 0) or 0

            latency_ms = 0
            if isinstance(start_time, datetime) and isinstance(end_time, datetime):
                latency_ms = (end_time - start_time).total_seconds() * 1000

            timestamp = end_time if isinstance(end_time, datetime) else datetime.utcnow()

            team_user_model_dims = [
                {"Name": "team", "Value": str(team)},
                {"Name": "user", "Value": str(user)},
                {"Name": "model", "Value": str(model)},
            ]

            metric_data = [
                {
                    "MetricName": "request_count",
                    "Dimensions": team_user_model_dims,
                    "Timestamp": timestamp,
                    "Value": 1,
                    "Unit": "Count",
                },
                {
                    "MetricName": "input_token_count",
                    "Dimensions": team_user_model_dims,
                    "Timestamp": timestamp,
                    "Value": float(prompt_tokens),
                    "Unit": "Count",
                },
                {
                    "MetricName": "output_token_count",
                    "Dimensions": team_user_model_dims,
                    "Timestamp": timestamp,
                    "Value": float(completion_tokens),
                    "Unit": "Count",
                },
                {
                    "MetricName": "cost_usd",
                    "Dimensions": team_user_model_dims,
                    "Timestamp": timestamp,
                    "Value": float(cost),
                    "Unit": "None",
                },
                {
                    "MetricName": "latency_ms",
                    "Dimensions": [{"Name": "model", "Value": str(model)}],
                    "Timestamp": timestamp,
                    "Value": float(latency_ms),
                    "Unit": "Milliseconds",
                },
            ]

            cloudwatch_client.put_metric_data(
                Namespace=CW_NAMESPACE,
                MetricData=metric_data,
            )

        except Exception:
            logger.exception("Failed to publish CloudWatch metrics for success event")

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        try:
            _, team, _ = self._extract_metadata(kwargs)

            exception = kwargs.get("exception", None)
            error_type = type(exception).__name__ if exception else "UnknownError"

            timestamp = end_time if isinstance(end_time, datetime) else datetime.utcnow()

            cloudwatch_client.put_metric_data(
                Namespace=CW_NAMESPACE,
                MetricData=[
                    {
                        "MetricName": "error_count",
                        "Dimensions": [
                            {"Name": "team", "Value": str(team)},
                            {"Name": "error_type", "Value": error_type},
                        ],
                        "Timestamp": timestamp,
                        "Value": 1,
                        "Unit": "Count",
                    },
                ],
            )

        except Exception:
            logger.exception("Failed to publish CloudWatch metrics for failure event")


cloudwatch_metrics = CloudWatchMetrics()
