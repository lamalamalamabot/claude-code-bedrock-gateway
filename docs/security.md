# 보안 가이드

이 문서는 Claude Code Enterprise 인프라의 인증 흐름, 네트워크 보안, 시크릿 관리, IAM 권한 설계, 퇴사자 접근 차단 절차를 다룹니다.

---

## 1. 인증 흐름

### 1.1 전체 인증 체인

```
개발자 PC                    AWS Cloud
-----------                  ---------

1. aws sso login
   (브라우저 SSO 로그인)
        |
        v
2. Claude Code 실행
   apiKeyHelper 호출
        |
        v
3. get-gateway-token.sh
   AWS_PROFILE의 SSO 자격증명으로
   SigV4 서명 생성
        |
        +------ POST /v1/auth/token -------> 4. API Gateway (IAM Auth)
                (SigV4 서명 포함)                  SigV4 서명 검증
                                                       |
                                                       v
                                               5. Token Service (Lambda)
                                                  requestContext.identity.userArn에서
                                                  SSO ARN 파싱 -> username 추출
                                                       |
                                                       v
                                               6. DynamoDB 캐시 조회
                                                  [히트] -> Virtual Key 반환
                                                  [미스] -> LiteLLM /key/generate
                                                            -> DynamoDB 캐싱
                                                            -> Virtual Key 반환
        |
        v
7. Claude Code
   Virtual Key를 Bearer Token으로
   LLM 요청에 포함
        |
        +------ Authorization: Bearer sk-xxx ----> 8. ALB (HTTPS/443)
                                                       |
                                                       v
                                                   9. ECS Fargate (LiteLLM)
                                                      Virtual Key 검증
                                                      사용자 식별
                                                      예산 체크
                                                       |
                                                       v
                                                  10. Amazon Bedrock
                                                      (Task Role 인증)
```

### 1.2 인증 단계별 보안 메커니즘

| 단계 | 메커니즘 | 검증 주체 |
|------|----------|-----------|
| SSO 로그인 | IAM Identity Center 인증 (사용자명/비밀번호) | IAM Identity Center |
| API Gateway 호출 | AWS SigV4 서명 | API Gateway IAM Auth |
| Token Service | SSO ARN 패턴 매칭 (`AWSReservedSSO_*` 검증) | Lambda (handler.py) |
| LLM 요청 | LiteLLM Virtual Key (Bearer Token) | LiteLLM Proxy |
| Bedrock 호출 | ECS Task Role (IAM) | Amazon Bedrock |

### 1.3 SSO ARN 파싱 로직

Token Service는 API Gateway의 `requestContext.identity.userArn`에서 사용자를 식별합니다.

ARN 형식:
```
arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_ClaudeCodeUser_abc123/alice
```

파싱 패턴 (`handler.py`에서 사용):
```
^arn:aws:sts::(\d+):assumed-role/AWSReservedSSO_([^_]+)_[^/]+/(.+)$
```

추출 결과:
- `account`: `123456789012`
- `role_name`: `ClaudeCodeUser`
- `username`: `alice`

`AWSReservedSSO_` prefix가 없는 ARN은 SSO가 아닌 일반 IAM 역할이므로 거부합니다. 이를 통해 SSO를 통하지 않은 직접 IAM 자격증명 사용을 방지합니다.

---

## 2. 네트워크 보안

### 2.1 VPC 구성

```
VPC (2 AZ)
+-- Public Subnet (2)
|   +-- ALB
|   +-- NAT Gateway
|
+-- Private Subnet (2)
|   +-- ECS Fargate (LiteLLM)
|   +-- Lambda (Token Service)
|   +-- VPC Endpoints (Bedrock Runtime)
|
+-- Isolated Subnet (2)
    +-- Aurora Serverless v2
```

- **ALB**: Public Subnet에 배치. 인터넷에서 접근 가능 (프로덕션에서는 사내 CIDR로 제한)
- **ECS/Lambda**: Private Subnet에 배치. NAT Gateway를 통해서만 아웃바운드 가능
- **Aurora**: Isolated Subnet에 배치. 인터넷 접근 완전 차단. ECS와 Lambda에서만 접근 가능

### 2.2 Security Group 체인

```
인터넷
  |
  v
ALB SG
  - Inbound: TCP 80, 443 (0.0.0.0/0)
  - Outbound: All
  |
  v (TCP 4000)
ECS SG
  - Inbound: TCP 4000 (ALB SG에서만)
  - Outbound: All
  |
  v (TCP 5432)
RDS SG
  - Inbound: TCP 5432 (ECS SG, Lambda SG에서만)
  - Outbound: None

Lambda SG
  - Inbound: None
  - Outbound: All
  |
  v (TCP 5432)
RDS SG (위와 동일)

VPC Endpoint SG
  - Inbound: TCP 443 (ECS SG에서만)
  - Outbound: None
```

각 Security Group은 필요한 통신만 허용합니다.

- ECS는 ALB로부터의 트래픽만 수신 (포트 4000)
- RDS는 ECS와 Lambda로부터의 트래픽만 수신 (포트 5432)
- VPC Endpoint는 ECS로부터의 HTTPS만 수신 (포트 443)
- Lambda는 인바운드 트래픽 없음 (아웃바운드만)

### 2.3 VPC Endpoints

| 엔드포인트 | 유형 | 용도 |
|-----------|------|------|
| Bedrock Runtime | Interface | ECS -> Bedrock API 호출을 AWS 네트워크 내부로 유지 |
| S3 | Gateway | ECR 이미지 풀, CloudWatch Logs 등 |
| DynamoDB | Gateway | DynamoDB 테이블 접근 |

Bedrock Runtime VPC Endpoint를 통해 LLM 요청이 퍼블릭 인터넷을 경유하지 않습니다. 이는 보안뿐 아니라 지연 시간 측면에서도 유리합니다.

---

## 3. 시크릿 관리

### 3.1 Secrets Manager에 저장된 시크릿

| 시크릿 이름 | 내용 | 사용처 |
|------------|------|--------|
| `claude-code-enterprise/litellm-master-key` | LiteLLM Master Key (32자, 자동 생성) | ECS 컨테이너 (LITELLM_MASTER_KEY), Token Service Lambda |
| `claude-code-enterprise/aurora-credentials` | Aurora DB 사용자명/비밀번호/호스트/포트 | ECS 컨테이너 (DB 연결 정보) |

### 3.2 시크릿 주입 방식

**ECS 컨테이너**: 태스크 정의에서 `ecs.Secret.fromSecretsManager()`로 시크릿을 환경변수로 주입합니다. 컨테이너 시작 시 ECS 에이전트가 Secrets Manager에서 값을 가져와 환경변수로 설정합니다.

```
LITELLM_MASTER_KEY <- Secrets Manager (litellm-master-key)
DB_HOST            <- Secrets Manager (aurora-credentials, host 필드)
DB_PORT            <- Secrets Manager (aurora-credentials, port 필드)
DB_USERNAME        <- Secrets Manager (aurora-credentials, username 필드)
DB_PASSWORD        <- Secrets Manager (aurora-credentials, password 필드)
```

**Token Service Lambda**: `LITELLM_MASTER_KEY_ARN` 환경변수에 시크릿 ARN을 저장하고, 런타임에 `boto3`로 Secrets Manager API를 호출하여 값을 가져옵니다. 한번 조회한 값은 Lambda 인스턴스 수명 동안 메모리에 캐싱합니다.

### 3.3 시크릿 접근 권한

- **ECS Task Execution Role**: Secrets Manager 읽기 권한 (CDK가 자동 부여)
- **Token Service Lambda**: `litellm-master-key` 시크릿에 대한 읽기 권한 (`grantRead`)

시크릿에 접근할 수 있는 IAM 역할이 최소화되어 있습니다.

---

## 4. HTTPS / TLS

### 4.1 현재 구성 (자체서명 인증서)

- ALB에서 HTTPS 종단 (TLS 1.3, `TLS13_RES` 정책)
- HTTP(80) -> HTTPS(443) 자동 리다이렉트
- 자체서명 인증서 사용
- 클라이언트에서 `NODE_EXTRA_CA_CERTS`로 인증서 파일 지정 필요

### 4.2 프로덕션 전환 (공인 인증서)

프로덕션에서는 다음과 같이 전환합니다.

1. **커스텀 도메인 등록**: Route 53에 도메인 등록 (예: `llm-gateway.example.com`)
2. **ACM 인증서 발급**: ACM에서 도메인 검증된 공인 인증서 발급
3. **ALB에 인증서 적용**: CDK 배포 시 `certificateArn`을 공인 인증서 ARN으로 지정
4. **DNS 레코드 설정**: Route 53에서 ALB로의 Alias 레코드 생성
5. **클라이언트 설정 간소화**: `NODE_EXTRA_CA_CERTS` 제거, `ANTHROPIC_BEDROCK_BASE_URL`을 커스텀 도메인으로 변경

### 4.3 ALB -> ECS 구간

ALB와 ECS 태스크 간 통신은 HTTP(4000)를 사용합니다. 이 구간은 VPC 내부 통신이며, Security Group으로 ALB에서만 접근 가능하도록 제한되어 있습니다. 추가 보안이 필요하면 LiteLLM 자체의 TLS를 활성화할 수 있습니다.

### 4.4 ECS -> Bedrock 구간

VPC Endpoint를 통해 AWS 내부 네트워크로 통신합니다. AWS가 자체적으로 TLS를 적용합니다.

---

## 5. IAM 최소 권한 원칙

### 5.1 ECS Task Role

LiteLLM 컨테이너가 사용하는 IAM 역할입니다.

| 권한 | 리소스 | 용도 |
|------|--------|------|
| `bedrock:InvokeModel` | `arn:aws:bedrock:*:{account}:inference-profile/us.anthropic.claude-*`, `arn:aws:bedrock:*:{account}:inference-profile/global.anthropic.claude-*`, `arn:aws:bedrock:*::foundation-model/anthropic.claude-*` | Claude 모델 호출 |
| `bedrock:InvokeModelWithResponseStream` | (위와 동일) | Claude 모델 스트리밍 호출 |
| `cloudwatch:PutMetricData` | `*` (namespace: `LLMGateway` 조건) | CloudWatch 커스텀 메트릭 전송 |
| `dynamodb:PutItem`, `UpdateItem`, `BatchWriteItem` | `arn:aws:dynamodb:{region}:{account}:table/llm-gateway-audit` | 감사 로그 기록 |

Bedrock 권한은 `anthropic.claude-*` 패턴으로 제한하여 Claude 모델만 호출 가능합니다. 다른 Bedrock 모델(Titan, Llama 등)은 호출할 수 없습니다.

### 5.2 ECS Task Execution Role

ECS 에이전트가 태스크를 시작할 때 사용하는 역할입니다. CDK가 자동 생성합니다.

| 권한 | 용도 |
|------|------|
| ECR 이미지 풀 | LiteLLM Docker 이미지 다운로드 |
| CloudWatch Logs 쓰기 | 컨테이너 로그 전송 |
| Secrets Manager 읽기 | Aurora 자격증명, LiteLLM Master Key 조회 |

### 5.3 Token Service Lambda Role

| 권한 | 리소스 | 용도 |
|------|--------|------|
| `secretsmanager:GetSecretValue` | `claude-code-enterprise/litellm-master-key` | LiteLLM Master Key 조회 |
| `dynamodb:GetItem`, `PutItem` | `arn:aws:dynamodb:{region}:{account}:table/llm-gateway-config` | Virtual Key 캐시 조회/저장 |
| VPC 네트워크 인터페이스 관리 | EC2 네트워크 인터페이스 | VPC 내 Lambda 실행 |
| CloudWatch Logs 쓰기 | Lambda 로그 그룹 | Lambda 로그 전송 |

### 5.4 SSO 사용자 (ClaudeCodeUser Permission Set)

개발자가 SSO를 통해 받는 IAM 권한입니다.

| 권한 | 리소스 | 용도 |
|------|--------|------|
| `bedrock:InvokeModel` | 모든 inference-profile, foundation-model | Bedrock 모델 직접 호출 (Gateway 우회 시) |
| `bedrock:InvokeModelWithResponseStream` | (위와 동일) | 스트리밍 호출 |
| `bedrock:ListInferenceProfiles` | `*` | 사용 가능한 모델 목록 조회 |
| `execute-api:Invoke` | Token Service API Gateway | API Gateway 호출 (SigV4) |

실제 LLM 호출은 Gateway(ECS Task Role)를 통해 이루어지므로, 개발자의 Bedrock 직접 호출 권한은 Gateway 우회 방지를 위해 제거할 수도 있습니다. 단, `execute-api:Invoke` 권한은 Token Service 호출에 필수입니다.

---

## 6. 퇴사자 접근 차단 절차

### 6.1 즉시 차단 (긴급)

**1단계**: IAM Identity Center에서 사용자 비활성화

```
IAM Identity Center > Users > {사용자} > Disable user
```

효과: 새로운 SSO 로그인 불가. 기존 SSO 세션 토큰은 만료까지 유효 (최대 8시간).

**2단계**: DynamoDB Virtual Key 캐시 삭제

```bash
aws dynamodb delete-item \
  --table-name llm-gateway-config \
  --key '{"pk": {"S": "USER#{username}"}, "sk": {"S": "VIRTUAL_KEY"}}'
```

효과: apiKeyHelper가 새 Virtual Key를 요청하지만, SSO가 비활성화되어 API Gateway IAM Auth를 통과할 수 없으므로 실패.

**3단계**: LiteLLM Virtual Key 삭제

```bash
# 사용자 키 조회
curl -k "https://{ALB_DNS_NAME}/user/info?user_id={username}" \
  -H "Authorization: Bearer {MASTER_KEY}" | python3 -m json.tool

# 키 삭제
curl -k -X POST "https://{ALB_DNS_NAME}/key/delete" \
  -H "Authorization: Bearer {MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"keys": ["sk-xxxxxxxx"]}'
```

효과: 혹시 캐시된 Virtual Key가 클라이언트에 남아 있어도 LiteLLM에서 키 검증이 실패하여 완전 차단.

### 6.2 차단 유효성 검증

| 시나리오 | 차단 여부 | 이유 |
|----------|-----------|------|
| 퇴사자가 `aws sso login` 시도 | 차단 | Identity Center에서 비활성화됨 |
| 기존 SSO 세션으로 apiKeyHelper 호출 | 차단 | DynamoDB 캐시 삭제됨 + SSO 비활성화로 IAM Auth 실패 |
| 이전에 받은 Virtual Key로 직접 LLM 요청 | 차단 | LiteLLM에서 키 삭제됨 |

3단계 모두 수행하면 즉시 완전 차단됩니다. 1단계만 수행해도 SSO 세션 만료 후(최대 8시간) 차단됩니다.

---

## 7. 프로덕션 보안 체크리스트

### 7.1 네트워크

- [ ] ALB Security Group의 인바운드를 사내 CIDR로 제한 (현재 `0.0.0.0/0`)
- [ ] AWS WAF를 ALB에 연결 (Rate Limiting, IP 화이트리스트, OWASP 규칙)
- [ ] VPC Flow Logs 활성화
- [ ] NAT Gateway 이중화 (현재 1개)

### 7.2 인증서 / TLS

- [ ] 자체서명 인증서를 ACM 공인 인증서로 교체
- [ ] 커스텀 도메인 설정 (Route 53)
- [ ] TLS 1.3 정책 확인 (현재 `TLS13_RES` 적용 완료)

### 7.3 인증 / 접근 제어

- [ ] IAM Identity Center의 Identity source를 외부 IdP(Microsoft Entra ID 등)로 전환
- [ ] SCIM 자동 프로비저닝 설정 (사용자/그룹 자동 동기화)
- [ ] MFA 활성화 (IAM Identity Center에서 설정)
- [ ] Permission Set의 세션 기간 적절성 검토 (현재 8시간)
- [ ] 불필요한 테스트 사용자 삭제

### 7.4 시크릿 관리

- [ ] Secrets Manager 자동 로테이션 설정 (Aurora 자격증명)
- [ ] LiteLLM Master Key 주기적 로테이션 계획
- [ ] 코드/설정 파일에 하드코딩된 시크릿이 없는지 확인

### 7.5 데이터 보호

- [ ] Aurora 스토리지 암호화 확인 (현재 `storageEncrypted: true`)
- [ ] DynamoDB 암호화 확인 (기본 AWS 관리 키 사용)
- [ ] CloudWatch Logs 보존 기간 설정 (현재 1개월)
- [ ] 감사 로그에 프롬프트/응답 내용이 포함되지 않는지 확인

### 7.6 삭제 정책

- [ ] Aurora `removalPolicy`를 `RETAIN` 또는 `SNAPSHOT`으로 변경 (현재 `DESTROY`)
- [ ] DynamoDB 테이블 `removalPolicy`를 `RETAIN`으로 변경 (현재 `DESTROY`)
- [ ] CloudWatch Log Group 보존 기간을 규정 준수 기간에 맞게 조정

### 7.7 모니터링 / 감사

- [ ] CloudWatch 알람의 SNS 구독 설정 (이메일/Slack)
- [ ] CloudTrail 활성화 (API Gateway, Lambda, Secrets Manager 호출 기록)
- [ ] AWS Config 활성화 (리소스 구성 변경 추적)
- [ ] LiteLLM 사용량 리포트 자동화

### 7.8 운영

- [ ] ECS 서비스 태스크 수를 2개 이상으로 증가
- [ ] ECS Auto Scaling 설정 (CPU 기반 타겟 트래킹)
- [ ] Aurora ACU 범위를 사용 패턴에 맞게 조정
- [ ] 정기적인 보안 패치 적용 계획 (LiteLLM 이미지 업데이트)
- [ ] 재해 복구(DR) 계획 수립

### 7.9 Lambda SSL 검증

Token Service Lambda에서 LiteLLM API 호출 시 현재 SSL 인증서 검증을 비활성화하고 있습니다 (`handler.py`에서 `ssl.CERT_NONE`). 이는 자체서명 인증서를 사용하기 때문입니다. 프로덕션에서 공인 인증서로 전환한 후에는 SSL 검증을 활성화해야 합니다.

```python
# 현재 (자체서명 인증서용)
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# 프로덕션 (공인 인증서 전환 후)
ctx = ssl.create_default_context()
# check_hostname과 verify_mode는 기본값(True, CERT_REQUIRED) 사용
```
