#!/bin/bash
# get-gateway-token.sh
# AWS SSO 자격증명으로 Token Service를 호출하여 LiteLLM Virtual Key를 반환하는 스크립트
# Claude Code의 apiKeyHelper로 사용됨
#
# AWS 프로필 결정:
#   - AWS_PROFILE 환경변수가 설정되어 있으면 해당 프로필의 SSO 자격증명 사용
#   - AWS_PROFILE이 없으면 default 프로필 또는 현재 활성화된 자격증명 사용
#   - 스크립트에 --profile 하드코딩 없음 (환경변수로 유연하게 제어)
#
# 프로덕션 환경:
#   export AWS_PROFILE=claude-code    # 모든 개발자 동일 프로필
#   aws sso login                     # 브라우저에서 각자 계정으로 로그인
#
# 테스트 환경 (여러 사용자 시뮬레이션):
#   export AWS_PROFILE=claude-code-test1   # 테스트 사용자 1
#   aws sso login
#   export AWS_PROFILE=claude-code-test2   # 테스트 사용자 2
#   aws sso login
#
# 흐름:
#   1. AWS_PROFILE에 해당하는 SSO 자격증명 확인 + export
#   2. Token Service 호출 (SigV4 서명) -> Virtual Key 반환
#
# 사용법:
#   chmod +x get-gateway-token.sh
#   ./get-gateway-token.sh

set -euo pipefail

TOKEN_SERVICE_URL="${TOKEN_SERVICE_URL:-https://{API_GW_ID}.execute-api.ap-northeast-2.amazonaws.com/v1/auth/token}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
# 1. SSO 자격증명 확인 + export
# AWS_PROFILE 환경변수가 설정되어 있으면 해당 프로필 사용, 없으면 현재 자격증명 사용
eval $(aws configure export-credentials --format env 2>/dev/null) || {
  echo "ERROR: aws sso login 을 실행하세요" >&2
  exit 1
}

# 2. Token Service 호출 -> Virtual Key 반환
RESPONSE=$(curl -s -X POST "$TOKEN_SERVICE_URL" \
  --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" \
  --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
  -H "x-amz-security-token: ${AWS_SESSION_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d '{}' 2>/dev/null)

TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Token Service에서 키를 받지 못했습니다: $RESPONSE" >&2
  exit 1
fi

echo "$TOKEN"
