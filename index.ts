import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as random from "@pulumi/random";

// Generate a unique UUID for the item
const itemID = new random.RandomUuid("itemID");

// Create an IAM role for the Lambda function
const lambdaRole = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});

// Attach the basic execution policy to the role
const lambdaRolePolicyAttachment = new aws.iam.RolePolicyAttachment("lambdaRolePolicyAttachment", {
    role: lambdaRole,
    policyArn: aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
});

// Create a custom policy for logging, DynamoDB access, and Lambda invocation, and attach it to the role
// These are loose privileges!!! - the lambda role should be broken down by each lambda and Resource should be ARNs only not *
const lambdaPolicy = new aws.iam.RolePolicy("lambdaPolicy", {
    role: lambdaRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Action: "logs:*",
                Resource: "*",
                Effect: "Allow",
            },
            {
                Action: [
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:DeleteItem",
                    "dynamodb:GetItem",
                    "dynamodb:Scan",
                    "dynamodb:Query"
                ],
                Resource: "*", // You might want to restrict this to the specific table ARN
                Effect: "Allow",
            },
            {
                Action: [
                    "apigateway:GET",
                    "apigateway:POST",
                    "apigateway:DELETE"
                ],
                Resource: "*", // You might want to restrict this to the specific API Gateway ARN
                Effect: "Allow",
            },
            {
                Action: [
                    "lambda:InvokeFunction"
                ],
                Resource: "*", // You might want to restrict this to specific Lambda ARNs
                Effect: "Allow",
            }
        ],
    }),
});

// Create the first Lambda function
const getCartLambda = new aws.lambda.Function("getCartLambda", {
    runtime: "nodejs18.x",
    role: lambdaRole.arn,
    handler: "index.handler",
    code: new pulumi.asset.AssetArchive({
        ".": new pulumi.asset.FileArchive("./lambda"),
    }),
    environment: {
        variables: {
            "ENV": "production",
        },
    },
});

// Create an API Gateway
const api = new aws.apigateway.RestApi("cartApi", {
    description: "API Gateway for Cart Service",
});

// Create the /getcart resource
const getCartResource = new aws.apigateway.Resource("getCartResource", {
    restApi: api.id,
    parentId: api.rootResourceId,
    pathPart: "getcart",
});

// Create the GET method
const getMethod = new aws.apigateway.Method("getMethod", {
    restApi: api.id,
    resourceId: getCartResource.id,
    httpMethod: "GET",
    authorization: "NONE",
    apiKeyRequired: true,
});

// Lambda integration for GET method
const lambdaIntegration = new aws.apigateway.Integration("getLambdaIntegration", {
    restApi: api.id,
    resourceId: getCartResource.id,
    httpMethod: getMethod.httpMethod,
    integrationHttpMethod: "POST",
    type: "AWS_PROXY",
    uri: getCartLambda.invokeArn,
});

// Create an API Key
const apiKey = new aws.apigateway.ApiKey("cartApiKey", {
    description: "API key for cart service",
    enabled: true,
});

// Create a unique API Stage
const stage = new aws.apigateway.Stage("cartStage", {
    restApi: api.id,
    stageName: pulumi.interpolate`prod-${pulumi.getStack()}`, // Ensure the stage name is unique
    deployment: new aws.apigateway.Deployment("cartDeployment", {
        restApi: api.id,
        stageName: pulumi.interpolate`prod1-${pulumi.getStack()}`, // Ensure the stage name is unique
        triggers: {
            redeployment: pulumi.all([getMethod.id, lambdaIntegration.id]).apply(([methodId, integrationId]) => `${methodId}-${integrationId}`),
        },
    }).id,
});

// Create a Usage Plan
const usagePlan = new aws.apigateway.UsagePlan("cartUsagePlan", {
    description: "Usage plan for Cart API",
    apiStages: [{
        apiId: api.id,
        stage: stage.stageName,
    }],
    throttleSettings: {
        rateLimit: 100,
        burstLimit: 200,
    },
    quotaSettings: {
        limit: 10000,
        period: "MONTH",
    },
});

// Associate API Key with the Usage Plan
new aws.apigateway.UsagePlanKey("cartUsagePlanKey", {
    keyId: apiKey.id,
    keyType: "API_KEY",
    usagePlanId: usagePlan.id,
});

// Grant permissions to API Gateway to invoke the Lambda function
new aws.lambda.Permission("apiLambdaPermission", {
    action: "lambda:InvokeFunction",
    function: getCartLambda.arn,
    principal: "apigateway.amazonaws.com",
    sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
});

// Create a DynamoDB table with indexed attributes
const table = new aws.dynamodb.Table("apiKeysTable", {
    attributes: [
        { name: "itemID", type: "S" },
        { name: "APIGWKeyID", type: "S" },
        { name: "usagePlanID", type: "S" }
    ],
    hashKey: "itemID",
    globalSecondaryIndexes: [
        {
            name: "usagePlanIDIndex",
            hashKey: "usagePlanID",
            projectionType: "ALL",
        },
        {
            name: "APIGWKeyIDIndex",
            hashKey: "APIGWKeyID",
            projectionType: "ALL",
        },
    ],
    billingMode: "PAY_PER_REQUEST",
});


// Ensure the table is created before adding items
const tableCreation = table.id.apply(id => id);

// Get the current timestamp in ISO 8601 format
const updateTime = new Date().toISOString();

// Put the API key and usage plan ID into the DynamoDB table
const putItem = new aws.dynamodb.TableItem("apiKeyItem", {
    tableName: table.name,
    hashKey: itemID.result,
    item: pulumi.interpolate`{
        "itemID": {"S": "${itemID.result}"},
        "APIGWKeyID": {"S": "${apiKey.id}"},
        "APIKeyValue": {"S": "${apiKey.value}"},
        "usagePlanID": {"S": "${usagePlan.id}"},
        "updateTime": {"S": "${updateTime}"}
    }`,
});

export const tableName = table.name;

// Create the second Lambda function for API key and DynamoDB operations
const rotationLambda = new aws.lambda.Function("rotationLambda", {
    runtime: "nodejs18.x",
    role: lambdaRole.arn,
    handler: "index.handler",
    code: new pulumi.asset.AssetArchive({
        ".": new pulumi.asset.FileArchive("./rotationLambda"),
    }),
    environment: {
        variables: {
            "ENV": "production",
            "TABLE_NAME": table.name, 
        },
    },
});


// Create the second Lambda function for API key and DynamoDB operations
const schedulingLambda = new aws.lambda.Function("schedulingLambda", {
    runtime: "nodejs18.x",
    role: lambdaRole.arn,
    handler: "index.handler",
    code: new pulumi.asset.AssetArchive({
        ".": new pulumi.asset.FileArchive("./schedulingLambda"),
    }),
    environment: {
        variables: {
            "ENV": "production",
            "TABLE_NAME": table.name, 
            "ROTATION_LAMBDA_ARN": rotationLambda.arn,
        },
    },
});

// Create an EventBridge rule to trigger the schedulingLambda every 30 days
const eventRule = new aws.cloudwatch.EventRule("schedulingRule", {
    scheduleExpression: "rate(30 days)",
});

// Add the schedulingLambda as the target for the EventBridge rule
const eventTarget = new aws.cloudwatch.EventTarget("schedulingTarget", {
    rule: eventRule.name,
    arn: schedulingLambda.arn,
});

// Grant permissions for EventBridge to invoke the schedulingLambda
new aws.lambda.Permission("eventBridgePermission", {
    action: "lambda:InvokeFunction",
    function: schedulingLambda.arn,
    principal: "events.amazonaws.com",
    sourceArn: eventRule.arn,
});


// Export stuff we may want to see
export const rotationLambdaARN = rotationLambda.arn;
export const apiUrl = pulumi.interpolate`${api.executionArn}/${stage.stageName}`;
export const apiKeyValue = apiKey.value;
