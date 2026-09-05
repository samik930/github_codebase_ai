import "dotenv/config";

import express from "express";
import cors from "cors";

import { ingestDocuments } from "./rag/ingest.js";
import { retrieveDocuments } from "./rag/retrieve.js";
import { generateAnswer } from "./rag/generate.js";
import { parseGithubURL, getRepository, getRepositoryTree, getUsefulFiles } from "./github/downloadRepo.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        message: "Codebase Copilot is running"
    });
});

app.post("/ingest", async (req, res) => {

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
        await ingestDocuments(files);

        res.json({
            message: "Repository ingested successfully",
            repository: `${owner}/${repo}`,
            files : files.length,
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Ingestion failed"
        });
    }
});

app.post("/query", async (req, res) => {

    try {

        const { question } = req.body;

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
});

app.listen(5000, () => {
    console.log(
        "Server running on http://localhost:5000"
    );
});