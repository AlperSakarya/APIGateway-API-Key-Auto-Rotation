exports.handler = async function(event) {
    return {
        statusCode: 200,
        body: "Hello, protected items. You can only see this if you passed the API key."
    };
};
