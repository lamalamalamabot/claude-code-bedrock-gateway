import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../config/constants';

export interface MonitoringStackProps {
  ecsClusterName: string;
  ecsServiceName: string;
  albFullName: string;
}

export class MonitoringStack extends cdk.NestedStack {
  public readonly auditTable: dynamodb.Table;
  public readonly configTable: dynamodb.Table;
  public readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id);

    // --- DynamoDB: Audit Table ---
    this.auditTable = new dynamodb.Table(this, 'AuditTable', {
      tableName: 'llm-gateway-audit',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiry',
    });

    this.auditTable.addGlobalSecondaryIndex({
      indexName: 'teamId-index',
      partitionKey: { name: 'teamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    });

    // --- DynamoDB: Config Table ---
    this.configTable = new dynamodb.Table(this, 'ConfigTable', {
      tableName: 'llm-gateway-config',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- SNS Topic ---
    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: 'llm-gateway-alerts',
      displayName: 'LLM Gateway Alerts',
    });

    // --- CloudWatch Dashboard ---
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'LLMGateway-Operations',
    });

    // ECS Metrics
    const ecsCpuMetric = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      dimensionsMap: {
        ClusterName: props.ecsClusterName,
        ServiceName: props.ecsServiceName,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });

    const ecsMemoryMetric = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'MemoryUtilization',
      dimensionsMap: {
        ClusterName: props.ecsClusterName,
        ServiceName: props.ecsServiceName,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });

    // ALB Metrics
    const albRequestCount = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'RequestCount',
      dimensionsMap: { LoadBalancer: props.albFullName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const alb5xxCount = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_5XX_Count',
      dimensionsMap: { LoadBalancer: props.albFullName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const albResponseTimeP50 = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensionsMap: { LoadBalancer: props.albFullName },
      statistic: 'p50',
      period: cdk.Duration.minutes(5),
    });

    const albResponseTimeP95 = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensionsMap: { LoadBalancer: props.albFullName },
      statistic: 'p95',
      period: cdk.Duration.minutes(5),
    });

    const albResponseTimeP99 = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensionsMap: { LoadBalancer: props.albFullName },
      statistic: 'p99',
      period: cdk.Duration.minutes(5),
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ECS CPU Utilization',
        left: [ecsCpuMetric],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS Memory Utilization',
        left: [ecsMemoryMetric],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ALB Request Count',
        left: [albRequestCount],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB 5XX Errors',
        left: [alb5xxCount],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB Response Time (p50/p95/p99)',
        left: [albResponseTimeP50, albResponseTimeP95, albResponseTimeP99],
        width: 8,
      }),
    );

    // --- CloudWatch Alarms ---

    // ECS CPU > 80% for 5 minutes
    const cpuAlarm = new cloudwatch.Alarm(this, 'EcsCpuAlarm', {
      alarmName: `${PROJECT_NAME}-ecs-cpu-high`,
      alarmDescription: 'ECS CPU utilization exceeds 80% for 5 minutes',
      metric: ecsCpuMetric,
      threshold: 80,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cpuAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.alertsTopic));

    // ALB 5xx > 10 in 5 minutes
    const error5xxAlarm = new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmName: `${PROJECT_NAME}-alb-5xx-high`,
      alarmDescription: 'ALB 5XX error count exceeds 10 in 5 minutes',
      metric: alb5xxCount,
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    error5xxAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.alertsTopic));
  }
}
