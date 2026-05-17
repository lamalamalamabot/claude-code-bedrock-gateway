import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../config/constants';

export class NetworkStack extends cdk.NestedStack {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly ecsSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;
  public readonly lambdaSg: ec2.SecurityGroup;
  public readonly vpcEndpointSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // VPC: 2 AZ, 3 subnet tiers, 1 NAT Gateway (cost optimized)
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${PROJECT_NAME}-vpc`,
      maxAzs: 2,
      natGateways: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // --- Security Groups ---

    // ALB: inbound 80 (dev) and 443 (production) from anywhere
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: `${PROJECT_NAME}-alb-sg`,
      description: 'ALB security group - HTTP/HTTPS inbound',
      allowAllOutbound: true,
    });
    this.albSg.addIngressRule(
      ec2.Peer.ipv4('1.2.3.4/32'),
      ec2.Port.tcp(80),
      'Allow HTTP - change to your IP',
    );
    this.albSg.addIngressRule(
      ec2.Peer.ipv4('1.2.3.4/32'),
      ec2.Port.tcp(443),
      'Allow HTTPS - change to your IP',
    );

    // ECS: inbound 4000 from ALB only
    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      securityGroupName: `${PROJECT_NAME}-ecs-sg`,
      description: 'ECS tasks security group - LiteLLM port',
      allowAllOutbound: true,
    });
    this.ecsSg.addIngressRule(
      this.albSg,
      ec2.Port.tcp(4000),
      'Allow LiteLLM traffic from ALB',
    );

    // Lambda: outbound only
    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      securityGroupName: `${PROJECT_NAME}-lambda-sg`,
      description: 'Lambda security group - outbound only',
      allowAllOutbound: true,
    });

    // RDS: inbound 5432 from ECS and Lambda
    this.rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: this.vpc,
      securityGroupName: `${PROJECT_NAME}-rds-sg`,
      description: 'RDS security group - PostgreSQL port',
      allowAllOutbound: false,
    });
    this.rdsSg.addIngressRule(
      this.ecsSg,
      ec2.Port.tcp(5432),
      'Allow PostgreSQL from ECS',
    );
    this.rdsSg.addIngressRule(
      this.lambdaSg,
      ec2.Port.tcp(5432),
      'Allow PostgreSQL from Lambda',
    );

    // VPC Endpoint SG: inbound 443 from ECS
    this.vpcEndpointSg = new ec2.SecurityGroup(this, 'VpcEndpointSg', {
      vpc: this.vpc,
      securityGroupName: `${PROJECT_NAME}-vpce-sg`,
      description: 'VPC Endpoint security group - HTTPS from ECS',
      allowAllOutbound: false,
    });
    this.vpcEndpointSg.addIngressRule(
      this.ecsSg,
      ec2.Port.tcp(443),
      'Allow HTTPS from ECS tasks',
    );

    // --- VPC Endpoints ---

    // Interface Endpoint: bedrock-runtime (required for security & performance)
    this.vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.vpcEndpointSg],
    });

    // Gateway Endpoints: S3 and DynamoDB (free)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Aurora (aws_s3 extension) needs outbound HTTPS to S3 via Gateway Endpoint.
    // Isolated subnet has no internet route, so this only reaches S3.
    this.rdsSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS to S3 for aws_s3 export',
    );

    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });
  }
}
