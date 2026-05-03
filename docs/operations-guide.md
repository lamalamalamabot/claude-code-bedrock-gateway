# 운영 가이드

이 문서는 Claude Code Enterprise 인프라의 일상 운영, 사용자 관리, 모니터링, 장애 대응 절차를 다룹니다.

---

## 1. LiteLLM Admin UI

### 1.1 접속 방법

브라우저에서 다음 URL에 접속합니다.

```
https://{ALB_DNS_NAME}/ui/
```

자체서명 인증서 사용 시 브라우저 경고가 표시됩니다. "고급" > "계속 진행"을 선택합니다.

### 1.2 로그인

LiteLLM Master Key로 로그인합니다. Master Key는 Secrets Manager에 저장되어 있습니다.

```bash
aws secretsmanager get-secret-value \
  --secret-id claude-code-enterprise/litellm-master-key \
  --query SecretString --output text
```

### 1.3 Admin UI에서 할 수 있는 작업

| 기능 | 설명 |
|------|------|
| Virtual Key 목록 조회 | 전체 사용자의 키 상태, 사용량 확인 |
| Virtual Key 예산 설정 | 개별 키에 월별 예산 한도 설정 |
| Virtual Key 비활성화/삭제 | 특정 사용자의 접근 차단 |
| 사용량 대시보드 | 모델별, 사용자별 토큰 사용량/비용 조회 |
| 모델 설정 | Bedrock 모델 라우팅 설정 (현재는 pass-through 모드) |

---

## 2. Virtual Key 관리

### 2.1 Virtual Key 자동 생성 방식

Virtual Key는 개발자의 첫 SSO 로그인 시 Token Service가 자동으로 생성합니다.

1. 개발자가 `aws sso login` 후 Claude Code 실행
2. `apiKeyHelper`가 Token Service API를 호출
3. Token Service가 LiteLLM `/key/generate` API로 Virtual Key 생성
4. DynamoDB `llm-gateway-config` 테이블에 캐싱

따라서 관리자가 수동으로 키를 발급할 필요가 없습니다.

### 2.2 예산 설정

LiteLLM Admin UI 또는 API로 개별 Virtual Key의 예산을 설정합니다.

```bash
# API로 키 업데이트 (예산 설정)
curl -k -X POST "https://{ALB_DNS_NAME}/key/update" \
  -H "Authorization: Bearer {MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "sk-xxxxxxxx",
    "max_budget": 100.0,
    "budget_duration": "30d"
  }'
```

| 파라미터 | 설명 |
|----------|------|
| `max_budget` | 월별 예산 한도 (USD) |
| `budget_duration` | 예산 리셋 주기 (예: `30d`, `7d`, `1d`) |

### 2.3 키 비활성화

특정 사용자의 접근을 차단하려면 Virtual Key를 삭제합니다.

```bash
curl -k -X POST "https://{ALB_DNS_NAME}/key/delete" \
  -H "Authorization: Bearer {MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"keys": ["sk-xxxxxxxx"]}'
```

### 2.4 키 재생성

DynamoDB 캐시를 삭제하면 다음 로그인 시 Token Service가 새 키를 자동 생성합니다.

```bash
# DynamoDB 캐시 삭제
aws dynamodb delete-item \
  --table-name llm-gateway-config \
  --key '{"pk": {"S": "USER#alice"}, "sk": {"S": "VIRTUAL_KEY"}}'
```

사용자가 다음에 Claude Code를 실행하면 새로운 Virtual Key가 자동 생성됩니다.

---

## 3. 사용자 관리

### 3.1 입사 (신규 사용자 추가)

관리자가 해야 할 일:

1. **IAM Identity Center에서 사용자 생성**
2. **적절한 그룹에 할당** (예: `Engineering-Backend`)

이것으로 끝입니다. Virtual Key는 개발자가 첫 SSO 로그인 시 자동 생성됩니다.

### 3.2 퇴사 (사용자 제거)

퇴사자의 접근을 즉시 차단하려면 다음 순서로 처리합니다.

**1단계: IAM Identity Center에서 사용자 비활성화/삭제**

IAM Identity Center > Users > 해당 사용자 선택 > **Disable user** 또는 **Delete user**

이 작업만으로 SSO 로그인이 차단됩니다. 기존 SSO 세션이 만료되면 더 이상 인증할 수 없습니다.

**2단계: DynamoDB 캐시에서 Virtual Key 삭제 (즉시 차단)**

SSO 세션이 만료되기 전에도 즉시 차단하려면 DynamoDB 캐시를 삭제합니다.

```bash
aws dynamodb delete-item \
  --table-name llm-gateway-config \
  --key '{"pk": {"S": "USER#{username}"}, "sk": {"S": "VIRTUAL_KEY"}}'
```

**3단계: LiteLLM에서 Virtual Key 비활성화 (선택)**

캐시를 삭제해도 LiteLLM의 PostgreSQL DB에는 키가 남아 있습니다. 완전히 제거하려면 LiteLLM API로 키를 삭제합니다.

```bash
# 사용자의 키 조회
curl -k "https://{ALB_DNS_NAME}/user/info?user_id={username}" \
  -H "Authorization: Bearer {MASTER_KEY}"

# 키 삭제
curl -k -X POST "https://{ALB_DNS_NAME}/key/delete" \
  -H "Authorization: Bearer {MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"keys": ["sk-xxxxxxxx"]}'
```

**접근 차단 효과:**

| 시점 | 차단 범위 |
|------|-----------|
| Identity Center 비활성화 직후 | 새로운 SSO 로그인 불가. 기존 SSO 세션 토큰이 만료되면 apiKeyHelper도 실패 |
| DynamoDB 캐시 삭제 후 | apiKeyHelper가 새 Virtual Key를 요청하지만, 캐시가 없으므로 LiteLLM에 키 생성을 시도. SSO가 비활성화된 사용자는 API Gateway IAM Auth를 통과할 수 없으므로 실패 |
| LiteLLM 키 삭제 후 | 혹시라도 캐시된 Virtual Key가 남아 있어도 LiteLLM에서 키 검증 실패 |

### 3.3 팀 이동

1. IAM Identity Center에서 기존 그룹에서 제거, 새 그룹에 추가
2. DynamoDB 캐시 삭제 (선택 -- 다음 로그인 시 새 키 자동 생성)

---

## 4. CloudWatch 모니터링

### 4.1 대시보드 접속

CloudWatch 콘솔 > Dashboards > **LLMGateway-Operations**

또는 직접 URL:

```
https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards/dashboard/LLMGateway-Operations
```

### 4.2 대시보드 위젯

| 위젯 | 메트릭 | 설명 |
|------|--------|------|
| ECS CPU Utilization | `AWS/ECS` CPUUtilization | ECS 태스크의 평균 CPU 사용률 (5분 단위) |
| ECS Memory Utilization | `AWS/ECS` MemoryUtilization | ECS 태스크의 평균 메모리 사용률 (5분 단위) |
| ALB Request Count | `AWS/ApplicationELB` RequestCount | ALB를 통한 총 요청 수 (5분 합계) |
| ALB 5XX Errors | `AWS/ApplicationELB` HTTPCode_Target_5XX_Count | 타겟(LiteLLM)에서 반환한 5xx 에러 수 |
| ALB Response Time | `AWS/ApplicationELB` TargetResponseTime | 응답 시간 p50/p95/p99 |

### 4.3 알람

| 알람 이름 | 조건 | 동작 |
|-----------|------|------|
| `claude-code-enterprise-ecs-cpu-high` | ECS CPU > 80% (5분간) | SNS 토픽 `llm-gateway-alerts`로 알림 발송 |
| `claude-code-enterprise-alb-5xx-high` | ALB 5xx > 10건 (5분간) | SNS 토픽 `llm-gateway-alerts`로 알림 발송 |

### 4.4 SNS 알림 구독 설정

배포 후 SNS 토픽에 이메일 구독을 추가합니다.

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:{ACCOUNT_ID}:llm-gateway-alerts \
  --protocol email \
  --notification-endpoint ops-team@example.com
```

이메일로 확인 링크가 전송되며, 확인을 완료해야 알림을 수신할 수 있습니다.

### 4.5 ECS 로그 확인

LiteLLM 컨테이너 로그는 CloudWatch Logs에 저장됩니다.

```bash
# 최근 30분 로그 확인
aws logs tail /ecs/claude-code-enterprise/litellm --since 30m

# 에러 로그만 필터
aws logs tail /ecs/claude-code-enterprise/litellm --since 1h --filter-pattern "ERROR"

# Token Service Lambda 로그 확인
aws logs tail /aws/lambda/claude-code-enterprise-token-service --since 30m
```

---

## 5. Aurora 관리

### 5.1 현재 구성

- 엔진: Aurora PostgreSQL 15.15 (Serverless v2)
- ACU 범위: 0.5 (최소) ~ 4 (최대)
- 서브넷: Isolated Subnet (인터넷 접근 불가)
- 데이터베이스명: `litellm`
- 자격증명: Secrets Manager (`claude-code-enterprise/aurora-credentials`)

### 5.2 ACU 모니터링

```bash
# Aurora Serverless v2 ACU 사용량 확인
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name ServerlessDatabaseCapacity \
  --dimensions Name=DBClusterIdentifier,Value={CLUSTER_ID} \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average
```

ACU가 지속적으로 최대치(4)에 도달하면 `serverlessV2MaxCapacity`를 늘려야 합니다. CDK의 `database-stack.ts`에서 값을 변경하고 재배포합니다.

### 5.3 Aurora 자격증명

Aurora 자격증명은 Secrets Manager에 저장되어 있으며, ECS 태스크 정의에서 시크릿으로 주입됩니다.

```bash
# Aurora 자격증명 확인 (운영 목적)
aws secretsmanager get-secret-value \
  --secret-id claude-code-enterprise/aurora-credentials \
  --query SecretString --output text | python3 -m json.tool
```

---

## 6. ECS 서비스 관리

### 6.1 현재 구성

- 클러스터: `claude-code-enterprise-cluster`
- 서비스: `claude-code-enterprise-litellm`
- CPU: 2 vCPU / Memory: 4 GB
- 태스크 수: 1 (기본)
- 서브넷: Private Subnet (NAT Gateway를 통한 아웃바운드)
- Circuit Breaker: 활성화 (자동 롤백)

### 6.2 태스크 수 조정

```bash
# 태스크 수 변경 (일시적)
aws ecs update-service \
  --cluster claude-code-enterprise-cluster \
  --service claude-code-enterprise-litellm \
  --desired-count 2
```

영구 변경은 CDK의 `gateway-stack.ts`에서 `desiredCount` 값을 수정하고 재배포합니다.

### 6.3 롤링 업데이트 (LiteLLM 이미지 갱신)

LiteLLM 공식 이미지(`ghcr.io/berriai/litellm:main-latest`)가 업데이트되면 새 배포를 트리거합니다.

```bash
# 새 배포 강제 실행 (동일 태스크 정의로 재배포)
aws ecs update-service \
  --cluster claude-code-enterprise-cluster \
  --service claude-code-enterprise-litellm \
  --force-new-deployment
```

Circuit Breaker가 활성화되어 있으므로, 새 태스크가 헬스체크에 실패하면 자동으로 이전 버전으로 롤백됩니다.

### 6.4 태스크 상태 확인

```bash
# 실행 중인 태스크 목록
aws ecs list-tasks \
  --cluster claude-code-enterprise-cluster \
  --service-name claude-code-enterprise-litellm

# 태스크 상세 정보
aws ecs describe-tasks \
  --cluster claude-code-enterprise-cluster \
  --tasks {TASK_ARN}
```

---

## 7. 장애 대응

### 7.1 LiteLLM 다운

**증상**: Claude Code에서 연결 실패, ALB 헬스체크 실패

**확인**:
```bash
# 헬스체크
curl -k https://{ALB_DNS_NAME}/health/liveliness

# ECS 서비스 상태
aws ecs describe-services \
  --cluster claude-code-enterprise-cluster \
  --services claude-code-enterprise-litellm \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount}'

# 태스크 중지 사유
aws ecs list-tasks --cluster claude-code-enterprise-cluster \
  --service-name claude-code-enterprise-litellm --desired-status STOPPED \
  --query 'taskArns[0]' --output text | xargs -I {} \
  aws ecs describe-tasks --cluster claude-code-enterprise-cluster --tasks {} \
  --query 'tasks[0].stoppedReason'

# 로그 확인
aws logs tail /ecs/claude-code-enterprise/litellm --since 30m
```

**대응**:
1. 로그에서 에러 원인 파악 (DB 연결 실패, OOM, 설정 오류 등)
2. 필요 시 강제 재배포: `aws ecs update-service --cluster claude-code-enterprise-cluster --service claude-code-enterprise-litellm --force-new-deployment`
3. OOM이면 태스크 정의의 메모리를 늘려서 재배포

### 7.2 Aurora 다운

**증상**: LiteLLM 로그에 PostgreSQL 연결 에러, 새 요청 처리 불가

**확인**:
```bash
# Aurora 클러스터 상태
aws rds describe-db-clusters \
  --query 'DBClusters[?contains(DBClusterIdentifier, `claude-code-enterprise`)].{Id:DBClusterIdentifier,Status:Status}'

# Aurora 인스턴스 상태
aws rds describe-db-instances \
  --query 'DBInstances[?contains(DBClusterIdentifier, `claude-code-enterprise`)].{Id:DBInstanceIdentifier,Status:DBInstanceStatus}'
```

**대응**:
1. Aurora Serverless v2는 자동 복구 기능이 있으므로 대부분 자동 회복
2. 장시간 복구되지 않으면 AWS Support 케이스 오픈
3. LiteLLM은 DB 연결이 복구되면 자동으로 정상화

### 7.3 Token Service 에러

**증상**: Claude Code 실행 시 "Token Service에서 키를 받지 못했습니다"

**확인**:
```bash
# Lambda 로그 확인
aws logs tail /aws/lambda/claude-code-enterprise-token-service --since 30m

# Lambda 함수 상태
aws lambda get-function \
  --function-name claude-code-enterprise-token-service \
  --query 'Configuration.{State:State,LastModified:LastModified}'
```

**주요 에러 원인과 대응**:

| 에러 | 원인 | 대응 |
|------|------|------|
| "요청에서 사용자 ARN을 찾을 수 없습니다" | API Gateway IAM Auth 설정 문제 | API Gateway 리소스의 인증 설정 확인 |
| "SSO ARN 형식이 아닙니다" | SSO가 아닌 일반 IAM 자격증명으로 호출 | SSO 로그인 여부 확인 |
| LiteLLM API 에러 | LiteLLM 서비스 다운 또는 Master Key 불일치 | Section 7.1 참조 |
| DynamoDB 에러 | DynamoDB 접근 권한 또는 테이블 미존재 | IAM 정책 및 테이블 존재 확인 |

### 7.4 네트워크 장애

**증상**: 간헐적 연결 실패, 타임아웃

**확인 포인트**:

| 구간 | 확인 방법 |
|------|-----------|
| 클라이언트 -> ALB | `curl -k -v https://{ALB_DNS_NAME}/health/liveliness` |
| ALB -> ECS | ALB Target Group 헬스체크 상태 확인 |
| ECS -> Aurora | ECS 로그에서 DB 연결 에러 확인 |
| ECS -> Bedrock | LiteLLM 로그에서 Bedrock API 에러 확인 |
| Lambda -> ALB | Lambda 로그에서 LiteLLM API 호출 에러 확인 |

Security Group 체인 확인:

```
ALB SG (443 inbound) -> ECS SG (4000 from ALB SG) -> RDS SG (5432 from ECS SG, Lambda SG)
```

---

## 8. 비용 모니터링

### 8.1 주요 비용 발생 항목

| 서비스 | 비용 요소 | 예상 규모 |
|--------|-----------|-----------|
| Amazon Bedrock | 모델 호출 (입출력 토큰) | 사용량에 비례, 가장 큰 비용 항목 |
| ECS Fargate | vCPU/메모리 시간 | 2 vCPU / 4 GB 상시 구동 |
| Aurora Serverless v2 | ACU 시간 | 최소 0.5 ACU 상시 |
| NAT Gateway | 데이터 처리량 + 시간 | 1개 상시 구동 |
| ALB | 시간 + LCU | 상시 구동 |
| VPC Endpoint (Bedrock) | 시간 + 데이터 처리량 | Interface Endpoint 2 AZ |
| Secrets Manager | 시크릿 수 + API 호출 | 소규모 |
| DynamoDB | 읽기/쓰기 요청 | PAY_PER_REQUEST, 소규모 |

### 8.2 비용 확인

```bash
# AWS Cost Explorer CLI로 서비스별 비용 확인
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -v-30d +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --filter '{"Tags":{"Key":"aws:cloudformation:stack-name","Values":["LlmGatewayStack"]}}'
```

### 8.3 비용 최적화 팁

- **Bedrock**: 모델 버전을 고정하여 의도치 않은 고비용 모델 사용 방지
- **ECS**: 사용량이 낮은 시간대에는 태스크 수를 줄이거나, Scheduled Scaling 적용
- **Aurora**: Serverless v2의 최소 ACU(0.5)는 유휴 시에도 비용 발생. 비사용 시간이 길면 클러스터 일시 중지 고려
- **NAT Gateway**: VPC Endpoint를 통해 Bedrock/DynamoDB/S3 트래픽을 AWS 네트워크 내부로 유지하여 NAT 비용 절감 (이미 적용됨)
