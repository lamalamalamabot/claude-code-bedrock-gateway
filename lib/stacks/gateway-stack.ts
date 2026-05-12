import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../config/constants';

// LiteLLM config.yaml is generated at container startup and passed via --config.
// Enables prompt storage in spend logs and model persistence in DB.

export interface GatewayStackProps {
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  ecsSg: ec2.ISecurityGroup;
  dbCluster: rds.DatabaseCluster;
  certificateArn: string;
}

export class GatewayStack extends cdk.NestedStack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly ecsService: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly litellmMasterKeySecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id);

    // --- LiteLLM Master Key ---
    this.litellmMasterKeySecret = new secretsmanager.Secret(this, 'LitellmMasterKey', {
      secretName: `${PROJECT_NAME}/litellm-master-key`,
      description: 'LiteLLM proxy master key',
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
        includeSpace: false,
      },
    });

    // --- ECS Cluster ---
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${PROJECT_NAME}-cluster`,
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    // --- CloudWatch Log Group ---
    const logGroup = new logs.LogGroup(this, 'LitellmLogGroup', {
      logGroupName: `/ecs/${PROJECT_NAME}/litellm`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Task Definition ---
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 2048,
      memoryLimitMiB: 4096,
    });

    // Task Role: Bedrock, CloudWatch, Logs
    this.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'BedrockAccess',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-*`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
      ],
    }));

    this.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'MarketplaceModelAccess',
      actions: [
        'aws-marketplace:ViewSubscriptions',
        'aws-marketplace:Subscribe',
      ],
      resources: ['*'],
    }));

    this.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMetrics',
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'cloudwatch:namespace': 'LLMGateway' },
      },
    }));

    // --- Container ---
    this.taskDefinition.addContainer('litellm', {
      image: ecs.ContainerImage.fromRegistry('ghcr.io/berriai/litellm:main-latest'),
      portMappings: [{ containerPort: 4000, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'litellm',
      }),
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(props.dbCluster.secret!, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(props.dbCluster.secret!, 'port'),
        DB_USERNAME: ecs.Secret.fromSecretsManager(props.dbCluster.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.dbCluster.secret!, 'password'),
        LITELLM_MASTER_KEY: ecs.Secret.fromSecretsManager(this.litellmMasterKeySecret),
      },
      environment: {
        DB_NAME: 'litellm',
      },
      entryPoint: ['sh', '-c'],
      command: [
        [
          'export DATABASE_URL="postgresql://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"',
          'printf "general_settings:\\n  store_model_in_db: true\\n  store_prompts_in_spend_logs: true\\nlitellm_settings:\\n  drop_params: true\\n  enable_litellm_model_name_matching: false\\n" > /tmp/config.yaml',
          'exec litellm --port 4000 --config /tmp/config.yaml',
        ].join(' && '),
      ],
      healthCheck: {
        command: ['CMD-SHELL', 'python -c "import urllib.request; urllib.request.urlopen(\'http://localhost:4000/health/liveliness\')" || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    // --- ECS Service ---
    this.ecsService = new ecs.FargateService(this, 'Service', {
      serviceName: `${PROJECT_NAME}-litellm`,
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.ecsSg],
      circuitBreaker: { enable: true, rollback: true },
      assignPublicIp: false,
    });

    const scaling = this.ecsService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 10,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
    });

    // --- ALB ---
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${PROJECT_NAME}-alb`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: cdk.Duration.seconds(300),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: 'cce-litellm-tg',
      vpc: props.vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health/liveliness',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(300),
    });

    targetGroup.addTarget(this.ecsService);

    // HTTPS listener
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);
    this.alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
      certificates: [certificate],
      defaultTargetGroups: [targetGroup],
      open: false,
    });

    // HTTP -> HTTPS redirect
    this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
      open: false,
    });

  }
}
