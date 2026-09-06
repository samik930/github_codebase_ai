import { ingestDocuments } from "../rag/ingest1.js";
import { retrieveDocuments } from "../rag/retrieve.js";
import { generateAnswer } from "../rag/generate.js";
import { parseGithubURL, getRepository, getRepositoryTree, getUsefulFiles } from "../github/downloadRepo.js";


export async function ingestController(req, res) {
    try {
        const {githubUrl} = req.body
        const { owner, repo } = parseGithubURL(githubUrl);
        console.log("Owner:", owner);
        console.log("Repo:", repo);
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
        )
        console.log(`Downloaded ${files.length} files`);
        const chunksCount = await ingestDocuments(files);

        res.json({
            message: "Repository ingested successfully",
            repository: `${owner}/${repo}`,
            files : files.length,
            chunks : chunksCount,
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Ingestion failed"
        });
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