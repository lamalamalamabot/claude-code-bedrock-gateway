#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DEFAULT_REGION } from '../lib/config/constants';
import { RootStack } from '../lib/stacks/root-stack';

const app = new cdk.App();

new RootStack(app, 'LlmGatewayStack', {
  env: { region: DEFAULT_REGION },
});

app.synth();
