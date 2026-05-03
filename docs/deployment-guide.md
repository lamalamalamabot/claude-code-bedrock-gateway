# 배포 가이드

이 문서는 Claude Code Enterprise 인프라를 AWS 환경에 배포하는 전체 과정을 다룹니다.

---

## 1. 사전 요구사항

### 1.1 로컬 도구

| 도구 | 최소 버전 | 설치 확인 |
|------|-----------|-----------|
| AWS CLI | v2 | `aws --version` |
| Node.js | 18 이상 | `node --version` |
| AWS CDK | v2 | `npx cdk --version` |
| Python | 3.12 이상 | `python3 --version` (Lambda 로컬 테스트용, 선택) |

### 1.2 AWS 계정 사전 설정

다음 항목이 완료되어 있어야 합니다.

- **AWS Organization 활성화**: IAM Identity Center 사용을 위한 필수 조건
- **IAM Identity Center 활성화**: Organization 관리 계정에서 활성화
- **Amazon Bedrock 모델 접근 승인**: Bedrock 콘솔에서 다음 모델에 대한 사용 요청을 완료해야 함
  - Claude Opus 4.6 (`us.anthropic.claude-opus-4-6-v1`)
  - Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`)
  - Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`)
- **CDK 배포 권한이 있는 IAM 사용자/역할**: CloudFormation, ECS, ALB, RDS, Lambda, API Gateway, DynamoDB, Secrets Manager, CloudWatch, SNS, VPC 등의 리소스 생성 권한

---

## 2. CDK Bootstrap

AWS 계정과 리전에 CDK를 처음 사용하는 경우, Bootstrap을 실행합니다. Bootstrap은 CDK가 자산(Lambda 코드, Docker 이미지 등)을 저장할 S3 버킷과 ECR 리포지토리, 배포에 필요한 IAM 역할을 생성합니다.

```bash
# 배포용 AWS 프로필/자격증명이 설정된 상태에서 실행
cdk bootstrap aws://{ACCOUNT_ID}/us-east-1
```

이미 Bootstrap이 완료된 계정/리전이라면 이 단계를 건너뛸 수 있습니다.

---

## 3. 자체서명 인증서 생성 및 ACM Import

ALB의 HTTPS 리스너에는 ACM 인증서가 필요합니다. 개발/테스트 환경에서는 자체서명 인증서를 사용합니다.

### 3.1 자체서명 인증서 생성

```bash
# 개인키 생성
openssl genrsa 2048 > private-key.pem

# 인증서 서명 요청(CSR) 생성
openssl req -new -key private-key.pem -out csr.pem \
  -subj "/C=KR/ST=Seoul/L=Seoul/O=MyCompany/CN=claude-code-enterprise"

# 자체서명 인증서 생성 (365일 유효)
openssl x509 -req -days 365 -in csr.pem \
  -signkey private-key.pem -out certificate.pem
```

### 3.2 ACM에 인증서 Import

```bash
aws acm import-certificate \
  --certificate fileb://certificate.pem \
  --private-key fileb://private-key.pem \
  --region us-east-1
```

출력에서 `CertificateArn` 값을 기록해 둡니다. 배포 시 이 값이 필요합니다.

```json
{
  "CertificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

### 3.3 클라이언트용 인증서 파일 보관

자체서명 인증서를 사용하는 경우, Claude Code 클라이언트에서 TLS 검증 오류가 발생합니다. 생성한 `certificate.pem` 파일을 개발자에게 배포하여 `NODE_EXTRA_CA_CERTS` 환경변수로 지정하도록 안내합니다.

---

## 4. CDK 배포

### 4.1 의존성 설치

```bash
cd /Users/anhyobin/dev/claude-code-enterprise
npm install
```

### 4.2 배포 실행

```bash
cdk deploy LlmGatewayStack -c certificateArn={ACM_CERTIFICATE_ARN}
```

실제 예시:

```bash
cdk deploy LlmGatewayStack \
  -c certificateArn=arn:aws:acm:us-east-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

`LlmGatewayStack`은 RootStack으로, NestedStack 구조를 통해 다음 하위 스택이 모두 함께 배포됩니다.

```
LlmGatewayStack (Root)
  +-- Network    : VPC (2 AZ), Security Groups, VPC Endpoints (Bedrock, S3, DynamoDB)
  +-- Database   : Aurora Serverless v2 (PostgreSQL 15.15, 0.5~4 ACU)
  +-- Auth       : Token Service Lambda + API Gateway (IAM Auth)
  +-- Gateway    : ALB (HTTPS) + ECS Fargate + LiteLLM Proxy
  +-- Monitoring : DynamoDB (Audit/Config 테이블), CloudWatch Dashboard, Alarms, SNS
```

배포는 약 15~25분 소요됩니다. Aurora 클러스터 생성과 ECS 서비스 안정화에 시간이 걸립니다.

### 4.3 배포 출력 확인

배포가 완료되면 CloudFormation Outputs에서 다음 값을 확인합니다.

```bash
# CloudFormation 콘솔에서 LlmGatewayStack 선택 -> Outputs 탭
# 또는 AWS CLI로 확인
aws cloudformation describe-stacks --stack-name LlmGatewayStack \
  --query 'Stacks[0].Outputs' --output table
```

주요 출력값:

| 출력 | 설명 | 예시 |
|------|------|------|
| ALB DNS Name | LiteLLM Gateway 주소 | `{ALB_DNS}` |
| API Gateway URL | Token Service 엔드포인트 | `https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/v1` |

---

## 5. 배포 후 확인 사항

### 5.1 ALB 헬스체크 확인

```bash
# LiteLLM 헬스체크 (자체서명 인증서이므로 -k 옵션 사용)
curl -k https://{ALB_DNS_NAME}/health/liveliness
```

정상 응답:

```json
"connected"
```

### 5.2 ECS 서비스 상태 확인

```bash
# ECS 서비스 상태 확인
aws ecs describe-services \
  --cluster claude-code-enterprise-cluster \
  --services claude-code-enterprise-litellm \
  --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount,Health:healthCheckGracePeriodSeconds}'
```

정상 상태:
- `status`: `ACTIVE`
- `runningCount`: `desiredCount`와 동일 (기본값 1)

ECS 태스크가 시작되지 않으면 다음을 확인합니다.

```bash
# 태스크 중지 사유 확인
aws ecs list-tasks --cluster claude-code-enterprise-cluster --service-name claude-code-enterprise-litellm --desired-status STOPPED
aws ecs describe-tasks --cluster claude-code-enterprise-cluster --tasks {TASK_ARN} --query 'tasks[0].stoppedReason'

# CloudWatch 로그 확인
aws logs tail /ecs/claude-code-enterprise/litellm --since 30m
```

### 5.3 API Gateway 확인

```bash
# Token Service 엔드포인트 확인 (IAM 인증 없이는 403 반환이 정상)
curl -s -o /dev/null -w "%{http_code}" \
  https://{API_GATEWAY_URL}/v1/auth/token -X POST
```

`403` 응답이면 IAM Auth가 정상 동작 중입니다. `404`면 API Gateway 배포에 문제가 있습니다.

### 5.4 Aurora 연결 확인

Aurora는 Isolated Subnet에 배치되어 있으므로 직접 접속이 불가합니다. LiteLLM이 정상적으로 기동되었다면 DB 연결이 성공한 것입니다. LiteLLM 로그에서 확인합니다.

```bash
aws logs tail /ecs/claude-code-enterprise/litellm --since 10m | grep -i "database\|postgres\|connected"
```

### 5.5 LiteLLM Admin UI 접속

브라우저에서 다음 URL에 접속합니다.

```
https://{ALB_DNS_NAME}/ui/
```

Master Key로 로그인합니다. Master Key는 Secrets Manager에서 확인합니다.

```bash
aws secretsmanager get-secret-value \
  --secret-id claude-code-enterprise/litellm-master-key \
  --query SecretString --output text
```

---

## 6. 프로덕션 전환 시 변경 사항

개발/테스트 환경에서 프로덕션으로 전환할 때 다음 사항을 변경합니다.

### 6.1 공인 인증서

자체서명 인증서 대신 ACM에서 발급한 공인 인증서를 사용합니다.

- Route 53에 커스텀 도메인을 등록하고, ACM에서 도메인 검증된 인증서를 발급
- ALB에 커스텀 도메인의 CNAME/Alias 레코드를 설정
- `certificateArn` 컨텍스트 값을 공인 인증서 ARN으로 교체하여 재배포

### 6.2 ALB Security Group 제한

현재 ALB는 모든 IP(`0.0.0.0/0`)에서 접근이 가능합니다. 프로덕션에서는 사내 CIDR로 제한합니다.

`network-stack.ts`에서 ALB Security Group의 인바운드 규칙을 수정합니다.

```typescript
// 변경 전 (개발/테스트)
this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from anywhere');

// 변경 후 (프로덕션)
this.albSg.addIngressRule(ec2.Peer.ipv4('10.0.0.0/8'), ec2.Port.tcp(443), 'Allow HTTPS from corporate network');
```

### 6.3 WAF 적용

ALB에 AWS WAF를 연결하여 Rate Limiting, IP 화이트리스트, SQL Injection 방어 등을 적용합니다.

### 6.4 NAT Gateway 이중화

현재 비용 최적화를 위해 NAT Gateway 1개만 사용합니다. 프로덕션에서는 `natGateways: 2`로 변경하여 AZ 장애에 대비합니다.

### 6.5 Aurora ACU 조정

현재 0.5~4 ACU로 설정되어 있습니다. 사용량에 따라 `serverlessV2MaxCapacity`를 늘릴 수 있습니다.

### 6.6 ECS 서비스 스케일링

현재 `desiredCount: 1`입니다. 프로덕션에서는 최소 2개 이상의 태스크를 실행하고, CPU 기반 Auto Scaling을 설정합니다.

### 6.7 IdP 전환

IAM Identity Center의 Identity source를 내장 디렉토리에서 Microsoft Entra ID 등 외부 IdP로 전환합니다. SAML + SCIM 설정이 필요하며, 기존 Permission Set과 Gateway 인증 흐름은 변경 없이 유지됩니다.

### 6.8 삭제 정책 변경

현재 Aurora와 DynamoDB 테이블의 `removalPolicy`가 `DESTROY`로 설정되어 있습니다. 프로덕션에서는 `RETAIN` 또는 `SNAPSHOT`으로 변경합니다.

---

## 7. 배포 문제 해결

### 7.1 certificateArn 누락

```
Error: Certificate ARN is required
```

`-c certificateArn=...` 컨텍스트를 전달하지 않으면 ALB HTTPS 리스너 생성에 실패합니다. Section 3을 참조하여 인증서를 준비합니다.

### 7.2 CDK Bootstrap 미실행

```
Error: This stack uses assets, so the toolkit stack must be deployed
```

`cdk bootstrap` 을 먼저 실행합니다.

### 7.3 Bedrock 모델 접근 미승인

배포 자체는 성공하지만, Claude Code 사용 시 모델 호출에서 `AccessDeniedException`이 발생합니다. Bedrock 콘솔에서 모델 접근 요청을 완료해야 합니다.

### 7.4 ECS 태스크 반복 재시작

LiteLLM 컨테이너가 Aurora에 연결하지 못하면 헬스체크 실패로 태스크가 반복 종료됩니다. 다음을 확인합니다.

- Security Group: ECS SG -> RDS SG (5432) 인바운드 허용 확인
- Secrets Manager: Aurora 자격증명 시크릿이 정상적으로 생성되었는지 확인
- VPC Subnet: ECS는 Private Subnet, Aurora는 Isolated Subnet에 배치되어 있는지 확인

### 7.5 스택 롤백 시

NestedStack 구조이므로 하위 스택 하나라도 실패하면 전체가 롤백됩니다. CloudFormation 콘솔에서 실패한 중첩 스택의 이벤트를 확인하여 원인을 파악합니다.

```bash
aws cloudformation describe-stack-events \
  --stack-name LlmGatewayStack \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
  --output table
```
