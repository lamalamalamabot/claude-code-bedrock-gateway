import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { PROJECT_NAME, SPEND_LOG_BUCKET_PREFIX } from '../config/constants';

export interface ExportStackProps {
  vpc: ec2.IVpc;
  lambdaSg: ec2.ISecurityGroup;
  dbSecretArn: string;
  s3ExportKeyArn?: string;
}

export class ExportStack extends cdk.NestedStack {
  public readonly logBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ExportStackProps) {
    super(scope, id);

    const externalBucket = this.node.tryGetContext('spendLogExportBucket') as string | undefined;

    // S3 bucket for spend log exports
    this.logBucket = new s3.Bucket(this, 'SpendLogBucket', {
      bucketName: `${SPEND_LOG_BUCKET_PREFIX}-${cdk.Aws.ACCOUNT_ID}`,
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

    const targetBucketName = externalBucket || this.logBucket.bucketName;

    // Lambda: executes aws_s3.query_export_to_s3() on Aurora
    const exportFn = new lambda.Function(this, 'SpendLogExporterFn', {
      functionName: `${PROJECT_NAME}-spend-log-exporter`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('lambda/spend-log-exporter', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp handler.py /asset-output/',
          ],
          local: {
            tryBundle(outputDir: string) {
              const { execSync } = require('child_process');
              try {
                execSync(`pip install -r lambda/spend-log-exporter/requirements.txt -t ${outputDir} && cp lambda/spend-log-exporter/handler.py ${outputDir}/`);
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecretArn,
        DB_NAME: 'litellm',
        S3_BUCKET_NAME: targetBucketName,
        S3_PREFIX: 'spend-logs',
        S3_REGION: cdk.Aws.REGION,
        ...(props.s3ExportKeyArn && { S3_KMS_KEY_ARN: props.s3ExportKeyArn }),
      },
    });

    // Lambda needs to read DB credentials from Secrets Manager
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn],
    }));

    // EventBridge: run every hour
    new events.Rule(this, 'HourlyExportRule', {
      ruleName: `${PROJECT_NAME}-spend-log-export`,
      schedule: events.Schedule.cron({ minute: '5' }),
      targets: [new targets.LambdaFunction(exportFn)],
    });

    new cdk.CfnOutput(this, 'ExportBucketName', {
      value: targetBucketName,
      description: 'S3 bucket for spend log exports',
    });
  }
}
