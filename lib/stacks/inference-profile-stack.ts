import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';
import { PROJECT_NAME, MODELS } from '../config/constants';

export class InferenceProfileStack extends cdk.NestedStack {
  public readonly opus47Arn: string;
  public readonly opus46Arn: string;
  public readonly sonnet46Arn: string;
  public readonly haiku45Arn: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const profileDefs = [
      { id: 'Opus47', systemProfileId: MODELS.OPUS_4_7, suffix: 'opus-4-7' },
      { id: 'Opus46', systemProfileId: MODELS.OPUS_4_6, suffix: 'opus-4-6' },
      { id: 'Sonnet46', systemProfileId: MODELS.SONNET_4_6, suffix: 'sonnet-4-6' },
      { id: 'Haiku45', systemProfileId: MODELS.HAIKU_4_5, suffix: 'haiku-4-5' },
    ];

    const profiles: Record<string, bedrock.CfnApplicationInferenceProfile> = {};

    for (const def of profileDefs) {
      profiles[def.id] = new bedrock.CfnApplicationInferenceProfile(this, def.id, {
        inferenceProfileName: `${PROJECT_NAME}-${def.suffix}`,
        modelSource: {
          copyFrom: `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${def.systemProfileId}`,
        },
        tags: [
          { key: 'Project', value: PROJECT_NAME },
          { key: 'Model', value: def.suffix },
        ],
      });
    }

    this.opus47Arn = profiles['Opus47'].attrInferenceProfileArn;
    this.opus46Arn = profiles['Opus46'].attrInferenceProfileArn;
    this.sonnet46Arn = profiles['Sonnet46'].attrInferenceProfileArn;
    this.haiku45Arn = profiles['Haiku45'].attrInferenceProfileArn;
  }
}
