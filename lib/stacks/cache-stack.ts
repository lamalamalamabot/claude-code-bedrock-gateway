import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../config/constants';

export interface CacheStackProps {
  vpc: ec2.IVpc;
  cacheSg: ec2.ISecurityGroup;
}

// ElastiCache Serverless for Redis: backs LiteLLM's virtual-key auth cache
// (litellm_settings.enable_redis_auth_cache) to reduce per-request Aurora lookups
// across ECS replicas. Not used for LLM response caching (Bedrock passthrough
// traffic bypasses LiteLLM's response cache).
export class CacheStack extends cdk.NestedStack {
  public readonly cache: elasticache.CfnServerlessCache;

  constructor(scope: Construct, id: string, props: CacheStackProps) {
    super(scope, id);

    this.cache = new elasticache.CfnServerlessCache(this, 'RedisServerless', {
      engine: 'redis',
      serverlessCacheName: `${PROJECT_NAME}-redis`,
      description: 'Virtual-key auth cache for LiteLLM proxy',
      securityGroupIds: [props.cacheSg.securityGroupId],
      subnetIds: props.vpc.isolatedSubnets.map((s) => s.subnetId),
    });
  }
}
