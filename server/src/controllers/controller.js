import { ingestDocuments } from "../rag/ingest1.js";
import { retrieveDocuments } from "../rag/retrieve.js";
import { generateAnswer } from "../rag/generate.js";
import { parseGithubURL, getRepository, getRepositoryTree, getUsefulFiles } from "../github/downloadRepo.js";


export async function ingestController(req, res) {
    // Enable Server-Sent Events (SSE) streaming for real-time batch progress
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const { githubUrl } = req.body;
        if (!githubUrl) {
            sendEvent({ type: 'error', error: 'GitHub URL is required' });
            return res.end();
        }

        const { owner, repo } = parseGithubURL(githubUrl);
        console.log("Owner:", owner);
        console.log("Repo:", repo);

        sendEvent({ type: 'status', message: 'Connecting to GitHub API...' });

        const repository = await getRepository(owner, repo);
        const tree = await getRepositoryTree(
            owner,
            repo,
            repository.default_branch
        );
        const files = await getUsefulFiles(
            owner,
            repo,
            tree
        );

        console.log(`Downloaded ${files.length} files`);
        sendEvent({ type: 'status', message: `Downloaded ${files.length} files. Splitting codebase into chunks...` });

        const chunksCount = await ingestDocuments(files, (progressData) => {
            sendEvent(progressData);
        });

        sendEvent({
            type: "complete",
            message: "Repository ingested successfully",
            repository: `${owner}/${repo}`,
            files: files.length,
            chunks: chunksCount,
            percent: 100
        });

        res.end();

    } catch (error) {
        console.error("[ERROR] Ingestion failed:", error);
        sendEvent({
            type: "error",
            error: error.message || "Ingestion failed"
        });
        res.end();
    }
}

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