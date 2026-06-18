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
  inferenceProfileArns: {
    opus48: string;
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

    // --- Task Definition ---
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 4096,
      memoryLimitMiB: 30720,
    });

    // Task Role: Bedrock, CloudWatch
    this.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'BedrockAccess',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        props.inferenceProfileArns.opus48,
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

    // --- Container ---
    this.taskDefinition.addContainer('litellm', {
      image: ecs.ContainerImage.fromRegistry('ghcr.io/berriai/litellm:v1.85.0'),
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
        INFERENCE_PROFILE_ARN_OPUS_4_8: props.inferenceProfileArns.opus48,
        INFERENCE_PROFILE_ARN_OPUS_4_7: props.inferenceProfileArns.opus47,
        INFERENCE_PROFILE_ARN_OPUS_4_6: props.inferenceProfileArns.opus46,
        INFERENCE_PROFILE_ARN_SONNET_4_6: props.inferenceProfileArns.sonnet46,
        INFERENCE_PROFILE_ARN_HAIKU_4_5: props.inferenceProfileArns.haiku45,
      },
      entryPoint: ['sh', '-c'],
      command: [
        [
          'export LITELLM_MASTER_KEY="sk-${LITELLM_MASTER_KEY}"',
          'export DATABASE_URL="postgresql://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"',
          `python3 -c "
import yaml, os
cfg = {
    'model_list': [
        {
            'model_name': 'global.anthropic.claude-opus-4-8',
            'litellm_params': {
                'model': 'bedrock/' + os.environ['INFERENCE_PROFILE_ARN_OPUS_4_8'],
            },
            'model_info': {
                'base_model': 'bedrock/global.anthropic.claude-opus-4-8',
            },
        },
        {
            'model_name': 'global.anthropic.claude-opus-4-7',
            'litellm_params': {
                'model': 'bedrock/' + os.environ['INFERENCE_PROFILE_ARN_OPUS_4_7'],
            },
            'model_info': {
                'base_model': 'bedrock/global.anthropic.claude-opus-4-7',
            },
        },
        {
            'model_name': 'global.anthropic.claude-opus-4-6-v1',
            'litellm_params': {
                'model': 'bedrock/' + os.environ['INFERENCE_PROFILE_ARN_OPUS_4_6'],
            },
            'model_info': {
                'base_model': 'bedrock/global.anthropic.claude-opus-4-6-v1',
            },
        },
        {
            'model_name': 'global.anthropic.claude-sonnet-4-6',
            'litellm_params': {
                'model': 'bedrock/' + os.environ['INFERENCE_PROFILE_ARN_SONNET_4_6'],
            },
            'model_info': {
                'base_model': 'bedrock/global.anthropic.claude-sonnet-4-6',
            },
        },
        {
            'model_name': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
            'litellm_params': {
                'model': 'bedrock/' + os.environ['INFERENCE_PROFILE_ARN_HAIKU_4_5'],
            },
            'model_info': {
                'base_model': 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
            },
        },
    ],
    'general_settings': {
        'store_prompts_in_spend_logs': True,
    },
    'litellm_settings': {
        'drop_params': True,
        'request_timeout': 600,
        'max_internal_user_budget': 100,
        'internal_user_budget_duration': '30d',
    },
}
with open('/tmp/config.yaml', 'w') as f:
    yaml.dump(cfg, f)
"`,
          `python3 -c "
import subprocess, glob, os, sys
NL = chr(10); Q = chr(39)
TARGET = 'litellm/llms/bedrock/passthrough/transformation.py'
MARK = '__REQMETA_PATCH__'
P = [
    '',
    '# ' + MARK,
    'import json as _rm_json',
    '_RM_ORIG = BedrockPassthroughConfig.sign_request',
    'def _rm_sign(self, headers, litellm_params, request_data, api_base, model=None):',
    '    cid = litellm_params.get(' + Q + 'litellm_call_id' + Q + ') if isinstance(litellm_params, dict) else None',
    '    if cid:',
    '        headers = dict(headers or {})',
    '        headers[' + Q + 'X-Amzn-Bedrock-Request-Metadata' + Q + '] = _rm_json.dumps({' + Q + 'litellm_call_id' + Q + ': str(cid)})',
    '    return _RM_ORIG(self, headers, litellm_params, request_data, api_base, model)',
    'BedrockPassthroughConfig.sign_request = _rm_sign',
]
patch = NL.join(P) + NL
res = subprocess.run(['find', '/', '-path', '*/' + TARGET, '-type', 'f'], capture_output=True, text=True, timeout=30)
paths = [p.strip() for p in res.stdout.strip().split(NL) if p.strip()]
if not paths:
    print('ERROR: no transformation.py found'); sys.exit(1)
for path in paths:
    with open(path) as f:
        src = f.read()
    if MARK in src:
        print('SKIP already patched: ' + path); continue
    with open(path, 'a') as f:
        f.write(patch)
    d = os.path.join(os.path.dirname(path), '__pycache__')
    if os.path.isdir(d):
        for pyc in glob.glob(os.path.join(d, '*.pyc')):
            os.remove(pyc)
    print('APPENDED requestMetadata patch: ' + path)
"`,
          `python3 -c "
import subprocess, glob, os, sys
MARKER = 'invoke_provider = AmazonInvokeConfig.get_bedrock_invoke_provider(model)'
PROFILE = 'application-inference-profile'
PROVIDER = 'anthropic'
target = 'litellm/llms/bedrock/passthrough/transformation.py'
result = subprocess.run(['find', '/', '-path', '*/' + target, '-type', 'f'], capture_output=True, text=True, timeout=30)
paths = [p.strip() for p in result.stdout.strip().split(chr(10)) if p.strip()]
if not paths:
    print('ERROR: no transformation.py found')
    sys.exit(1)
for path in paths:
    with open(path) as f:
        lines = f.readlines()
    if any(PROFILE in l and 'invoke_provider' in l for l in lines):
        print('SKIP: ' + path)
        continue
    ok = False
    out = []
    for i, line in enumerate(lines):
        out.append(line)
        if (line.strip() == MARKER
            and i + 1 < len(lines)
            and 'if invoke_provider is None:' in lines[i + 1]
            and 'raise ValueError' in lines[i + 2]):
            ind = line[:len(line) - len(line.lstrip())]
            out.append(ind + 'if invoke_provider is None and ' + repr(PROFILE) + ' in model:' + chr(10))
            out.append(ind + '    invoke_provider = ' + repr(PROVIDER) + chr(10))
            ok = True
    if not ok:
        print('ERROR: target not found in ' + path)
        sys.exit(1)
    with open(path, 'w') as f:
        f.writelines(out)
    d = os.path.join(os.path.dirname(path), '__pycache__')
    if os.path.isdir(d):
        for pyc in glob.glob(os.path.join(d, '*.pyc')):
            os.remove(pyc)
    print('PATCHED: ' + path)
"`,
          `python3 -c "
import subprocess, glob, os, sys
NL = chr(10); DQ = chr(34)
TARGET = 'litellm/proxy/spend_tracking/spend_tracking_utils.py'
MARK = '__LLCALLID_META_PATCH__'
ANCHOR = 'clean_metadata[' + DQ + 'additional_usage_values' + DQ + '] = additional_usage_values'
INSERT = 'clean_metadata[' + DQ + 'litellm_call_id' + DQ + '] = kwargs.get(' + DQ + 'litellm_call_id' + DQ + ')  # ' + MARK
res = subprocess.run(['find', '/', '-path', '*/' + TARGET, '-type', 'f'], capture_output=True, text=True, timeout=30)
paths = [p.strip() for p in res.stdout.strip().split(NL) if p.strip()]
if not paths:
    print('ERROR: no spend_tracking_utils.py found'); sys.exit(1)
for path in paths:
    with open(path) as f:
        lines = f.readlines()
    if any(MARK in l for l in lines):
        print('SKIP already patched: ' + path); continue
    n = sum(1 for l in lines if l.strip() == ANCHOR)
    if n != 1:
        print('ERROR: anchor count != 1 (' + str(n) + '): ' + path); sys.exit(1)
    out = []
    for l in lines:
        out.append(l)
        if l.strip() == ANCHOR:
            ind = l[:len(l) - len(l.lstrip())]
            out.append(ind + INSERT + NL)
    with open(path, 'w') as f:
        f.writelines(out)
    if MARK not in open(path).read():
        print('ERROR: readback verify failed: ' + path); sys.exit(1)
    d = os.path.join(os.path.dirname(path), '__pycache__')
    if os.path.isdir(d):
        for pyc in glob.glob(os.path.join(d, '*.pyc')):
            os.remove(pyc)
    print('PATCHED litellm_call_id metadata: ' + path)
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
      desiredCount: 5,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.ecsSg],
      circuitBreaker: { enable: true, rollback: true },
      assignPublicIp: false,
    });

    const scaling = this.ecsService.autoScaleTaskCount({
      minCapacity: 5,
      maxCapacity: 20,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
    });
    scaling.scaleOnMemoryUtilization('MemoryScaling', {
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
