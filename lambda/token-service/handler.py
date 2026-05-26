"""
Token Service Lambda Handler
API Gateway IAM Auth를 통해 인증된 SSO 사용자의 Virtual Key를 자동 생성/조회하여 반환한다.

흐름:
1. API Gateway IAM Auth -> requestContext.identity.userArn에서 호출자 ARN 추출
2. ARN 파싱 -> username, role_name, account 추출
3. IAM Identity Center에서 사용자의 그룹을 자동 조회하여 팀 매핑
4. DynamoDB 캐시에서 Virtual Key 조회 (있으면 즉시 반환)
5. 캐시 없음 -> LiteLLM에 팀 생성(이미 있으면 skip) + /key/generate로 Virtual Key 생성
6. alias 충돌 시 -> 기존 키 삭제 후 재생성
7. DynamoDB에 캐시 저장 (실패해도 키는 반환)
"""

import json
import logging
import os
import re
import ssl
import urllib.error
import urllib.request
from typing import Any

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_region = os.environ.get("AWS_REGION", "ap-northeast-2")
_dynamodb = boto3.resource("dynamodb", region_name=_region)
_secrets_client = boto3.client("secretsmanager", region_name=_region)
_sts_client = boto3.client("sts", region_name=_region)

_master_key_cache: str | None = None
_team_cache: dict[str, str] = {}
_identitystore_client_cache = None

IDENTITY_STORE_ID = os.environ.get("IDENTITY_STORE_ID", "")
IDENTITY_STORE_ROLE_ARN = os.environ.get("IDENTITY_STORE_ROLE_ARN", "")
DEFAULT_TEAM = "default"


def _get_identitystore_client():
    """Identity Store 클라이언트를 반환한다. Cross-account 시 assume role을 수행한다."""
    global _identitystore_client_cache
    if _identitystore_client_cache is not None:
        return _identitystore_client_cache

    if IDENTITY_STORE_ROLE_ARN:
        response = _sts_client.assume_role(
            RoleArn=IDENTITY_STORE_ROLE_ARN,
            RoleSessionName="token-service-identity-store",
            DurationSeconds=900,
        )
        creds = response["Credentials"]
        _identitystore_client_cache = boto3.client(
            "identitystore",
            region_name=_region,
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )
    else:
        _identitystore_client_cache = boto3.client("identitystore", region_name=_region)

    return _identitystore_client_cache


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda 핸들러 엔트리포인트"""
    try:
        user_arn = _extract_user_arn(event)
        if not user_arn:
            return _error_response(400, "요청에서 사용자 ARN을 찾을 수 없습니다.")

        parsed = _parse_sso_arn(user_arn)
        if not parsed:
            return _error_response(400, "SSO ARN 형식이 아닙니다.")

        username, role_name, account = parsed
        logger.info("SSO 인증 확인: user=%s, role=%s, account=%s", username, role_name, account)

        team_id = _get_user_team(username)
        logger.info("팀 매핑: user=%s, team=%s", username, team_id)

        cached_key = _get_cached_key(username)
        if cached_key:
            logger.info("DynamoDB 캐시에서 Virtual Key 반환: user=%s", username)
            return _success_response(cached_key)

        master_key = _get_master_key()

        _ensure_user_exists(master_key, username)
        _ensure_team_exists(master_key, team_id)
        _ensure_team_member(master_key, team_id, username)

        try:
            virtual_key = _create_virtual_key(master_key, username, account, user_arn, team_id)
        except urllib.error.HTTPError as e:
            if e.code == 400:
                logger.info("alias 충돌 감지, 기존 키 삭제 후 재생성: user=%s", username)
                _delete_existing_key(master_key, username)
                virtual_key = _create_virtual_key(master_key, username, account, user_arn, team_id)
            else:
                raise

        _cache_key(username, virtual_key, team_id)

        logger.info("Virtual Key 발급 완료: user=%s, team=%s", username, team_id)
        return _success_response(virtual_key)

    except Exception:
        logger.exception("토큰 발급 중 오류 발생")
        return _error_response(500, "Internal server error")


# ---------------------------------------------------------------------------
# ARN 추출/파싱
# ---------------------------------------------------------------------------

def _extract_user_arn(event: dict[str, Any]) -> str | None:
    """API Gateway 이벤트에서 호출자 ARN을 추출한다."""
    try:
        return event["requestContext"]["identity"]["userArn"]
    except (KeyError, TypeError):
        return None


def _parse_sso_arn(arn: str) -> tuple[str, str, str] | None:
    """
    SSO assumed-role ARN을 파싱하여 (username, role_name, account)를 반환한다.

    예시 ARN:
      arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_ClaudeCodeUser_abc123/alice
    반환:
      ("alice", "ClaudeCodeUser", "123456789012")
    """
    pattern = r"^arn:aws:sts::(\d+):assumed-role/AWSReservedSSO_([^_]+)_[^/]+/(.+)$"
    match = re.match(pattern, arn)
    if not match:
        return None

    account = match.group(1)
    role_name = match.group(2)
    username = match.group(3)

    return username, role_name, account


# ---------------------------------------------------------------------------
# 팀 매핑 (IAM Identity Center 자동 조회)
# ---------------------------------------------------------------------------

def _get_user_team(username: str) -> str:
    """IAM Identity Center에서 사용자의 그룹을 조회하여 팀을 결정한다."""
    if username in _team_cache:
        return _team_cache[username]

    try:
        user_id = _find_identity_store_user(username)
        if not user_id:
            logger.info("Identity Store에서 사용자를 찾지 못함: user=%s", username)
            _team_cache[username] = DEFAULT_TEAM
            return DEFAULT_TEAM

        groups = _get_user_groups(user_id)
        if groups:
            team_id = groups[0]
            logger.info("Identity Store 그룹 조회 성공: user=%s, groups=%s, team=%s", username, groups, team_id)
            _team_cache[username] = team_id
            return team_id

    except Exception:
        logger.warning("Identity Store 조회 실패, default 팀 사용: user=%s", username, exc_info=True)

    _team_cache[username] = DEFAULT_TEAM
    return DEFAULT_TEAM


def _find_identity_store_user(username: str) -> str | None:
    """Identity Store에서 username으로 사용자 ID를 찾는다."""
    client = _get_identitystore_client()
    response = client.list_users(
        IdentityStoreId=IDENTITY_STORE_ID,
        Filters=[{
            "AttributePath": "UserName",
            "AttributeValue": username,
        }],
    )
    users = response.get("Users", [])
    if users:
        return users[0]["UserId"]
    return None


def _get_user_groups(user_id: str) -> list[str]:
    """Identity Store에서 사용자가 속한 그룹 이름 목록을 반환한다."""
    client = _get_identitystore_client()
    response = client.list_group_memberships_for_member(
        IdentityStoreId=IDENTITY_STORE_ID,
        MemberId={"UserId": user_id},
    )
    memberships = response.get("GroupMemberships", [])

    group_names = []
    for membership in memberships:
        group_id = membership["GroupId"]
        group_response = client.describe_group(
            IdentityStoreId=IDENTITY_STORE_ID,
            GroupId=group_id,
        )
        group_names.append(group_response["DisplayName"])

    return group_names


def _ensure_user_exists(master_key: str, username: str) -> None:
    """LiteLLM에 사용자가 존재하는지 확인하고, 없으면 생성한다."""
    endpoint = os.environ["LITELLM_ENDPOINT"]
    url = f"{endpoint}/user/new"
    body = {
        "user_id": username,
        "user_role": "internal_user",
        "auto_create_key": False,
    }
    try:
        _litellm_request("POST", url, master_key, body=body)
        logger.info("LiteLLM 사용자 생성: user=%s", username)
    except urllib.error.HTTPError as e:
        if e.code == 400:
            pass
        else:
            logger.warning("LiteLLM 사용자 생성 실패: user=%s", username, exc_info=True)


def _ensure_team_member(master_key: str, team_id: str, username: str) -> None:
    """사용자를 팀에 멤버로 추가한다. 이미 멤버이면 skip."""
    endpoint = os.environ["LITELLM_ENDPOINT"]
    url = f"{endpoint}/team/member_add"
    body = {
        "team_id": team_id,
        "member": {"role": "user", "user_id": username},
    }
    try:
        _litellm_request("POST", url, master_key, body=body)
        logger.info("팀 멤버 추가: user=%s, team=%s", username, team_id)
    except urllib.error.HTTPError as e:
        if e.code == 400:
            pass
        else:
            logger.warning("팀 멤버 추가 실패: user=%s, team=%s", username, team_id, exc_info=True)


def _ensure_team_exists(master_key: str, team_id: str) -> None:
    """LiteLLM에 팀이 존재하는지 확인하고, 없으면 생성한다."""
    endpoint = os.environ["LITELLM_ENDPOINT"]
    url = f"{endpoint}/team/new"
    body = {
        "team_id": team_id,
        "team_alias": team_id,
    }
    try:
        _litellm_request("POST", url, master_key, body=body)
        logger.info("LiteLLM 팀 생성: team=%s", team_id)
    except urllib.error.HTTPError as e:
        if e.code == 400:
            pass
        else:
            logger.warning("LiteLLM 팀 생성 실패: team=%s", team_id, exc_info=True)


# ---------------------------------------------------------------------------
# DynamoDB 캐시
# ---------------------------------------------------------------------------

def _get_cached_key(username: str) -> str | None:
    """DynamoDB config 테이블에서 캐시된 Virtual Key를 조회한다."""
    table_name = os.environ.get("CONFIG_TABLE_NAME", "llm-gateway-config")
    table = _dynamodb.Table(table_name)
    try:
        result = table.get_item(Key={"pk": f"USER#{username}", "sk": "VIRTUAL_KEY"})
        item = result.get("Item")
        if item and item.get("virtual_key"):
            return item["virtual_key"]
    except Exception:
        logger.warning("DynamoDB 캐시 조회 실패: user=%s", username, exc_info=True)
    return None


def _cache_key(username: str, virtual_key: str, team_id: str) -> None:
    """DynamoDB에 Virtual Key를 캐시한다. 실패해도 치명적이지 않다."""
    table_name = os.environ.get("CONFIG_TABLE_NAME", "llm-gateway-config")
    table = _dynamodb.Table(table_name)
    try:
        table.put_item(Item={
            "pk": f"USER#{username}",
            "sk": "VIRTUAL_KEY",
            "virtual_key": virtual_key,
            "key_alias": f"sso-{username}",
            "team_id": team_id,
        })
    except Exception:
        logger.warning("DynamoDB 캐시 저장 실패: user=%s", username, exc_info=True)


# ---------------------------------------------------------------------------
# Secrets Manager
# ---------------------------------------------------------------------------

def _get_master_key() -> str:
    """Secrets Manager에서 LiteLLM Master Key를 조회한다. 모듈 레벨 캐싱."""
    global _master_key_cache
    if _master_key_cache is not None:
        return _master_key_cache

    secret_arn = os.environ["LITELLM_MASTER_KEY_ARN"]
    response = _secrets_client.get_secret_value(SecretId=secret_arn)
    _master_key_cache = f"sk-{response['SecretString']}"
    return _master_key_cache


# ---------------------------------------------------------------------------
# LiteLLM API
# ---------------------------------------------------------------------------

def _create_virtual_key(master_key: str, username: str, account: str, user_arn: str, team_id: str) -> str:
    """LiteLLM /key/generate로 Virtual Key를 생성한다."""
    endpoint = os.environ["LITELLM_ENDPOINT"]
    url = f"{endpoint}/key/generate"
    body = {
        "key_alias": f"sso-{username}",
        "user_id": username,
        "team_id": team_id,
        "max_budget": 100.0,
        "budget_duration": "30d",
        "metadata": {
            "sso_arn": user_arn,
            "account": account,
            "team_id": team_id,
        },
    }
    response = _litellm_request("POST", url, master_key, body=body)
    return response["key"]


def _delete_existing_key(master_key: str, username: str) -> None:
    """기존 Virtual Key를 LiteLLM에서 삭제한다."""
    endpoint = os.environ["LITELLM_ENDPOINT"]
    url = f"{endpoint}/key/delete"
    body = {"key_aliases": [f"sso-{username}"]}
    try:
        _litellm_request("POST", url, master_key, body=body)
        logger.info("기존 키 삭제 완료: user=%s", username)
    except urllib.error.HTTPError:
        logger.warning("기존 키 삭제 실패: user=%s", username, exc_info=True)


def _litellm_request(method: str, url: str, master_key: str, body: dict | None = None) -> dict:
    """LiteLLM API에 HTTP 요청을 보낸다."""
    headers = {
        "Authorization": f"Bearer {master_key}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body else None

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = ""
        try:
            error_body = e.read().decode("utf-8")
        except Exception:
            pass
        logger.error("LiteLLM API 에러: %s %s -> %d %s", method, url, e.code, error_body)
        raise


# ---------------------------------------------------------------------------
# 응답 헬퍼
# ---------------------------------------------------------------------------

def _success_response(virtual_key: str) -> dict[str, Any]:
    """성공 응답을 생성한다."""
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"token": virtual_key}),
    }


def _error_response(status_code: int, message: str) -> dict[str, Any]:
    """에러 응답을 생성한다."""
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"error": message}),
    }
