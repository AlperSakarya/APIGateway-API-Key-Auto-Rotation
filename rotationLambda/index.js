const { APIGatewayClient, DeleteApiKeyCommand, CreateApiKeyCommand, CreateUsagePlanKeyCommand } = require("@aws-sdk/client-api-gateway");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");

const apiGatewayClient = new APIGatewayClient();
const dynamoDBClient = new DynamoDBClient();

exports.handler = async (event) => {
    console.log("Received event:", JSON.stringify(event, null, 2));

    const { APIGWKeyID, usagePlanID, itemID } = event;

    if (!APIGWKeyID || !usagePlanID || !itemID) {
        throw new Error("Missing required parameters: APIGWKeyID, usagePlanID, itemID,");
    }

    try {
        // Step 1: Delete the old API Gateway API key
        console.log(`Deleting API Key with ID: ${APIGWKeyID}`);
        const deleteApiKeyCommand = new DeleteApiKeyCommand({ apiKey: APIGWKeyID });
        await apiGatewayClient.send(deleteApiKeyCommand);
        console.log(`API Key ${APIGWKeyID} deleted successfully.`);

        // Step 2: Create a new API Gateway API key
        console.log("Creating a new API Key...");
        const createApiKeyCommand = new CreateApiKeyCommand({
            enabled: true,
            generateDistinctId: true,
            name: "RotatedAPIKey",
        });
        const newApiKeyResponse = await apiGatewayClient.send(createApiKeyCommand);
        const newApiKeyID = newApiKeyResponse.id;
        const newApiKeyValue = newApiKeyResponse.value;
        console.log(`New API Key created with ID: ${newApiKeyID}, Value: ${newApiKeyValue}`);

        // Step 3: Associate the new API key with the usage plan
        console.log(`Associating new API Key with Usage Plan ID: ${usagePlanID}`);
        const createUsagePlanKeyCommand = new CreateUsagePlanKeyCommand({
            usagePlanId: usagePlanID,
            keyId: newApiKeyID,
            keyType: "API_KEY",
        });
        await apiGatewayClient.send(createUsagePlanKeyCommand);
        console.log(`New API Key ${newApiKeyID} associated with Usage Plan ${usagePlanID}.`);

        // Step 4: Update DynamoDB with the new API key (name and value)
        console.log(`Updating DynamoDB item with key: ${itemID}`);
        const updateTime = new Date().toISOString();  // Current timestamp in ISO 8601 format (UTC)

        const updateItemCommand = new UpdateItemCommand({
            TableName: process.env.TABLE_NAME,  // Read table name from environment variable
            Key: { "itemID": { S: itemID } },  // Use "itemID" as the primary key name
            UpdateExpression: "SET APIGWKeyID = :newApiKeyID, APIKeyValue = :newApiKeyValue, updateTime =:updateTime ",
            ExpressionAttributeValues: {
                ":newApiKeyID": { S: newApiKeyID },
                ":newApiKeyValue": { S: newApiKeyValue },
                ":updateTime": { S: updateTime }
            },
        });
        await dynamoDBClient.send(updateItemCommand);
        console.log(`DynamoDB item with key ${itemID} updated successfully.`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "API Key rotation successful",
                newApiKeyID: newApiKeyID,
                newApiKeyValue: newApiKeyValue
            }),
        };
    } catch (error) {
        console.error("Error during API key rotation process:", error);
        throw new Error(`API Key rotation failed: ${error.message}`);
    }
};
