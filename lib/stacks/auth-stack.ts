import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { PROJECT_NAME } from '../config/constants';

export class AuthStack extends cdk.NestedStack {
  public readonly api: apigateway.RestApi;
  public readonly tokenServiceFunction: lambda.Function;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Token Service Lambda (VPC 외부 - 인터넷 경유로 Public ALB 접근)
    this.tokenServiceFunction = new lambda.Function(this, 'TokenServiceFn', {
      functionName: `${PROJECT_NAME}-token-service`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('lambda/token-service'),
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {},
    });

    // API Gateway with IAM auth
    this.api = new apigateway.RestApi(this, 'TokenServiceApi', {
      restApiName: `${PROJECT_NAME}-token-service`,
      description: 'Token Service API - issues JWT from SSO credentials',
      deployOptions: {
        stageName: 'v1',
      },
    });

    const authResource = this.api.root.addResource('auth');
    const tokenResource = authResource.addResource('token');

    tokenResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(this.tokenServiceFunction),
      {
        authorizationType: apigateway.AuthorizationType.IAM,
      },
    );

  }
}
