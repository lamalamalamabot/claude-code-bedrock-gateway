#!/bin/bash
# view-usage.sh
# SSO 인증된 사용자의 LiteLLM 사용량 및 비용을 조회하는 CLI 대시보드
#
# 사용법:
#   ./view-usage.sh              # 기본: 최근 30일 요약
#   ./view-usage.sh --days 7     # 최근 7일
#   ./view-usage.sh --month      # 이번 달
#   ./view-usage.sh --detail     # 개별 요청 로그 포함
#
# 필요: jq, python3, curl, aws cli (SSO 로그인 상태)

set -euo pipefail

# ─── 설정 자동 감지 ───────────────────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
DAYS=30
SHOW_DETAIL=false
THIS_MONTH=false

# Claude Code settings.json에서 GATEWAY_URL, apiKeyHelper 경로 자동 추출
_auto_detect_settings() {
  local settings_file=""
  for f in \
    "$HOME/.claude/settings.json" \
    "$HOME/.claude/settings.local.json" \
    "$HOME/.config/claude-code/settings.json"; do
    if [[ -f "$f" ]]; then
      settings_file="$f"
      break
    fi
  done

  if [[ -z "$settings_file" ]]; then
    return 0
  fi

  # GATEWAY_URL: ANTHROPIC_BEDROCK_BASE_URL에서 /bedrock 제거
  if [[ -z "${GATEWAY_URL:-}" ]]; then
    GATEWAY_URL=$(python3 -c "
import json
try:
    with open('$settings_file') as f: d = json.load(f)
    url = d.get('env',{}).get('ANTHROPIC_BEDROCK_BASE_URL','')
    print(url.replace('/bedrock','').rstrip('/'))
except: print('')
" 2>/dev/null) || true
  fi

  # apiKeyHelper 경로 (VK를 가져올 때 이 스크립트를 직접 실행)
  if [[ -z "${API_KEY_HELPER:-}" ]]; then
    API_KEY_HELPER=$(python3 -c "
import json
try:
    with open('$settings_file') as f: d = json.load(f)
    print(d.get('apiKeyHelper',''))
except: print('')
" 2>/dev/null) || true
  fi

  return 0
}

_auto_detect_settings

GATEWAY_URL="${GATEWAY_URL:-}"
API_KEY_HELPER="${API_KEY_HELPER:-}"

# ─── 색상 정의 ─────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
  CYAN='\033[36m'
  GREEN='\033[32m'
  YELLOW='\033[33m'
  RED='\033[31m'
  BLUE='\033[34m'
  MAGENTA='\033[35m'
  WHITE='\033[97m'
  BG_BLUE='\033[44m'
  BG_CYAN='\033[46m'
  UNDERLINE='\033[4m'
else
  BOLD='' DIM='' RESET='' CYAN='' GREEN='' YELLOW='' RED='' BLUE='' MAGENTA='' WHITE='' BG_BLUE='' BG_CYAN='' UNDERLINE=''
fi

# ─── 인자 파싱 ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --days|-d) DAYS="$2"; shift 2 ;;
    --month|-m) THIS_MONTH=true; shift ;;
    --detail) SHOW_DETAIL=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--days N] [--month] [--detail]"
      echo ""
      echo "Options:"
      echo "  --days, -d N   최근 N일 조회 (기본: 30)"
      echo "  --month, -m    이번 달 조회"
      echo "  --detail       개별 요청 로그 포함"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ─── 날짜 계산 ─────────────────────────────────────────────────────────────────
if $THIS_MONTH; then
  START_DATE=$(date -u +"%Y-%m-01")
else
  START_DATE=$(date -u -d "$DAYS days ago" +"%Y-%m-%d" 2>/dev/null || date -u -v-${DAYS}d +"%Y-%m-%d")
fi
END_DATE=$(date -u +"%Y-%m-%d")

# ─── VK 가져오기 ──────────────────────────────────────────────────────────────
get_virtual_key() {
  # 1순위: apiKeyHelper 스크립트 직접 실행 (Claude Code와 동일한 방식)
  if [[ -n "$API_KEY_HELPER" && -x "$API_KEY_HELPER" ]]; then
    local token
    token=$("$API_KEY_HELPER" 2>/dev/null) || {
      echo -e "${RED}ERROR: apiKeyHelper 실행 실패. aws sso login 을 확인하세요${RESET}" >&2
      exit 1
    }
    if [[ -n "$token" ]]; then
      echo "$token"
      return 0
    fi
  fi

  # 2순위: 같은 디렉토리의 get-gateway-token.sh
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -x "$script_dir/get-gateway-token.sh" ]]; then
    local token
    token=$("$script_dir/get-gateway-token.sh" 2>/dev/null) || {
      echo -e "${RED}ERROR: get-gateway-token.sh 실행 실패. aws sso login 을 확인하세요${RESET}" >&2
      exit 1
    }
    if [[ -n "$token" ]]; then
      echo "$token"
      return 0
    fi
  fi

  echo -e "${RED}ERROR: Virtual Key를 가져올 수 없습니다.${RESET}" >&2
  echo -e "${RED}  apiKeyHelper 또는 get-gateway-token.sh를 확인하세요.${RESET}" >&2
  exit 1
}

# ─── LiteLLM API 호출 헬퍼 ────────────────────────────────────────────────────
litellm_get() {
  local path="$1"
  curl -s -k -H "Authorization: Bearer $VK" "${GATEWAY_URL}${path}"
}

# ─── 포맷팅 헬퍼 ──────────────────────────────────────────────────────────────
format_cost() {
  python3 -c "
v = $1
if v >= 1: print(f'\${v:,.2f}')
elif v >= 0.01: print(f'\${v:.4f}')
elif v > 0: print(f'\${v:.6f}')
else: print('\$0.00')
"
}

format_tokens() {
  python3 -c "
v = int($1)
if v >= 1_000_000: print(f'{v/1_000_000:.1f}M')
elif v >= 1_000: print(f'{v/1_000:.1f}K')
else: print(f'{v}')
"
}

print_separator() {
  local width=${1:-70}
  printf "${DIM}"
  printf '%.0s─' $(seq 1 $width)
  printf "${RESET}\n"
}

print_header() {
  local title="$1"
  echo ""
  echo -e "${BOLD}${CYAN}  ╭─────────────────────────────────────────────────────────────────╮${RESET}"
  printf "${BOLD}${CYAN}  │${RESET}${BOLD}${WHITE}  %-63s${RESET}${BOLD}${CYAN}│${RESET}\n" "$title"
  echo -e "${BOLD}${CYAN}  ╰─────────────────────────────────────────────────────────────────╯${RESET}"
}

print_section() {
  echo ""
  echo -e "  ${BOLD}${BLUE}▸ $1${RESET}"
  print_separator 70
}

# ─── 메인 ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${DIM}  Virtual Key 가져오는 중...${RESET}"
VK=$(get_virtual_key)

if [[ -z "$GATEWAY_URL" ]]; then
  echo -e "${RED}ERROR: GATEWAY_URL 환경변수를 설정하세요 (예: https://your-alb-domain.com)${RESET}" >&2
  exit 1
fi

# ─── 1. 사용자 정보 ────────────────────────────────────────────────────────────
echo -e "${DIM}  사용자 정보 조회 중...${RESET}"
USER_INFO=$(litellm_get "/user/info")
KEY_INFO=$(litellm_get "/key/info")

USER_ID=$(echo "$USER_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user_id','unknown'))" 2>/dev/null)
USER_SPEND=$(echo "$USER_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); i=d.get('user_info',{}); print(i.get('spend',0) if i else 0)" 2>/dev/null)
USER_BUDGET=$(echo "$USER_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); i=d.get('user_info',{}); print(i.get('max_budget','unlimited') if i else 'unlimited')" 2>/dev/null)
BUDGET_DURATION=$(echo "$USER_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); i=d.get('user_info',{}); print(i.get('budget_duration','N/A') if i else 'N/A')" 2>/dev/null)
BUDGET_RESET=$(echo "$USER_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); i=d.get('user_info',{}); r=i.get('budget_reset_at','') if i else ''; print(r[:10] if r else 'N/A')" 2>/dev/null)
KEY_SPEND=$(echo "$KEY_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('info',{}).get('spend',0))" 2>/dev/null)
KEY_ALIAS=$(echo "$KEY_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('info',{}).get('key_alias','N/A'))" 2>/dev/null)

# ─── 헤더 출력 ────────────────────────────────────────────────────────────────
print_header "Claude Code Usage Dashboard"

echo ""
echo -e "  ${DIM}사용자:${RESET} ${BOLD}${WHITE}${USER_ID}${RESET}    ${DIM}키:${RESET} ${KEY_ALIAS}    ${DIM}조회기간:${RESET} ${START_DATE} ~ ${END_DATE}"

# ─── 2. 비용 요약 ─────────────────────────────────────────────────────────────
print_section "비용 요약 (Cost Summary)"

SPEND_FORMATTED=$(format_cost "${USER_SPEND:-0}")
KEY_SPEND_FORMATTED=$(format_cost "${KEY_SPEND:-0}")

if [[ "$USER_BUDGET" != "unlimited" && "$USER_BUDGET" != "None" && "$USER_BUDGET" != "null" ]]; then
  BUDGET_FORMATTED=$(format_cost "$USER_BUDGET")
  PCT=$(python3 -c "print(f'{float(${USER_SPEND:-0})/float(${USER_BUDGET})*100:.1f}')" 2>/dev/null || echo "0")

  # 프로그레스 바
  BAR_WIDTH=40
  FILLED=$(python3 -c "print(int(min(float($PCT)/100*$BAR_WIDTH, $BAR_WIDTH)))")
  EMPTY=$((BAR_WIDTH - FILLED))

  if (( $(echo "$PCT > 90" | bc -l 2>/dev/null || echo 0) )); then BAR_COLOR=$RED
  elif (( $(echo "$PCT > 70" | bc -l 2>/dev/null || echo 0) )); then BAR_COLOR=$YELLOW
  else BAR_COLOR=$GREEN; fi

  echo ""
  printf "  ${DIM}총 사용량:${RESET}  ${BOLD}${WHITE}%-12s${RESET}" "$SPEND_FORMATTED"
  printf "  ${DIM}예산:${RESET} %-12s" "$BUDGET_FORMATTED"
  printf "  ${DIM}리셋:${RESET} %s (%s)\n" "$BUDGET_RESET" "$BUDGET_DURATION"
  echo ""
  printf "  ${BAR_COLOR}"
  printf '█%.0s' $(seq 1 $FILLED) 2>/dev/null
  printf "${DIM}"
  printf '░%.0s' $(seq 1 $EMPTY) 2>/dev/null
  printf "${RESET}  ${BAR_COLOR}${PCT}%%${RESET}\n"
else
  echo ""
  printf "  ${DIM}총 사용량:${RESET}  ${BOLD}${WHITE}%-12s${RESET}" "$SPEND_FORMATTED"
  printf "  ${DIM}예산:${RESET} unlimited\n"
fi

echo ""
printf "  ${DIM}현재 키 사용량:${RESET} %s\n" "$KEY_SPEND_FORMATTED"

# ─── 3. 일별 활동 + 모델별 비용 ────────────────────────────────────────────────
print_section "사용량 상세 (Usage Details: ${START_DATE} ~ ${END_DATE})"

echo -e "${DIM}  데이터 조회 중...${RESET}"
DAILY=$(litellm_get "/user/daily/activity?start_date=${START_DATE}&end_date=${END_DATE}&page_size=100")

echo "$DAILY" | python3 -c "
import sys, json

data = json.load(sys.stdin)
results = data.get('results', [])
metadata = data.get('metadata', {})

if not results:
    print('  데이터 없음')
    sys.exit(0)

# 메타데이터 요약
total_spend = metadata.get('total_spend', 0)
total_prompt = metadata.get('total_prompt_tokens', 0)
total_completion = metadata.get('total_completion_tokens', 0)
total_tokens = metadata.get('total_tokens', 0)
total_requests = metadata.get('total_api_requests', 0)
total_success = metadata.get('total_successful_requests', 0)
total_failed = metadata.get('total_failed_requests', 0)
total_cache_read = metadata.get('total_cache_read_input_tokens', 0)
total_cache_create = metadata.get('total_cache_creation_input_tokens', 0)

def fmt_tokens(v):
    v = v or 0
    if v >= 1_000_000: return f'{v/1_000_000:.1f}M'
    elif v >= 1_000: return f'{v/1_000:.1f}K'
    return str(int(v))

def fmt_cost(v):
    v = v or 0
    if v >= 1: return f'\${v:,.2f}'
    elif v >= 0.01: return f'\${v:.4f}'
    elif v > 0: return f'\${v:.6f}'
    return '\$0.00'

# 기간 요약 박스
print()
print(f'  \033[1m\033[97m기간 합계\033[0m')
print(f'  ┌──────────────────┬──────────────────┬──────────────────┐')
print(f'  │ \033[36m총 비용\033[0m           │ \033[36m총 요청\033[0m           │ \033[36m성공/실패\033[0m         │')
print(f'  │ \033[1m{fmt_cost(total_spend):<17s}\033[0m│ \033[1m{total_requests:<17,d}\033[0m│ \033[32m{total_success:,}\033[0m / \033[31m{total_failed:,}\033[0m     │')
print(f'  ├──────────────────┼──────────────────┼──────────────────┤')
print(f'  │ \033[36m프롬프트 토큰\033[0m     │ \033[36m완료 토큰\033[0m         │ \033[36m총 토큰\033[0m           │')
print(f'  │ \033[1m{fmt_tokens(total_prompt):<17s}\033[0m│ \033[1m{fmt_tokens(total_completion):<17s}\033[0m│ \033[1m{fmt_tokens(total_tokens):<17s}\033[0m│')
print(f'  ├──────────────────┼──────────────────┼──────────────────┤')
print(f'  │ \033[36m캐시 읽기\033[0m         │ \033[36m캐시 생성\033[0m         │ \033[36m캐시 절약율\033[0m       │')
cache_save = (total_cache_read / total_prompt * 100) if total_prompt > 0 else 0
print(f'  │ \033[1m{fmt_tokens(total_cache_read):<17s}\033[0m│ \033[1m{fmt_tokens(total_cache_create):<17s}\033[0m│ \033[1m\033[33m{cache_save:.1f}%\033[0m            │')
print(f'  └──────────────────┴──────────────────┴──────────────────┘')

# 모델별 비용 (breakdown에서 추출)
model_totals = {}
for row in results:
    breakdown = row.get('breakdown', {})
    models = breakdown.get('models', {})
    for model_name, model_data in models.items():
        if not model_name.strip():
            continue
        m = model_data.get('metrics', {})
        if model_name not in model_totals:
            model_totals[model_name] = {'spend': 0, 'prompt_tokens': 0, 'completion_tokens': 0, 'requests': 0, 'cache_read': 0}
        model_totals[model_name]['spend'] += m.get('spend', 0) or 0
        model_totals[model_name]['prompt_tokens'] += m.get('prompt_tokens', 0) or 0
        model_totals[model_name]['completion_tokens'] += m.get('completion_tokens', 0) or 0
        model_totals[model_name]['requests'] += m.get('api_requests', 0) or 0
        model_totals[model_name]['cache_read'] += m.get('cache_read_input_tokens', 0) or 0

if model_totals:
    print()
    print(f'  \033[1m\033[97m모델별 비용\033[0m')
    print(f'  \033[2m{\"모델\":<35s} {\"비용\":>10s} {\"요청\":>7s} {\"입력토큰\":>10s} {\"출력토큰\":>10s} {\"캐시읽기\":>10s}\033[0m')
    print(f'  ' + '─' * 88)
    for model_name, totals in sorted(model_totals.items(), key=lambda x: -x[1]['spend']):
        short = model_name.replace('global.anthropic.', '').replace('bedrock/', '')[:33]
        spend = totals['spend']
        if spend > 1: color = '\033[33m'
        else: color = '\033[32m'
        print(f'  {short:<35s} {color}{fmt_cost(spend):>10s}\033[0m {totals[\"requests\"]:>7,d} {fmt_tokens(totals[\"prompt_tokens\"]):>10s} {fmt_tokens(totals[\"completion_tokens\"]):>10s} {fmt_tokens(totals[\"cache_read\"]):>10s}')

# 일별 테이블
print()
print(f'  \033[1m\033[97m일별 사용량\033[0m')
print(f'  \033[2m{\"날짜\":<12s} {\"비용\":>10s} {\"요청\":>8s} {\"입력토큰\":>10s} {\"출력토큰\":>10s} {\"캐시읽기\":>10s}\033[0m')
print(f'  ' + '─' * 70)

for row in sorted(results, key=lambda x: str(x.get('date','')), reverse=True):
    date = str(row.get('date',''))[:10]
    m = row.get('metrics', {})
    spend = m.get('spend', 0) or 0
    reqs = m.get('api_requests', 0) or 0
    prompt_t = m.get('prompt_tokens', 0) or 0
    comp_t = m.get('completion_tokens', 0) or 0
    cache_r = m.get('cache_read_input_tokens', 0) or 0

    if spend > 5: color = '\033[31m'
    elif spend > 1: color = '\033[33m'
    else: color = '\033[32m'

    print(f'  {date:<12s} {color}{fmt_cost(spend):>10s}\033[0m {reqs:>8,d} {fmt_tokens(prompt_t):>10s} {fmt_tokens(comp_t):>10s} {fmt_tokens(cache_r):>10s}')
" 2>/dev/null || echo -e "  ${DIM}일별 활동 데이터를 가져올 수 없습니다${RESET}"

# ─── 7. 상세 로그 (옵션) ──────────────────────────────────────────────────────
if $SHOW_DETAIL; then
  print_section "최근 요청 상세 로그 (Recent Requests)"

  LOGS=$(litellm_get "/spend/logs/v2?start_date=${START_DATE}&end_date=${END_DATE}&page_size=30&sort_by=startTime&sort_order=desc")

  echo "$LOGS" | python3 -c "
import sys, json

data = json.load(sys.stdin)
rows = data.get('data', [])
total = data.get('total', 0)
total_pages = data.get('total_pages', 0)

if not rows:
    print('  로그 없음')
    sys.exit(0)

def fmt_cost(v):
    if v >= 0.01: return f'\${v:.4f}'
    elif v > 0: return f'\${v:.6f}'
    return '\$0.00'

def fmt_tokens(v):
    if v >= 1_000_000: return f'{v/1_000_000:.1f}M'
    elif v >= 1_000: return f'{v/1_000:.1f}K'
    return str(v)

print(f'  \033[2m총 {total:,}건 중 최근 30건 (페이지 1/{total_pages})\033[0m')
print()
print(f'  \033[2m{\"시간\":<20s} {\"모델\":<28s} {\"비용\":>9s} {\"입력\":>8s} {\"출력\":>8s} {\"지연\":>7s} {\"상태\":>4s}\033[0m')
print(f'  ' + '─' * 90)

for row in rows:
    ts = str(row.get('startTime', ''))[:19].replace('T', ' ')
    model = str(row.get('model', '')).replace('global.anthropic.', '').replace('bedrock/', '')[:26]
    spend = row.get('spend', 0) or 0
    prompt = row.get('prompt_tokens', 0) or 0
    comp = row.get('completion_tokens', 0) or 0
    duration = row.get('request_duration_ms', 0) or 0
    status = row.get('status', '')
    cache = row.get('cache_hit', '')

    if spend > 0.1: color = '\033[31m'
    elif spend > 0.01: color = '\033[33m'
    else: color = '\033[32m'

    status_icon = '\033[32m✓\033[0m' if status == 'success' else '\033[31m✗\033[0m'
    cache_icon = ' \033[36m⚡\033[0m' if cache == 'True' else ''

    dur_str = f'{duration/1000:.1f}s' if duration >= 1000 else f'{duration}ms'
    print(f'  {ts:<20s} {model:<28s} {color}{fmt_cost(spend):>9s}\033[0m {fmt_tokens(prompt):>8s} {fmt_tokens(comp):>8s} {dur_str:>7s} {status_icon}{cache_icon}')
" 2>/dev/null || echo -e "  ${DIM}상세 로그를 가져올 수 없습니다${RESET}"
fi

# ─── 푸터 ─────────────────────────────────────────────────────────────────────
echo ""
print_separator 70
echo -e "  ${DIM}조회 시각: $(date -u +"%Y-%m-%d %H:%M:%S UTC")${RESET}"
if ! $SHOW_DETAIL; then
  echo -e "  ${DIM}Tip: --detail 옵션으로 개별 요청 로그를 볼 수 있습니다${RESET}"
fi
echo -e "  ${DIM}Tip: --days 7 또는 --month 로 조회 기간을 변경할 수 있습니다${RESET}"
echo ""
