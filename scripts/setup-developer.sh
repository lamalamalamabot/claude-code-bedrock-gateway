#!/bin/bash
# setup-developer.sh
# Claude Code Enterprise 개발자 초기 설정 스크립트
# AWS CLI 설치 확인, SSO 프로필 설정 안내, 로그인 실행

set -euo pipefail

echo "============================================"
echo " Claude Code Enterprise - 개발자 설정"
echo "============================================"
echo ""

# 1. AWS CLI v2 설치 확인
echo "[1/4] AWS CLI 설치 확인..."
if ! command -v aws &> /dev/null; then
  echo "ERROR: AWS CLI가 설치되어 있지 않습니다."
  echo ""
  echo "설치 방법:"
  echo "  macOS:  brew install awscli"
  echo "  Linux:  curl 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip' -o 'awscliv2.zip' && unzip awscliv2.zip && sudo ./aws/install"
  echo ""
  exit 1
fi

AWS_VERSION=$(aws --version 2>&1)
echo "  설치됨: $AWS_VERSION"
echo ""

# 2. jq 설치 확인
echo "[2/4] jq 설치 확인..."
if ! command -v jq &> /dev/null; then
  echo "ERROR: jq가 설치되어 있지 않습니다."
  echo ""
  echo "설치 방법:"
  echo "  macOS:  brew install jq"
  echo "  Linux:  sudo apt-get install jq  또는  sudo yum install jq"
  echo ""
  exit 1
fi
echo "  설치됨: $(jq --version)"
echo ""

# 3. AWS SSO 프로필 설정 안내
echo "[3/4] AWS SSO 프로필 설정..."
CONFIG_FILE="$HOME/.aws/config"

if grep -q "\[profile claude-code\]" "$CONFIG_FILE" 2>/dev/null; then
  echo "  'claude-code' 프로필이 이미 존재합니다."
else
  echo "  ~/.aws/config 파일에 다음 내용을 추가하세요:"
  echo ""
  echo "  [profile claude-code]"
  echo "  sso_session = my-sso"
  echo "  sso_account_id = {SSO_ACCOUNT_ID}"
  echo "  sso_role_name = {SSO_ROLE_NAME}"
  echo "  region = ap-northeast-2"
  echo "  output = json"
  echo ""
  echo "  [sso-session my-sso]"
  echo "  sso_start_url = {SSO_START_URL}"
  echo "  sso_region = ap-northeast-2"
  echo "  sso_registration_scopes = sso:account:access"
  echo ""
  echo "  플레이스홀더를 실제 값으로 교체하세요."
  echo "  (관리자에게 문의하여 SSO 정보를 받으세요)"
  echo ""
fi
echo ""

# 4. AWS SSO 로그인
echo "[4/4] AWS SSO 로그인..."
echo "  다음 명령어를 실행하여 SSO 로그인을 완료하세요:"
echo ""
echo "    aws sso login --profile claude-code"
echo ""
echo "  로그인 후 자격증명을 확인하세요:"
echo ""
echo "    aws sts get-caller-identity --profile claude-code"
echo ""

echo "============================================"
echo " 설정 안내 완료"
echo "============================================"
echo ""
echo "다음 단계:"
echo "  1. ~/.aws/config에 SSO 프로필 추가 (위 내용 참조)"
echo "  2. aws sso login --profile claude-code 실행"
echo "  3. ~/.claude/settings.json에 Claude Code 설정 적용"
echo "     (templates/claude-settings.json 참조)"
echo ""
