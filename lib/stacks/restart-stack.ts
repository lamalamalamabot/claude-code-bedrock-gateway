import * as cdk from 'aws-cdk-lib';
import { TimeZone } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../config/constants';

export interface RestartStackProps {
  ecsService: ecs.FargateService;
}

/**
 * Daily scheduled restart of the LiteLLM Fargate service.
 *
 * The service exhibits gradual performance degradation over long uptimes
 * (root cause unidentified — likely a slow leak). A daily rolling restart
 * clears it. We call ecs:UpdateService with forceNewDeployment=true, which
 * spins up fresh tasks, waits for health checks, then drains the old ones —
 * zero-downtime, no Lambda required. The service already has a deployment
 * circuit breaker with rollback enabled, so a bad restart self-heals.
 */
export class RestartStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: RestartStackProps) {
    super(scope, id);

    const cluster = props.ecsService.cluster;

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
  }
}
