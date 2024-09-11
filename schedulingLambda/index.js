const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

// Initialize DynamoDB and Lambda clients
const dynamoClient = new DynamoDBClient();
const lambdaClient = new LambdaClient();

exports.handler = async () => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30));

  const params = {
    TableName: process.env.TABLE_NAME
  };

  try {
    // Scan the DynamoDB table
    const result = await dynamoClient.send(new ScanCommand(params));
    const totalItemsScanned = result.Items?.length || 0;
    
    console.log(`Total items scanned: ${totalItemsScanned}`);

    if (totalItemsScanned > 0) {
      result.Items.forEach((item) => {
        const itemTimestamp = item.updateTime?.S || 'N/A'; // Assuming "updateTime" field exists
        const itemID = item.itemID?.S || 'N/A'; // Assuming "itemID" field exists
        console.log(`Scanned item with ID: ${itemID}, updateTime: ${itemTimestamp}`);
      });
    }

    // Filter items older than 30 days
    const itemsToProcess = result.Items?.filter(item => {
      const itemTimestamp = new Date(item.updateTime.S); // Assuming updateTime is in string format
      return itemTimestamp < thirtyDaysAgo;
    });

    if (itemsToProcess && itemsToProcess.length > 0) {
      console.log(`Found ${itemsToProcess.length} items older than 30 days`);
      
      // Invoke the rotation Lambda for each item older than 30 days
      for (const item of itemsToProcess) {
        const invokeParams = {
          FunctionName: process.env.ROTATION_LAMBDA_ARN,
          Payload: JSON.stringify({
            APIGWKeyID: item.APIGWKeyID.S,
            usagePlanID: item.usagePlanID.S,
            itemID: item.itemID.S,
          })
        };
        await lambdaClient.send(new InvokeCommand(invokeParams));
      }
    } else {
      console.log("No items older than 30 days were found.");
    }

  } catch (error) {
    console.error("Error scanning DynamoDB table:", error);
  }
};
