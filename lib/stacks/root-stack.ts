import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { DatabaseStack } from './database-stack';
import { CacheStack } from './cache-stack';
import { AuthStack } from './auth-stack';
import { GatewayStack } from './gateway-stack';
import { InferenceProfileStack } from './inference-profile-stack';
import { MonitoringStack } from './monitoring-stack';
import { ExportStack } from './export-stack';
import { RestartStack } from './restart-stack';

// Hardcoded table name to break circular dependency between Gateway and Monitoring NestedStacks.
// MonitoringStack creates the table with this exact name.
const AUDIT_TABLE_NAME = 'llm-gateway-audit';
const CONFIG_TABLE_NAME = 'llm-gateway-config';

export class RootStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const spendLogExportBucket = this.node.tryGetContext('spendLogExportBucket') as string | undefined;
    const spendLogExportAccountId = this.node.tryGetContext('spendLogExportAccountId') as string | undefined;

    const network = new NetworkStack(this, 'Network');

    const database = new DatabaseStack(this, 'Database', {
      vpc: network.vpc,
      rdsSg: network.rdsSg,
      spendLogExportBucket,
      spendLogExportAccountId,
    });

    const cache = new CacheStack(this, 'Cache', {
      vpc: network.vpc,
      cacheSg: network.cacheSg,
    });

    const inferenceProfile = new InferenceProfileStack(this, 'InferenceProfile');

    const auth = new AuthStack(this, 'Auth', {
      vpc: network.vpc,
      lambdaSg: network.lambdaSg,
    });

    const gateway = new GatewayStack(this, 'Gateway', {
      vpc: network.vpc,
      albSg: network.albSg,
      ecsSg: network.ecsSg,
      dbCluster: database.cluster,
      redisEndpoint: cache.cache.attrEndpointAddress,
      redisPort: cache.cache.attrEndpointPort,
      certificateArn: this.node.tryGetContext('certificateArn') || process.env.CERTIFICATE_ARN || '',
      inferenceProfileArns: {
        opus48: inferenceProfile.opus48Arn,
        opus47: inferenceProfile.opus47Arn,
        opus46: inferenceProfile.opus46Arn,
        sonnet5: inferenceProfile.sonnet5Arn,
        sonnet46: inferenceProfile.sonnet46Arn,
        haiku45: inferenceProfile.haiku45Arn,
      },
    });

    // Token Service Lambda: LiteLLM 연동 환경변수
    auth.tokenServiceFunction.addEnvironment('CONFIG_TABLE_NAME', CONFIG_TABLE_NAME);
    auth.tokenServiceFunction.addEnvironment('LITELLM_ENDPOINT', `https://${gateway.alb.loadBalancerDnsName}`);
    auth.tokenServiceFunction.addEnvironment('LITELLM_MASTER_KEY_ARN', gateway.litellmMasterKeySecret.secretArn);
    auth.tokenServiceFunction.addEnvironment('IDENTITY_STORE_ID', this.node.tryGetContext('identityStoreId') || '');

    // Cross-account Identity Store 접근용 Role ARN (Payer 계정에 생성된 Role)
    // 설정하지 않으면 로컬 계정의 Identity Store API를 직접 호출 (단일 계정 구성)
    const identityStoreRoleArn = this.node.tryGetContext('identityStoreRoleArn') || '';
    if (identityStoreRoleArn) {
      auth.tokenServiceFunction.addEnvironment('IDENTITY_STORE_ROLE_ARN', identityStoreRoleArn);
      // Cross-account: Payer 계정의 Role을 assume할 권한
      auth.tokenServiceFunction.addToRolePolicy(new iam.PolicyStatement({
        sid: 'AssumeIdentityStoreRole',
        actions: ['sts:AssumeRole'],
        resources: [identityStoreRoleArn],
      }));
    } else {
      // 단일 계정: Identity Store API 직접 호출 권한
      auth.tokenServiceFunction.addToRolePolicy(new iam.PolicyStatement({
        sid: 'IdentityStoreReadAccess',
        actions: [
          'identitystore:ListUsers',
          'identitystore:ListGroupMembershipsForMember',
          'identitystore:DescribeGroup',
        ],
        resources: ['*'],
      }));
    }

    // Token Service Lambda: Secrets Manager 읽기 권한 (LiteLLM Master Key)
    gateway.litellmMasterKeySecret.grantRead(auth.tokenServiceFunction);

    // Token Service Lambda: DynamoDB config 테이블 읽기+쓰기 권한 (Virtual Key 조회/생성)
    auth.tokenServiceFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ConfigTableReadWrite',
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${CONFIG_TABLE_NAME}`],
    }));

    new MonitoringStack(this, 'Monitoring', {
      ecsClusterName: gateway.ecsService.cluster.clusterName,
      ecsServiceName: gateway.ecsService.serviceName,
      albFullName: gateway.alb.loadBalancerFullName,
    });

    // Output Application Inference Profile ARNs for developer settings.json
    new cdk.CfnOutput(this, 'InferenceProfileArnOpus', {
      value: inferenceProfile.opus46Arn,
      description: 'Application Inference Profile ARN for Claude Opus (LiteLLM routes global.* to this ARN)',
    });
    new cdk.CfnOutput(this, 'InferenceProfileArnSonnet', {
      value: inferenceProfile.sonnet46Arn,
      description: 'Application Inference Profile ARN for Claude Sonnet (LiteLLM routes global.* to this ARN)',
    });
    new cdk.CfnOutput(this, 'InferenceProfileArnHaiku', {
      value: inferenceProfile.haiku45Arn,
      description: 'Application Inference Profile ARN for Claude Haiku (LiteLLM routes global.* to this ARN)',
    });

    // Grant ECS task role write access to audit table.
    // Uses hardcoded table name + ARN to avoid circular dependency (Gateway <-> Monitoring).
    gateway.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'AuditTableWriteAccess',
      actions: [
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:BatchWriteItem',
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${AUDIT_TABLE_NAME}`,
      ],
    }));

    // Inject AUDIT_TABLE_NAME into the LiteLLM container
    gateway.taskDefinition.defaultContainer!.addEnvironment(
      'AUDIT_TABLE_NAME',
      AUDIT_TABLE_NAME,
    );

    // Spend log export: Aurora → S3 (hourly)
    new ExportStack(this, 'Export', {
      vpc: network.vpc,
      lambdaSg: network.lambdaSg,
      dbSecretArn: database.cluster.secret!.secretArn,
      s3ExportKeyArn: database.s3ExportKey?.keyArn,
      spendLogExportBucket,
    });

    // Daily 04:00 KST maintenance: rolling restart of the Fargate service +
    // retention cleanup of old spend logs (keep last 2 days).
    new RestartStack(this, 'Restart', {
      ecsService: gateway.ecsService,
      vpc: network.vpc,
      lambdaSg: network.lambdaSg,
      dbSecretArn: database.cluster.secret!.secretArn,
    });

  }
}
