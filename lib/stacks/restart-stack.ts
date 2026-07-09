import * as cdk from 'aws-cdk-lib';
import { TimeZone } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../config/constants';

export interface RestartStackProps {
  ecsService: ecs.FargateService;
  vpc: ec2.IVpc;
  lambdaSg: ec2.ISecurityGroup;
  dbSecretArn: string;
}

/**
 * Daily maintenance at 04:00 KST:
 *   1. Rolling restart of the LiteLLM Fargate service.
 *   2. Retention cleanup of old LiteLLM_SpendLogs rows (keep last N days).
 *
 * Restart: the service shows gradual performance degradation over long
 * uptimes (root cause unidentified — likely a slow leak). A daily rolling
 * restart clears it. We call ecs:UpdateService with forceNewDeployment=true,
 * which spins up fresh tasks, waits for health checks, then drains the old
 * ones — zero-downtime, no Lambda required. The service already has a
 * deployment circuit breaker with rollback, so a bad restart self-heals.
 *
 * Cleanup: spend log rows accumulate on every request (prompt/response bodies
 * are already disabled, but the rows themselves keep growing). A daily batched
 * DELETE keeps only the recent window; autovacuum reclaims the freed space for
 * reuse so the table settles at a steady size. Runs on its own EventBridge
 * schedule (5 min after the restart) rather than the restart's scheduler so
 * DB work never blocks or races the service replacement.
 */
export class RestartStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: RestartStackProps) {
    super(scope, id);

    const cluster = props.ecsService.cluster;

    // --- 1. Daily rolling restart of the Fargate service (04:00 KST) ---
    new scheduler.Schedule(this, 'DailyRestartSchedule', {
      scheduleName: `${PROJECT_NAME}-daily-restart`,
      description: 'Daily rolling restart of the LiteLLM Fargate service at 04:00 KST',
      // 04:00 every day, interpreted in Asia/Seoul (no manual UTC offset, DST-safe).
      schedule: scheduler.ScheduleExpression.cron({
        minute: '0',
        hour: '4',
        day: '*',
        month: '*',
        year: '*',
        timeZone: TimeZone.ASIA_SEOUL,
      }),
      target: new schedulerTargets.Universal({
        service: 'ecs',
        action: 'updateService',
        input: scheduler.ScheduleTargetInput.fromObject({
          Cluster: cluster.clusterArn,
          Service: props.ecsService.serviceArn,
          ForceNewDeployment: true,
        }),
        // Universal's default policy grants only `ecs:updateService`. ECS
        // UpdateService additionally requires tag permissions when the service
        // has managed tags / tag propagation, so grant them explicitly.
        policyStatements: [
          new iam.PolicyStatement({
            actions: ['ecs:UpdateService'],
            resources: [props.ecsService.serviceArn],
          }),
          new iam.PolicyStatement({
            actions: ['ecs:TagResource'],
            resources: ['*'],
            conditions: {
              StringEquals: { 'ecs:CreateAction': 'UpdateService' },
            },
          }),
        ],
      }),
    });

    // --- 2. Daily spend-log retention cleanup (04:05 KST) ---
    const cleanerFn = new lambda.Function(this, 'SpendLogCleanerFn', {
      functionName: `${PROJECT_NAME}-spend-log-cleaner`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('lambda/spend-log-cleaner', {
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
                execSync(`pip install -r lambda/spend-log-cleaner/requirements.txt -t ${outputDir} && cp lambda/spend-log-cleaner/handler.py ${outputDir}/`);
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      memorySize: 256,
      // Batched DELETE loop can run a while on a large backlog; give it room.
      timeout: cdk.Duration.minutes(15),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecretArn,
        DB_NAME: 'litellm',
        RETENTION_DAYS: '2',
        BATCH_SIZE: '5000',
      },
    });

    cleanerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn],
    }));

    // Runs 5 min after the restart so DB work never contends with the service
    // replacement. Same timezone-aware scheduler as the restart (Asia/Seoul).
    new scheduler.Schedule(this, 'DailyCleanupSchedule', {
      scheduleName: `${PROJECT_NAME}-spend-log-cleanup`,
      description: 'Daily retention cleanup of LiteLLM_SpendLogs at 04:05 KST (keep last 2 days)',
      schedule: scheduler.ScheduleExpression.cron({
        minute: '5',
        hour: '4',
        day: '*',
        month: '*',
        year: '*',
        timeZone: TimeZone.ASIA_SEOUL,
      }),
      target: new schedulerTargets.LambdaInvoke(cleanerFn),
    });
  }
}
