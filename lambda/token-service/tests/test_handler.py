"""Token Service Lambda 핸들러 유닛 테스트 — Virtual Key 자동 생성/조회"""

import json
import os
import urllib.error
from unittest import mock

import pytest

from handler import _parse_sso_arn, _resolve_team, handler
import handler as handler_module


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

FAKE_MASTER_KEY = "sk-test-master-key-1234"
FAKE_MASTER_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:litellm-master-key"
FAKE_LITELLM_ENDPOINT = "http://internal-alb.example.com:4000"
FAKE_TEAM_MAPPING = json.dumps({"alice": "engineering-backend", "bob": "engineering-frontend"})

FAKE_VIRTUAL_KEY = "sk-virtual-key-abc123"

ALICE_ARN = "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_ClaudeCodeUser_abc123/alice"


@pytest.fixture(autouse=True)
def _reset_cache():
    """각 테스트 전에 Master Key 캐시를 초기화한다."""
    handler_module._master_key_cache = None
    yield
    handler_module._master_key_cache = None


@pytest.fixture
def _env_vars():
    """테스트용 환경변수를 설정한다."""
    with mock.patch.dict(os.environ, {
        "LITELLM_MASTER_KEY_ARN": FAKE_MASTER_KEY_ARN,
        "LITELLM_ENDPOINT": FAKE_LITELLM_ENDPOINT,
        "TEAM_MAPPING": FAKE_TEAM_MAPPING,
    }):
        yield


@pytest.fixture
def _mock_secrets_manager():
    """Secrets Manager 클라이언트를 mock한다."""
    with mock.patch.object(handler_module, "_secrets_client") as mock_client:
        mock_client.get_secret_value.return_value = {"SecretString": FAKE_MASTER_KEY}
        yield mock_client


@pytest.fixture
def _mock_dynamodb_no_cache():
    """DynamoDB — 캐시 없음 (get_item은 빈 결과, put_item 성공)."""
    mock_table = mock.MagicMock()
    mock_table.get_item.return_value = {}
    mock_table.put_item.return_value = {}
    with mock.patch.object(handler_module._dynamodb, "Table", return_value=mock_table):
        yield mock_table


@pytest.fixture
def _mock_dynamodb_cached():
    """DynamoDB — 캐시 있음."""
    mock_table = mock.MagicMock()
    mock_table.get_item.return_value = {
        "Item": {
            "pk": "USER#alice",
            "sk": "VIRTUAL_KEY",
            "virtual_key": FAKE_VIRTUAL_KEY,
            "key_alias": "sso-alice",
        }
    }
    with mock.patch.object(handler_module._dynamodb, "Table", return_value=mock_table):
        yield mock_table


@pytest.fixture
def _mock_dynamodb_write_failure():
    """DynamoDB — get_item은 빈 결과, put_item은 실패."""
    mock_table = mock.MagicMock()
    mock_table.get_item.return_value = {}
    mock_table.put_item.side_effect = Exception("DynamoDB write failure")
    with mock.patch.object(handler_module._dynamodb, "Table", return_value=mock_table):
        yield mock_table


@pytest.fixture
def _mock_litellm_new_user():
    """LiteLLM API — /key/generate 성공."""
    with mock.patch.object(handler_module, "_litellm_request") as mock_req:
        def side_effect(method, url, master_key, body=None):
            if method == "POST" and "/key/generate" in url:
                return {"key": FAKE_VIRTUAL_KEY}
            if method == "GET" and "/user/info" in url:
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
            return {}

        mock_req.side_effect = side_effect
        yield mock_req


@pytest.fixture
def _mock_litellm_alias_conflict():
    """LiteLLM API — /key/generate 400 (alias 충돌) -> /user/info로 복구."""
    with mock.patch.object(handler_module, "_litellm_request") as mock_req:
        def side_effect(method, url, master_key, body=None):
            if method == "POST" and "/key/generate" in url:
                raise urllib.error.HTTPError(url, 400, "Bad Request", {}, None)
            if method == "GET" and "/user/info" in url:
                return {
                    "keys": [
                        {
                            "token": FAKE_VIRTUAL_KEY,
                            "key_alias": "sso-alice",
                        }
                    ]
                }
            return {}

        mock_req.side_effect = side_effect
        yield mock_req


@pytest.fixture
def _mock_litellm_down():
    """LiteLLM API — 모든 호출 500."""
    with mock.patch.object(handler_module, "_litellm_request") as mock_req:
        def side_effect(method, url, master_key, body=None):
            raise urllib.error.HTTPError(url, 500, "Internal Server Error", {}, None)

        mock_req.side_effect = side_effect
        yield mock_req


def _make_event(user_arn: str) -> dict:
    """API Gateway IAM Auth 이벤트를 생성한다."""
    return {
        "requestContext": {
            "identity": {
                "userArn": user_arn,
            }
        }
    }


# ---------------------------------------------------------------------------
# ARN 파싱 테스트
# ---------------------------------------------------------------------------

class TestParseSsoArn:
    """_parse_sso_arn 함수 테스트"""

    def test_valid_sso_arn(self):
        arn = "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_ClaudeCodeUser_abc123/alice"
        result = _parse_sso_arn(arn)
        assert result is not None
        username, role_name, account = result
        assert username == "alice"
        assert role_name == "ClaudeCodeUser"
        assert account == "123456789012"

    def test_valid_sso_arn_admin_role(self):
        arn = "arn:aws:sts::987654321098:assumed-role/AWSReservedSSO_ClaudeCodeAdmin_def456/charlie"
        result = _parse_sso_arn(arn)
        assert result is not None
        username, role_name, account = result
        assert username == "charlie"
        assert role_name == "ClaudeCodeAdmin"
        assert account == "987654321098"

    def test_non_sso_arn_returns_none(self):
        arn = "arn:aws:sts::123456789012:assumed-role/MyCustomRole/session-name"
        assert _parse_sso_arn(arn) is None

    def test_iam_user_arn_returns_none(self):
        arn = "arn:aws:iam::123456789012:user/alice"
        assert _parse_sso_arn(arn) is None

    def test_empty_string_returns_none(self):
        assert _parse_sso_arn("") is None

    def test_username_with_special_chars(self):
        arn = "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_ClaudeCodeUser_abc123/alice.kim"
        result = _parse_sso_arn(arn)
        assert result is not None
        assert result[0] == "alice.kim"


# ---------------------------------------------------------------------------
# 팀 매핑 테스트
# ---------------------------------------------------------------------------

class TestResolveTeam:

    def test_known_user(self):
        with mock.patch.dict(os.environ, {"TEAM_MAPPING": FAKE_TEAM_MAPPING}):
            assert _resolve_team("alice") == "engineering-backend"
            assert _resolve_team("bob") == "engineering-frontend"

    def test_unknown_user_returns_default(self):
        with mock.patch.dict(os.environ, {"TEAM_MAPPING": FAKE_TEAM_MAPPING}):
            assert _resolve_team("unknown-user") == "default"

    def test_empty_mapping_returns_default(self):
        with mock.patch.dict(os.environ, {"TEAM_MAPPING": "{}"}):
            assert _resolve_team("alice") == "default"

    def test_invalid_json_returns_default(self):
        with mock.patch.dict(os.environ, {"TEAM_MAPPING": "not-json"}):
            assert _resolve_team("alice") == "default"

    def test_no_env_var_returns_default(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            assert _resolve_team("alice") == "default"


# ---------------------------------------------------------------------------
# 신규 사용자: DynamoDB 캐시 없음 -> /key/generate -> DynamoDB 저장 -> 키 반환
# ---------------------------------------------------------------------------

class TestHandlerNewUser:
    """신규 사용자 — Virtual Key 생성 흐름"""

    def test_success_creates_virtual_key(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_no_cache, _mock_litellm_new_user
    ):
        """DynamoDB 캐시 없음 -> LiteLLM 키 생성 -> 키 반환."""
        event = _make_event(ALICE_ARN)
        result = handler(event, None)

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["token"] == FAKE_VIRTUAL_KEY

    def test_litellm_generate_called_with_correct_params(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_no_cache, _mock_litellm_new_user
    ):
        """LiteLLM /key/generate가 올바른 파라미터로 호출되어야 한다."""
        event = _make_event(ALICE_ARN)
        handler(event, None)

        calls = _mock_litellm_new_user.call_args_list
        generate_call = [c for c in calls if c[0][0] == "POST" and "/key/generate" in c[0][1]]
        assert len(generate_call) == 1

        _, url, master_key = generate_call[0][0]
        body = generate_call[0][1]["body"]
        assert master_key == FAKE_MASTER_KEY
        assert body["key_alias"] == "sso-alice"
        assert body["user_id"] == "alice"
        assert body["team_id"] == "engineering-backend"
        assert body["metadata"]["sso_arn"] == ALICE_ARN
        assert body["metadata"]["account"] == "123456789012"

    def test_dynamodb_cache_written(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_no_cache, _mock_litellm_new_user
    ):
        """키 생성 후 DynamoDB에 캐시가 저장되어야 한다."""
        event = _make_event(ALICE_ARN)
        handler(event, None)

        _mock_dynamodb_no_cache.put_item.assert_called_once_with(Item={
            "pk": "USER#alice",
            "sk": "VIRTUAL_KEY",
            "virtual_key": FAKE_VIRTUAL_KEY,
            "key_alias": "sso-alice",
        })


# ---------------------------------------------------------------------------
# 기존 사용자: DynamoDB 캐시 있음 -> LiteLLM 미호출 -> 키 반환
# ---------------------------------------------------------------------------

class TestHandlerCachedUser:
    """기존 사용자 — DynamoDB 캐시 히트"""

    def test_returns_cached_key(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_cached
    ):
        """DynamoDB 캐시가 있으면 즉시 반환해야 한다."""
        event = _make_event(ALICE_ARN)
        result = handler(event, None)

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["token"] == FAKE_VIRTUAL_KEY

    def test_litellm_not_called_for_cached_user(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_cached
    ):
        """DynamoDB 캐시 히트 시 LiteLLM API가 호출되지 않아야 한다."""
        with mock.patch.object(handler_module, "_litellm_request") as mock_req:
            event = _make_event(ALICE_ARN)
            handler(event, None)
            mock_req.assert_not_called()

    def test_secrets_manager_not_called_for_cached_user(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_cached
    ):
        """DynamoDB 캐시 히트 시 Secrets Manager도 호출되지 않아야 한다."""
        event = _make_event(ALICE_ARN)
        handler(event, None)
        _mock_secrets_manager.get_secret_value.assert_not_called()


# ---------------------------------------------------------------------------
# alias 충돌: /key/generate 400 -> 복구 로직 -> 키 반환
# ---------------------------------------------------------------------------

class TestHandlerAliasConflict:
    """alias 충돌 — 기존 키 복구"""

    def test_recovers_existing_key_on_alias_conflict(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_no_cache, _mock_litellm_alias_conflict
    ):
        """/key/generate 400 -> /user/info로 기존 키 복구."""
        event = _make_event(ALICE_ARN)
        result = handler(event, None)

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["token"] == FAKE_VIRTUAL_KEY

    def test_user_info_called_after_alias_conflict(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_no_cache, _mock_litellm_alias_conflict
    ):
        """/key/generate 실패 후 /user/info가 호출되어야 한다."""
        event = _make_event(ALICE_ARN)
        handler(event, None)

        calls = _mock_litellm_alias_conflict.call_args_list
        user_info_calls = [c for c in calls if c[0][0] == "GET" and "/user/info" in c[0][1]]
        assert len(user_info_calls) == 1


# ---------------------------------------------------------------------------
# LiteLLM 다운: 500 에러 반환
# ---------------------------------------------------------------------------

class TestHandlerLitellmDown:
    """LiteLLM 장애 — 500 에러"""

    def test_litellm_failure_returns_500(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_no_cache, _mock_litellm_down
    ):
        """LiteLLM이 모두 실패하면 500을 반환해야 한다 (제너릭 메시지)."""
        event = _make_event(ALICE_ARN)
        result = handler(event, None)

        assert result["statusCode"] == 500
        body = json.loads(result["body"])
        assert body["error"] == "Internal server error"


# ---------------------------------------------------------------------------
# DynamoDB 쓰기 실패: 키는 정상 반환
# ---------------------------------------------------------------------------

class TestHandlerDynamoDbWriteFailure:
    """DynamoDB 쓰기 실패 — 키는 정상 반환 (warning만)"""

    def test_returns_key_despite_cache_write_failure(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_write_failure, _mock_litellm_new_user
    ):
        """DynamoDB 쓰기 실패해도 Virtual Key는 정상 반환되어야 한다."""
        event = _make_event(ALICE_ARN)
        result = handler(event, None)

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["token"] == FAKE_VIRTUAL_KEY

    def test_put_item_was_attempted(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_write_failure, _mock_litellm_new_user
    ):
        """put_item 호출은 시도되어야 한다 (실패하더라도)."""
        event = _make_event(ALICE_ARN)
        handler(event, None)
        _mock_dynamodb_write_failure.put_item.assert_called_once()


# ---------------------------------------------------------------------------
# 에러 케이스 테스트
# ---------------------------------------------------------------------------

class TestHandlerErrors:
    """에러 케이스 테스트"""

    def test_missing_arn_returns_400(self, _env_vars, _mock_secrets_manager):
        event = {"requestContext": {"identity": {}}}
        result = handler(event, None)
        assert result["statusCode"] == 400

    def test_non_sso_arn_returns_400(self, _env_vars, _mock_secrets_manager):
        event = _make_event("arn:aws:iam::123456789012:user/alice")
        result = handler(event, None)
        assert result["statusCode"] == 400


# ---------------------------------------------------------------------------
# Master Key 캐싱 테스트
# ---------------------------------------------------------------------------

class TestMasterKeyCaching:
    """Master Key 캐싱 테스트"""

    def test_secrets_manager_called_once(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_no_cache, _mock_litellm_new_user
    ):
        """Master Key는 캐싱되어 Secrets Manager를 한 번만 호출해야 한다."""
        event = _make_event(ALICE_ARN)
        handler(event, None)
        handler(event, None)

        assert _mock_secrets_manager.get_secret_value.call_count == 1

    def test_default_team_for_unmapped_user(
        self, _env_vars, _mock_secrets_manager, _mock_dynamodb_no_cache, _mock_litellm_new_user
    ):
        """매핑되지 않은 사용자는 team이 'default'여야 한다."""
        event = _make_event(
            "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_ClaudeCodeUser_abc123/unknown"
        )
        handler(event, None)

        calls = _mock_litellm_new_user.call_args_list
        generate_call = [c for c in calls if c[0][0] == "POST" and "/key/generate" in c[0][1]]
        assert len(generate_call) == 1
        body = generate_call[0][1]["body"]
        assert body["team_id"] == "default"
