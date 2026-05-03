import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../config/constants';

export interface DatabaseStackProps {
  vpc: ec2.IVpc;
  rdsSg: ec2.ISecurityGroup;
}

export class DatabaseStack extends cdk.NestedStack {
  public readonly cluster: rds.DatabaseCluster;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id);

    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_15,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        publiclyAccessible: false,
      }),
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
  }
}
