import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { DatabaseStack } from './database-stack';
import { AuthStack } from './auth-stack';
import { GatewayStack } from './gateway-stack';
import { MonitoringStack } from './monitoring-stack';

// Hardcoded table name to break circular dependency between Gateway and Monitoring NestedStacks.
// MonitoringStack creates the table with this exact name.
const AUDIT_TABLE_NAME = 'llm-gateway-audit';
const CONFIG_TABLE_NAME = 'llm-gateway-config';

export class RootStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const network = new NetworkStack(this, 'Network');

    const database = new DatabaseStack(this, 'Database', {
      vpc: network.vpc,
      rdsSg: network.rdsSg,
    });

    const auth = new AuthStack(this, 'Auth', {
      vpc: network.vpc,
      lambdaSg: network.lambdaSg,
    });

    const gateway = new GatewayStack(this, 'Gateway', {
      vpc: network.vpc,
      albSg: network.albSg,
      ecsSg: network.ecsSg,
      dbCluster: database.cluster,
      certificateArn: this.node.tryGetContext('certificateArn') || process.env.CERTIFICATE_ARN || '',
    });

    // Token Service Lambda: LiteLLM 연동 환경변수
    auth.tokenServiceFunction.addEnvironment('CONFIG_TABLE_NAME', CONFIG_TABLE_NAME);
    auth.tokenServiceFunction.addEnvironment('LITELLM_ENDPOINT', `https://${gateway.alb.loadBalancerDnsName}`);
    auth.tokenServiceFunction.addEnvironment('LITELLM_MASTER_KEY_ARN', gateway.litellmMasterKeySecret.secretArn);
    auth.tokenServiceFunction.addEnvironment('IDENTITY_STORE_ID', this.node.tryGetContext('identityStoreId') || '');

    // Token Service Lambda: Secrets Manager 읽기 권한 (LiteLLM Master Key)
    gateway.litellmMasterKeySecret.grantRead(auth.tokenServiceFunction);

    // Token Service Lambda: DynamoDB config 테이블 읽기+쓰기 권한 (Virtual Key 조회/생성)
    auth.tokenServiceFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ConfigTableReadWrite',
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${CONFIG_TABLE_NAME}`],
    }));

    // Token Service Lambda: IAM Identity Center 그룹 조회 권한 (팀 자동 매핑)
    auth.tokenServiceFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'IdentityStoreReadAccess',
      actions: [
        'identitystore:ListUsers',
        'identitystore:ListGroupMembershipsForMember',
        'identitystore:DescribeGroup',
      ],
      resources: ['*'],
    }));

    new MonitoringStack(this, 'Monitoring', {
      ecsClusterName: gateway.ecsService.cluster.clusterName,
      ecsServiceName: gateway.ecsService.serviceName,
      albFullName: gateway.alb.loadBalancerFullName,
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

  }
}
