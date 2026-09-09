export async function queryController(req, res) {

    try {

        const {question} = req.body;

        if (!question) {
            return res.status(400).json({
                error: "Question is required"
            });
        }

        // 1. Retrieve
        const documents =
            await retrieveDocuments(question);

        // 2. Generate
        const result =
            await generateAnswer(question, documents);

        res.json(result);

    } catch (error) {

        console.error("[ERROR] Query execution failed:", error);

        res.status(500).json({
            error: "Query failed",
            message: error.message
        });
    }
}