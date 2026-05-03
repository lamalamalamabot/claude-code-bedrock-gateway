# 사용자 온보딩 가이드

이 문서는 관리자의 사용자 등록 작업과 개발자의 Claude Code 초기 설정 과정을 다룹니다.

---

## 1. 관리자 작업

관리자가 해야 할 일은 **IAM Identity Center에서 사용자를 생성하고 그룹에 할당하는 것**이 전부입니다.

Virtual Key(LLM Gateway 인증 토큰)는 개발자가 처음 SSO 로그인할 때 Token Service에 의해 자동 생성됩니다. LiteLLM Admin UI에서 키를 수동 발급하거나 DynamoDB에 직접 등록할 필요가 없습니다.

### 1.1 사용자 생성

1. AWS Management Console에서 **IAM Identity Center** 이동
2. **Users** > **Add user** 클릭
3. 사용자 정보 입력

| 필드 | 설명 |
|------|------|
| Username | 고유 사용자명 (Token Service에서 이 값으로 Virtual Key를 생성) |
| Email address | 초대 메일을 수신할 이메일 |
| First name / Last name | 성명 |

4. 사용자 생성 완료 후, 등록된 이메일로 초대 메일이 발송됩니다. 사용자는 메일의 링크를 통해 비밀번호를 설정합니다.

### 1.2 그룹 할당

1. IAM Identity Center > **Groups** 이동
2. 해당 그룹 선택 (예: `Engineering-Backend`)
3. **Add users** 클릭 후 신규 사용자 추가

그룹에는 이미 Permission Set(`ClaudeCodeUser`)이 AWS 계정에 할당되어 있으므로, 그룹에 사용자를 추가하는 것만으로 해당 Permission Set의 권한이 자동 적용됩니다.

### 1.3 관리자 작업 완료 후 개발자에게 전달할 정보

| 항목 | 값 |
|------|-----|
| AWS Access Portal URL | IAM Identity Center Settings에서 확인 (예: `https://d-xxxxxxxxxx.awsapps.com/start`) |
| SSO 계정 ID | Claude Code 전용 AWS 계정 ID |
| Permission Set 이름 | `ClaudeCodeUser` |
| ALB DNS Name | CloudFormation Outputs에서 확인 |
| get-gateway-token.sh 경로 | `scripts/get-gateway-token.sh` |
| 자체서명 인증서 파일 | 자체서명 인증서 사용 시 `certificate.pem` 배포 |

---

## 2. 개발자 작업

### 2.1 AWS CLI SSO 프로필 설정

`~/.aws/config` 파일에 다음 내용을 추가합니다. 플레이스홀더를 관리자에게 받은 실제 값으로 교체합니다.

```ini
[profile claude-code]
sso_session = my-sso
sso_account_id = {SSO_ACCOUNT_ID}
sso_role_name = ClaudeCodeUser
region = us-east-1
output = json

[sso-session my-sso]
sso_start_url = {SSO_START_URL}
sso_region = us-east-1
sso_registration_scopes = sso:account:access
```

프로덕션 환경에서는 모든 개발자가 동일한 프로필(`claude-code`)을 사용합니다. 사용자 구분은 프로필이 아닌, 브라우저에서 SSO 로그인 시 각자의 계정으로 수행됩니다.

### 2.2 SSO 로그인

```bash
export AWS_PROFILE=claude-code
aws sso login
```

브라우저가 열리면 IAM Identity Center 계정(관리자가 생성한 사용자명/비밀번호)으로 로그인합니다.

로그인 성공 후 자격증명을 확인합니다.

```bash
aws sts get-caller-identity
```

정상 응답 예시:

```json
{
  "UserId": "AROAXXXXXXXXX:alice",
  "Account": "123456789012",
  "Arn": "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_ClaudeCodeUser_abc123/alice"
}
```

### 2.3 Claude Code settings.json 설정

`~/.claude/settings.json` 파일을 생성하거나 수정합니다.

```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "ANTHROPIC_BEDROCK_BASE_URL": "https://{ALB_DNS_NAME}/bedrock",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH": "1",
    "AWS_REGION": "us-east-1",
    "AWS_PROFILE": "claude-code",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "us.anthropic.claude-opus-4-6-v1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "us.anthropic.claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
  },
  "apiKeyHelper": "{GET_GATEWAY_TOKEN_SCRIPT_PATH}"
}
```

**각 항목 설명:**

| 키 | 값 | 설명 |
|----|-----|------|
| `CLAUDE_CODE_USE_BEDROCK` | `1` | Bedrock 통합 모드 활성화 |
| `ANTHROPIC_BEDROCK_BASE_URL` | `https://{ALB}/bedrock` | LLM Gateway의 Bedrock pass-through 엔드포인트. `{ALB}`을 실제 ALB DNS Name으로 교체 |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | `1` | Claude Code가 SigV4 서명을 생략 (Gateway가 Bedrock 인증을 처리) |
| `AWS_REGION` | `us-east-1` | AWS 리전. Claude Code는 `~/.aws/config`에서 리전을 읽지 않으므로 필수 |
| `AWS_PROFILE` | `claude-code` | apiKeyHelper가 이 프로필의 SSO 자격증명을 사용 |
| `ANTHROPIC_DEFAULT_*_MODEL` | 모델 ID | 모델 버전을 고정. 미지정 시 Bedrock에 아직 없는 최신 모델을 시도하여 장애 발생 가능 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` | beta 헤더/필드를 제거하여 Gateway 호환성 확보 |
| `apiKeyHelper` | 스크립트 경로 | `get-gateway-token.sh`의 절대 경로 또는 `~`로 시작하는 경로 |

**자체서명 인증서 사용 시 추가 설정:**

ALB에 자체서명 인증서를 사용하는 경우, `env`에 다음을 추가합니다.

```json
"NODE_EXTRA_CA_CERTS": "/path/to/certificate.pem"
```

이 설정이 없으면 Claude Code가 TLS 인증서 검증에 실패하여 Gateway에 연결할 수 없습니다.

### 2.4 Claude Code 실행

```bash
claude
```

Claude Code가 실행되면 내부적으로 다음이 자동 수행됩니다.

1. `apiKeyHelper` (`get-gateway-token.sh`)가 호출됨
2. 스크립트가 `AWS_PROFILE=claude-code`의 SSO 자격증명으로 API Gateway에 SigV4 서명 요청을 전송
3. Token Service(Lambda)가 SSO ARN에서 username을 추출
4. DynamoDB 캐시에서 Virtual Key를 조회하거나, 첫 로그인이면 LiteLLM API로 자동 생성
5. 반환된 Virtual Key로 LLM Gateway(ALB -> LiteLLM -> Bedrock) 호출

---

## 3. 첫 로그인 시 Virtual Key 자동 생성

개발자가 처음 Claude Code를 실행하면 Token Service가 다음을 수행합니다.

1. API Gateway IAM Auth가 SigV4 서명을 검증
2. `requestContext.identity.userArn`에서 SSO ARN을 추출
   - 예: `arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_ClaudeCodeUser_abc123/alice`
3. ARN에서 username(`alice`)을 파싱
4. DynamoDB `llm-gateway-config` 테이블에서 `USER#alice` / `VIRTUAL_KEY` 항목을 조회
5. 캐시에 없으므로 LiteLLM `/key/generate` API를 호출하여 Virtual Key를 자동 생성
   - `key_alias`: `sso-alice`
   - `user_id`: `alice`
6. 생성된 Virtual Key를 DynamoDB에 캐싱
7. Virtual Key를 Claude Code에 반환

이후 로그인 시에는 DynamoDB 캐시에서 즉시 반환되므로 지연이 최소화됩니다.

---

## 4. SSO 세션 만료 시 대처법

IAM Identity Center의 SSO 세션은 Permission Set에서 설정한 시간(기본 8시간) 후 만료됩니다.

### 4.1 증상

Claude Code에서 다음과 같은 오류가 발생합니다.

```
ERROR: aws sso login 을 실행하세요
```

또는

```
CredentialsExpired
```

### 4.2 해결

```bash
export AWS_PROFILE=claude-code
aws sso login
```

브라우저에서 다시 SSO 로그인을 완료한 후 Claude Code를 재실행합니다.

### 4.3 자동 갱신 설정 (선택)

`~/.claude/settings.json`에 `awsAuthRefresh`를 추가하면, SSO 세션 만료 시 자동으로 재인증을 시도합니다.

```json
{
  "awsAuthRefresh": "aws sso login",
  "env": {
    "AWS_PROFILE": "claude-code"
  }
}
```

apiKeyHelper의 갱신 주기도 설정할 수 있습니다.

```json
{
  "env": {
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS": "3600000"
  }
}
```

이 설정은 1시간(3,600,000ms)마다 apiKeyHelper를 재호출하여 Virtual Key를 갱신합니다.

---

## 5. 트러블슈팅

### 5.1 "ERROR: aws sso login 을 실행하세요"

**원인**: SSO 로그인이 되어 있지 않거나 세션이 만료됨

**해결**:
```bash
export AWS_PROFILE=claude-code
aws sso login
aws sts get-caller-identity  # 로그인 확인
```

### 5.2 "Token Service에서 키를 받지 못했습니다"

**원인**: Token Service Lambda 호출은 성공했으나 Virtual Key 생성에 실패

**확인 사항**:
- LiteLLM ECS 서비스가 정상 구동 중인지 확인 (`curl -k https://{ALB}/health/liveliness`)
- Lambda -> ALB 네트워크 연결 확인 (Lambda는 VPC 내 Private Subnet에서 실행)
- Secrets Manager에서 LiteLLM Master Key가 정상적으로 조회되는지 확인

### 5.3 Claude Code 실행 시 TLS 인증서 오류

**원인**: 자체서명 인증서 사용 시 `NODE_EXTRA_CA_CERTS`가 설정되지 않음

**해결**: `~/.claude/settings.json`의 `env`에 추가
```json
"NODE_EXTRA_CA_CERTS": "/path/to/certificate.pem"
```

### 5.4 "403 Forbidden" (API Gateway)

**원인**: IAM 권한 부족. 사용자에게 `execute-api:Invoke` 권한이 없음

**확인 사항**:
- IAM Identity Center에서 사용자가 올바른 그룹에 할당되어 있는지 확인
- 그룹에 `ClaudeCodeUser` Permission Set이 AWS 계정에 할당되어 있는지 확인
- Permission Set에 `execute-api:Invoke` 권한이 포함되어 있는지 확인

### 5.5 "429 Too Many Requests"

**원인**: LiteLLM에서 설정한 예산 한도 초과

**해결**:
- LiteLLM Admin UI에서 해당 사용자의 Virtual Key 예산 확인
- 예산 증액이 필요하면 관리자에게 요청

### 5.6 모델 호출 시 "AccessDeniedException"

**원인**: Bedrock 모델 접근이 승인되지 않음

**확인 사항**:
- Bedrock 콘솔에서 해당 모델의 접근 요청이 완료되었는지 확인
- ECS Task Role에 Bedrock InvokeModel 권한이 있는지 확인

### 5.7 apiKeyHelper가 무시됨

**원인**: `ANTHROPIC_AUTH_TOKEN` 또는 `ANTHROPIC_API_KEY` 환경변수가 설정되어 있으면 `apiKeyHelper`보다 우선됨

**해결**: 해당 환경변수가 설정되어 있지 않은지 확인
```bash
echo $ANTHROPIC_AUTH_TOKEN
echo $ANTHROPIC_API_KEY
```

설정되어 있다면 삭제합니다.
```bash
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_API_KEY
```

### 5.8 스트리밍 응답이 도중에 끊김

**원인**: ALB idle timeout보다 응답 시간이 긴 경우

**확인 사항**:
- ALB idle timeout은 300초로 설정되어 있음 (CDK에서 `idleTimeout: cdk.Duration.seconds(300)`)
- 네트워크 경로 상의 다른 프록시/방화벽의 타임아웃 설정 확인
