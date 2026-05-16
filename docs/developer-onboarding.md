<div align="center">

# Claude Code on Bedrock

### Enterprise Developer Guide

**AI-Powered Coding Assistant for Your Team**

Amazon Bedrock | IAM Identity Center | LiteLLM Gateway

---

</div>

## Getting Started

Claude Code는 터미널과 VSCode에서 동작하는 AI 코딩 어시스턴트입니다.
사내 LLM Gateway를 통해 Amazon Bedrock의 Claude 모델을 안전하게 사용합니다.

```
개발자 PC  ──>  LLM Gateway (ALB)  ──>  Amazon Bedrock
   │                                        │
   └── SSO 인증 ── Token Service ───────────┘
```

> 설정은 약 **10분**이면 완료됩니다. 아래 순서를 따라 진행하세요.

---

## STEP 1 &nbsp;&nbsp;|&nbsp;&nbsp; 필수 도구 설치

<table>
<tr>
<th>도구</th>
<th>macOS</th>
<th>Linux</th>
</tr>
<tr>
<td><b>AWS CLI v2</b></td>
<td><code>brew install awscli</code></td>
<td><a href="https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html">AWS 공식 가이드</a></td>
</tr>
<tr>
<td><b>Node.js 18+</b></td>
<td><code>brew install node</code></td>
<td><a href="https://nodejs.org/">nodejs.org</a></td>
</tr>
<tr>
<td><b>Claude Code</b></td>
<td colspan="2"><code>npm install -g @anthropic-ai/claude-code</code></td>
</tr>
</table>

```bash
# 설치 확인
aws --version      # 2.x.x 이상
node --version     # v18 이상
claude --version
```

---

## STEP 2 &nbsp;&nbsp;|&nbsp;&nbsp; AWS SSO 프로필 설정

`~/.aws/config` 파일에 아래 내용을 추가합니다:

```ini
[profile claude-code]
sso_start_url = https://{IDC_ID}.awsapps.com/start
sso_region = ap-northeast-2
sso_account_id = {ACCOUNT_ID}
sso_role_name = ClaudeCodeUser
region = ap-northeast-2
output = json
```

> `sso_role_name`은 관리자가 안내한 Permission Set 이름을 사용하세요.
> 모든 개발자가 동일한 프로필명(`claude-code`)을 사용합니다.

---

## STEP 3 &nbsp;&nbsp;|&nbsp;&nbsp; SSO 로그인

```bash
aws sso login --profile claude-code
```

브라우저가 열리면 **본인의 IAM Identity Center 계정**으로 로그인합니다.

```bash
# 로그인 확인
aws sts get-caller-identity --profile claude-code
```

Account가 `{ACCOUNT_ID}`이고, ARN 끝에 본인 이름이 나오면 성공입니다.

---

## STEP 4 &nbsp;&nbsp;|&nbsp;&nbsp; 파일 준비

관리자에게 아래 두 파일을 전달받아 로컬 PC에 저장합니다:

| 파일 | 용도 |
|:-----|:-----|
| **`server.crt`** | Gateway HTTPS 통신용 인증서 |
| **`get-gateway-token.sh`** | 토큰 자동 발급 스크립트 |

```bash
# 스크립트에 실행 권한 부여
chmod +x /저장한/경로/get-gateway-token.sh
```

```bash
# 토큰 발급 테스트
export AWS_PROFILE=claude-code
bash /저장한/경로/get-gateway-token.sh

# sk-XXXXXXXX 형태가 출력되면 성공!
```

---

## STEP 5 &nbsp;&nbsp;|&nbsp;&nbsp; Claude Code 설정

`~/.claude/settings.json` 파일을 생성(또는 수정)합니다:

```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "ANTHROPIC_BEDROCK_BASE_URL": "https://{ALB_DNS}/bedrock",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH": "1",
    "AWS_REGION": "ap-northeast-2",
    "AWS_PROFILE": "claude-code",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "arn:aws:bedrock:ap-northeast-2:{ACCOUNT_ID}:application-inference-profile/{OPUS_PROFILE_ID}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "arn:aws:bedrock:ap-northeast-2:{ACCOUNT_ID}:application-inference-profile/{SONNET_PROFILE_ID}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "arn:aws:bedrock:ap-northeast-2:{ACCOUNT_ID}:application-inference-profile/{HAIKU_PROFILE_ID}",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "NODE_EXTRA_CA_CERTS": "/본인경로/server.crt"
  },
  "apiKeyHelper": "/본인경로/get-gateway-token.sh"
}
```

> **본인 환경에 맞게 수정이 필요한 항목:**
>
> | 항목 | 예시 |
> |:-----|:-----|
> | `NODE_EXTRA_CA_CERTS` | `/Users/hong/server.crt` |
> | `apiKeyHelper` | `/Users/hong/get-gateway-token.sh` |
>
> **나머지 값은 절대 수정하지 마세요.**

---

## STEP 6 &nbsp;&nbsp;|&nbsp;&nbsp; 실행

```bash
claude
```

<div align="center">

**축하합니다! Claude Code를 사용할 준비가 완료되었습니다.**

</div>

---

## VSCode에서 사용하기

`~/.aws/credentials` 파일에 `[default]` IAM 키가 있으면 SSO 프로필과 충돌합니다.

`get-gateway-token.sh`를 열어서 아래와 같이 수정하세요:

```diff
- eval $(aws configure export-credentials --format env 2>/dev/null) || {
+ eval $(aws configure export-credentials --format env --profile claude-code 2>/dev/null) || {
```

수정 후 VSCode를 **완전히 재시작**(Cmd+Q 후 다시 열기)하세요.

---

## 자주 묻는 질문

<details>
<summary><b>"Self-signed certificate detected" 에러가 나요</b></summary>

`NODE_EXTRA_CA_CERTS` 경로를 확인하세요. **절대 경로**를 사용해야 합니다.

```bash
ls -la /본인경로/server.crt    # 파일 존재 확인
```

</details>

<details>
<summary><b>"security token is invalid" 에러가 나요</b></summary>

SSO 세션이 만료된 것입니다. 다시 로그인하세요:

```bash
aws sso login --profile claude-code
```

</details>

<details>
<summary><b>"is not authorized to access this resource" 에러가 나요</b></summary>

다른 AWS 자격증명이 충돌하고 있습니다:

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
```

</details>

<details>
<summary><b>다른 SSO 계정으로 전환하고 싶어요</b></summary>

```bash
aws sso logout
```

브라우저에서 https://{IDC_ID}.awsapps.com/start 도 로그아웃한 후 다시 `aws sso login`을 실행하세요.

</details>

<details>
<summary><b>Gateway가 응답하지 않아요</b></summary>

```bash
curl -k https://{ALB_DNS}/health/liveliness
```

"I'm alive!"가 나오면 Gateway는 정상입니다. 다른 원인을 확인하세요.
응답이 없으면 관리자에게 문의하세요.

</details>

---

<div align="center">

**문의**: 관리자에게 Slack 또는 이메일로 연락하세요.

</div>
