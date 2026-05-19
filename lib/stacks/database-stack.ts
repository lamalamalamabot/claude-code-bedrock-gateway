import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { PROJECT_NAME, SPEND_LOG_BUCKET_PREFIX } from '../config/constants';

export interface DatabaseStackProps {
  vpc: ec2.IVpc;
  rdsSg: ec2.ISecurityGroup;
}

export class DatabaseStack extends cdk.NestedStack {
  public readonly cluster: rds.DatabaseCluster;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id);

    // IAM Role for Aurora to write to S3 via aws_s3 extension
    const externalBucket = this.node.tryGetContext('spendLogExportBucket') as string | undefined;
    const targetBucketName = externalBucket || `${SPEND_LOG_BUCKET_PREFIX}-${cdk.Aws.ACCOUNT_ID}`;

    const auroraS3Role = new iam.Role(this, 'AuroraS3ExportRole', {
      roleName: `${PROJECT_NAME}-aurora-s3-export`,
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
    });
    auroraS3Role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
      resources: [`arn:aws:s3:::${targetBucketName}/*`],
    }));

    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_15,
      }),
      serverlessV2MinCapacity: 2,
      serverlessV2MaxCapacity: 16,
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
