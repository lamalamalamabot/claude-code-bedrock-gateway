# 배포 가이드

이 문서는 Claude Code Enterprise Gateway를 AWS 환경에 배포하는 전체 과정을 다룹니다.

---

## 1. 사전 요구사항

### 1.1 로컬 도구

| 도구 | 최소 버전 | 설치 확인 |
|------|-----------|-----------|
| AWS CLI | v2 | `aws --version` |
| Node.js | 18 이상 | `node --version` |
| AWS CDK | v2 | `npx cdk --version` |

### 1.2 AWS 계정 사전 설정

- **AWS Organization** + **IAM Identity Center** 활성화
- **IAM Identity Center에서 사용자 및 그룹 생성** (그룹명이 LiteLLM 팀명으로 자동 매핑됨)
- **CDK 배포 권한이 있는 IAM 사용자/역할**

---

## 2. 클론 및 의존성 설치

```bash
git clone https://github.com/lamalamalamabot/claude-code-bedrock-gateway.git
cd claude-code-bedrock-gateway
npm install
```

---

## 3. CDK Bootstrap (최초 1회)

```bash
cdk bootstrap aws://{ACCOUNT_ID}/ap-northeast-2
```

---

## 4. 임시 인증서 생성 + ACM 임포트

배포 시 ALB HTTPS Listener에 인증서가 필요합니다. ALB DNS는 배포 후에 확정되므로, 우선 임시 인증서로 배포합니다.

```bash
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout server.key -out server.crt \
  -subj "/CN=llm-gateway.internal"

aws acm import-certificate \
  --certificate fileb://server.crt \
  --private-key fileb://server.key \
  --region ap-northeast-2
```

출력된 `CertificateArn`을 메모합니다.

---

## 5. Identity Store ID 확인

```bash
aws sso-admin list-instances --query "Instances[0].IdentityStoreId" --output text
```

---

## 6. CDK 배포

```bash
cdk deploy LlmGatewayStack \
  -c certificateArn={4단계에서 메모한 ARN} \
  -c identityStoreId={5단계에서 확인한 ID}
```

배포는 약 15~25분 소요됩니다.

---

## 7. 배포 후 설정

### 7.1 ALB DNS 및 API Gateway ID 확인

```bash
# ALB DNS
aws elbv2 describe-load-balancers \
  --names claude-code-enterprise-alb \
  --query "LoadBalancers[0].DNSName" --output text

# API Gateway ID
aws apigateway get-rest-apis \
  --query "items[?name=='claude-code-enterprise-token-service'].id" --output text
```

### 7.2 ALB Security Group에 IP 추가

CDK 기본값은 `1.2.3.4/32` 플레이스홀더입니다. 실제 IP로 교체합니다.

```bash
# ALB SG ID 확인
ALB_SG=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=claude-code-enterprise-alb-sg" \
  --query "SecurityGroups[0].GroupId" --output text)

# 플레이스홀더 제거
aws ec2 revoke-security-group-ingress \
  --group-id $ALB_SG --protocol tcp --port 443 --cidr 1.2.3.4/32
aws ec2 revoke-security-group-ingress \
  --group-id $ALB_SG --protocol tcp --port 80 --cidr 1.2.3.4/32

# 개발자 접속 IP 추가
aws ec2 authorize-security-group-ingress \
  --group-id $ALB_SG --protocol tcp --port 443 --cidr {개발자IP}/32
aws ec2 authorize-security-group-ingress \
  --group-id $ALB_SG --protocol tcp --port 80 --cidr {개발자IP}/32

# NAT Gateway IP 추가 (Lambda → ALB 통신용, 신규 사용자 첫 인증 시 필요)
NAT_IP=$(aws ec2 describe-nat-gateways \
  --filter "Name=state,Values=available" \
  --query "NatGateways[0].NatGatewayAddresses[0].PublicIp" --output text)
aws ec2 authorize-security-group-ingress \
  --group-id $ALB_SG --protocol tcp --port 443 --cidr ${NAT_IP}/32
```

### 7.3 인증서 재생성 (ALB DNS를 SAN에 포함)

임시 인증서를 실제 ALB DNS가 포함된 인증서로 교체합니다.

```bash
# ALB DNS 확인 (7.1에서 이미 확인한 값)
ALB_DNS=$(aws elbv2 describe-load-balancers \
  --names claude-code-enterprise-alb \
  --query "LoadBalancers[0].DNSName" --output text)

# 인증서 재생성 (CN은 64자 제한이 있으므로 짧게, ALB DNS는 SAN에)
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout server.key -out server.crt \
  -subj "/CN=llm-gateway.internal" \
  -addext "subjectAltName=DNS:${ALB_DNS}"

# 기존 인증서에 덮어쓰기 (재배포 불필요, ALB에 자동 반영)
aws acm import-certificate \
  --certificate-arn {4단계에서 메모한 ARN} \
  --certificate fileb://server.crt \
  --private-key fileb://server.key \
  --region ap-northeast-2
```

> `server.crt`는 개발자에게 배포할 파일이므로 안전한 곳에 보관하세요.

### 7.4 get-gateway-token.sh 업데이트

`scripts/get-gateway-token.sh`의 `{API_GW_ID}`를 실제 값으로 교체합니다.

```bash
sed -i "s/{API_GW_ID}/{7.1에서 확인한 API Gateway ID}/" scripts/get-gateway-token.sh
```

### 7.5 Permission Set 생성

IAM Identity Center에서 `ClaudeCodeUser` Permission Set을 생성하고 인라인 정책을 추가합니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeTokenService",
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:ap-northeast-2:*:*/v1/POST/auth/token"
    }
  ]
}
```

사용자/그룹에 이 Permission Set을 할당합니다.

---

## 8. 동작 확인

### 8.1 Gateway 헬스체크

```bash
curl -k https://${ALB_DNS}/health/liveliness
# "I'm alive!" 가 나오면 정상
```

### 8.2 토큰 발급 테스트

```bash
export AWS_PROFILE=claude-code
bash scripts/get-gateway-token.sh
# sk-... 형태가 출력되면 정상
```

### 8.3 모델 호출 테스트

```bash
TOKEN=$(bash scripts/get-gateway-token.sh)
curl -k https://${ALB_DNS}/bedrock/model/global.anthropic.claude-sonnet-4-6/invoke \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"anthropic_version":"bedrock-2023-05-31","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

### 8.4 LiteLLM Admin UI 접속

```
https://{ALB_DNS}/ui/
```

- **Username**: 아무 값 (예: `admin`)
- **Password**: LiteLLM Master Key

```bash
aws secretsmanager get-secret-value \
  --secret-id claude-code-enterprise/litellm-master-key \
  --region ap-northeast-2 \
  --query SecretString --output text
```

---

## 9. 개발자 온보딩

### 9.1 developer-onboarding.md 업데이트

`docs/developer-onboarding.md`의 플레이스홀더를 실제 값으로 교체합니다.

```bash
sed -i "s/{ACCOUNT_ID}/{실제 계정 ID}/g" docs/developer-onboarding.md
sed -i "s/{IDC_ID}/{실제 Identity Store ID}/g" docs/developer-onboarding.md
sed -i "s/{ALB_DNS}/${ALB_DNS}/g" docs/developer-onboarding.md
```

### 9.2 개발자에게 전달할 파일

| 파일 | 용도 |
|:-----|:-----|
| `server.crt` | Gateway HTTPS 통신용 인증서 (7.3에서 재생성한 파일) |
| `get-gateway-token.sh` | 토큰 자동 발급 스크립트 (7.4에서 업데이트한 파일) |
| `developer-onboarding.md` | 개발자 설정 가이드 |

### 9.3 개발자 Claude Code 설정

각 개발자는 `~/.claude/settings.json`을 설정합니다.

```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "ANTHROPIC_BEDROCK_BASE_URL": "https://{ALB_DNS}/bedrock",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH": "1",
    "AWS_REGION": "ap-northeast-2",
    "AWS_PROFILE": "claude-code",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "global.anthropic.claude-opus-4-6-v1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "global.anthropic.claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "NODE_EXTRA_CA_CERTS": "/절대경로/server.crt"
  },
  "apiKeyHelper": "/절대경로/get-gateway-token.sh"
}
```

> `NODE_EXTRA_CA_CERTS`는 **7.3에서 재생성한 `server.crt`의 절대 경로**여야 합니다. 이전 임시 인증서를 가리키면 hostname mismatch 에러가 발생합니다.

---

## 10. 문제 해결

### Gateway가 응답하지 않음

```bash
# ECS 서비스 상태 확인
aws ecs describe-services \
  --cluster claude-code-enterprise-cluster \
  --services claude-code-enterprise-litellm \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount}'

# ECS 로그 확인
aws logs tail /ecs/claude-code-enterprise/litellm --since 30m
```

### 토큰 발급 실패 (Internal server error)

```bash
# Lambda 로그 확인
aws logs tail /aws/lambda/claude-code-enterprise-token-service --since 5m --format short
```

흔한 원인:
- ALB SG에 NAT Gateway IP가 없음 (7.2 확인)
- SSO 세션 만료 → `aws sso login --profile claude-code`

### Self-signed certificate detected

- `NODE_EXTRA_CA_CERTS` 경로가 7.3에서 재생성한 `server.crt`를 가리키는지 확인
- **절대 경로**를 사용해야 함

### 스택 배포 실패 (롤백)

```bash
aws cloudformation describe-stack-events \
  --stack-name LlmGatewayStack \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
  --output table
```

흔한 원인:
- `certificateArn` 누락 또는 잘못된 형식 (CN이 FQDN이 아닌 경우)
- CDK Bootstrap 미실행
- 리소스 생성 권한 부족

---

## 11. 프로덕션 전환 시 고려사항

| 항목 | 현재 (개발/테스트) | 프로덕션 권장 |
|:-----|:---:|:---:|
| 인증서 | 자체서명 | ACM 공인 인증서 + Route 53 도메인 |
| ALB SG | 특정 IP만 허용 | 사내 CIDR + WAF 적용 |
| Aurora removalPolicy | DESTROY | RETAIN 또는 SNAPSHOT |
| DynamoDB removalPolicy | DESTROY | RETAIN |
| NAT Gateway | 1개 | 2개 (AZ 이중화) |
| ECS desiredCount | 1 (Auto Scaling 1~10) | minCapacity 2 이상 |
| IdP | IAM Identity Center 내장 | Entra ID 등 외부 IdP (SAML + SCIM) |
