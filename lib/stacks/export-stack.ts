import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../config/constants';

export interface ExportStackProps {
  vpc: ec2.IVpc;
  lambdaSg: ec2.ISecurityGroup;
  dbCluster: rds.DatabaseCluster;
  logBucket: s3.Bucket;
}

export class ExportStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: ExportStackProps) {
    super(scope, id);

    // IAM Role for Aurora to write directly to S3 via aws_s3 extension
    const auroraS3Role = new iam.Role(this, 'AuroraS3ExportRole', {
      roleName: `${PROJECT_NAME}-aurora-s3-export`,
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
    });
    props.logBucket.grantWrite(auroraS3Role);

    // Associate the IAM role with the Aurora cluster
    const cfnCluster = props.dbCluster.node.defaultChild as rds.CfnDBCluster;
    cfnCluster.addPropertyOverride('AssociatedRoles', [
      {
        RoleArn: auroraS3Role.roleArn,
        FeatureName: 's3Export',
      },
    ]);

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
        DB_SECRET_ARN: props.dbCluster.secret!.secretArn,
        DB_NAME: 'litellm',
        S3_BUCKET_NAME: props.logBucket.bucketName,
        S3_PREFIX: 'spend-logs',
        S3_REGION: cdk.Aws.REGION,
      },
    });

    // Lambda needs to read DB credentials from Secrets Manager
    props.dbCluster.secret!.grantRead(exportFn);

    // EventBridge: run every hour
    new events.Rule(this, 'HourlyExportRule', {
      ruleName: `${PROJECT_NAME}-spend-log-export`,
      schedule: events.Schedule.cron({ minute: '5' }),
      targets: [new targets.LambdaFunction(exportFn)],
    });

    new cdk.CfnOutput(this, 'ExportBucketName', {
      value: props.logBucket.bucketName,
      description: 'S3 bucket for spend log exports',
    });
  }
}
