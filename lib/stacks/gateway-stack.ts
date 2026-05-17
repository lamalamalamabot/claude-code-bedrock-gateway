import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
  inferenceProfileArns: {
    opus47: string;
    opus46: string;
    sonnet46: string;
    haiku45: string;
  };
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

    // --- S3: LLM Logs ---
    const logBucket = new s3.Bucket(this, 'LlmLogBucket', {
      bucketName: `${PROJECT_NAME}-llm-logs-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'TransitionToIA',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
          ],
          expiration: cdk.Duration.days(365),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- Task Definition ---
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 4096,
      memoryLimitMiB: 8192,
    });

    // Task Role: Bedrock, CloudWatch, Logs
    this.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'BedrockAccess',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        props.inferenceProfileArns.opus47,
        props.inferenceProfileArns.opus46,
        props.inferenceProfileArns.sonnet46,
        props.inferenceProfileArns.haiku45,
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

    logBucket.grantWrite(this.taskDefinition.taskRole);

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
        STORE_PROMPTS_IN_SPEND_LOGS: 'True',
        INFERENCE_PROFILE_ARN_OPUS_4_7: props.inferenceProfileArns.opus47,
        INFERENCE_PROFILE_ARN_OPUS_4_6: props.inferenceProfileArns.opus46,
        INFERENCE_PROFILE_ARN_SONNET_4_6: props.inferenceProfileArns.sonnet46,
        INFERENCE_PROFILE_ARN_HAIKU_4_5: props.inferenceProfileArns.haiku45,
        S3_LOG_BUCKET_NAME: logBucket.bucketName,
        AWS_REGION: cdk.Aws.REGION,
      },
      entryPoint: ['sh', '-c'],
      command: [
        [
          'export DATABASE_URL="postgresql://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"',
          `python3 -c "
import yaml, os
cfg = {
    'model_list': [
        {
            'model_name': 'global.anthropic.claude-opus-4-7',
            'litellm_params': {'model': 'bedrock/' + os.environ['INFERENCE_PROFILE_ARN_OPUS_4_7']},
        },
        {
            'model_name': 'global.anthropic.claude-opus-4-6-v1',
            'litellm_params': {'model': 'bedrock/' + os.environ['INFERENCE_PROFILE_ARN_OPUS_4_6']},
        },
        {
            'model_name': 'global.anthropic.claude-sonnet-4-6',
            'litellm_params': {'model': 'bedrock/' + os.environ['INFERENCE_PROFILE_ARN_SONNET_4_6']},
        },
        {
            'model_name': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
            'litellm_params': {'model': 'bedrock/' + os.environ['INFERENCE_PROFILE_ARN_HAIKU_4_5']},
        },
    ],
    'general_settings': {
        'store_prompts_in_spend_logs': True,
    },
    'litellm_settings': {
        'drop_params': True,
        'request_timeout': 600,
        'success_callback': ['s3_v2'],
        'failure_callback': ['s3_v2'],
        's3_callback_params': {
            's3_bucket_name': os.environ['S3_LOG_BUCKET_NAME'],
            's3_region_name': os.environ.get('AWS_REGION', 'ap-northeast-2'),
            's3_path': 'litellm-logs',
            's3_use_team_prefix': True,
        },
    },
}
with open('/tmp/config.yaml', 'w') as f:
    yaml.dump(cfg, f)
"`,
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
      desiredCount: 3,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.ecsSg],
      circuitBreaker: { enable: true, rollback: true },
      assignPublicIp: false,
    });

    const scaling = this.ecsService.autoScaleTaskCount({
      minCapacity: 3,
      maxCapacity: 20,
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
      idleTimeout: cdk.Duration.seconds(900),
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
