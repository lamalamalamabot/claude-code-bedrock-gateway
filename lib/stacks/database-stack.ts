import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { PROJECT_NAME, SPEND_LOG_BUCKET_PREFIX } from '../config/constants';

export interface DatabaseStackProps {
  vpc: ec2.IVpc;
  rdsSg: ec2.ISecurityGroup;
  spendLogExportBucket?: string;
  spendLogExportAccountId?: string;
}

export class DatabaseStack extends cdk.NestedStack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly s3ExportKey: kms.IKey | undefined;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id);

    const externalBucket = props.spendLogExportBucket;
    const externalAccountId = props.spendLogExportAccountId;
    const targetBucketName = externalBucket || `${SPEND_LOG_BUCKET_PREFIX}-${cdk.Aws.ACCOUNT_ID}`;

    // KMS key for S3 export encryption (only when exporting to external account)
    if (externalAccountId) {
      this.s3ExportKey = new kms.Key(this, 'S3ExportKey', {
        alias: `${PROJECT_NAME}/s3-export`,
        description: 'Encrypts Aurora S3 exports for cross-account access',
        policy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'KeyAdmin',
              actions: ['kms:*'],
              principals: [new iam.AccountRootPrincipal()],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'TargetAccountDecrypt',
              actions: ['kms:Decrypt', 'kms:DescribeKey'],
              principals: [new iam.AccountPrincipal(externalAccountId)],
              resources: ['*'],
            }),
          ],
        }),
      });
    }

    // IAM Role for Aurora to write to S3 via aws_s3 extension
    const auroraS3Role = new iam.Role(this, 'AuroraS3ExportRole', {
      roleName: `${PROJECT_NAME}-aurora-s3-export`,
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
    });
    auroraS3Role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
      resources: [`arn:aws:s3:::${targetBucketName}/*`],
    }));

    if (this.s3ExportKey) {
      auroraS3Role.addToPolicy(new iam.PolicyStatement({
        actions: ['kms:GenerateDataKey', 'kms:Encrypt', 'kms:Decrypt'],
        resources: [this.s3ExportKey.keyArn],
      }));
    }

    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_15,
      }),
      serverlessV2MinCapacity: 2,
      serverlessV2MaxCapacity: 64,
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        publiclyAccessible: false,
      }),
      readers: [
        rds.ClusterInstance.serverlessV2('Reader', {
          publiclyAccessible: false,
          scaleWithWriter: true,
        }),
      ],
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.rdsSg],
      defaultDatabaseName: 'litellm',
      credentials: rds.Credentials.fromGeneratedSecret('litellm_admin', {
        secretName: `${PROJECT_NAME}/aurora-credentials`,
      }),
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Associate S3 export role with Aurora cluster
    const cfnCluster = this.cluster.node.defaultChild as rds.CfnDBCluster;
    cfnCluster.addPropertyOverride('AssociatedRoles', [
      {
        RoleArn: auroraS3Role.roleArn,
        FeatureName: 's3Export',
      },
    ]);
  }
}
