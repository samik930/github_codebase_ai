import { parseGithubURL, getRepository, getRepositoryTree, getUsefulFiles } from "../github/downloadRepo.js";

const PYTHON_API_URL = "http://127.0.0.1:8000";

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
        const repoId = `${owner}/${repo}`;
        console.log("Owner:", owner);
        console.log("Repo:", repo);
        console.log("Repo ID:", repoId);

        sendEvent({ type: 'status', message: 'Connecting to GitHub API...' });

        const repository = await getRepository(owner, repo);
        const treeResult = await getRepositoryTree(
            owner,
            repo,
            repository.default_branch
        );
        const commitHash = treeResult.sha || "";
        console.log("Commit Hash:", commitHash);

        const files = await getUsefulFiles(
            owner,
            repo,
            treeResult.tree
        );

        console.log(`Downloaded ${files.length} files`);
        sendEvent({ type: 'status', message: `Downloaded ${files.length} files. Splitting codebase into chunks...` });

        // Call Python Microservice for ingestion — include repo_id and commit_hash
        const response = await fetch(`${PYTHON_API_URL}/ingest`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files,
                repo_id: repoId,
                commit_hash: commitHash
            })
        });

        if (!response.ok) {
            throw new Error(`Python API responded with status ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
                const message = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                
                if (message.startsWith("data: ")) {
                    try {
                        const parsedData = JSON.parse(message.replace("data: ", ""));
                        // Enrich the complete event with repo identity, file count,
                        // and owner avatar so the frontend's activeRepo has all fields it needs
                        if (parsedData.type === 'complete') {
                            parsedData.repository = repoId;
                            parsedData.files = files.length;
                            parsedData.ownerAvatar = repository.owner?.avatar_url || null;
                            parsedData.commitHash = commitHash;
                        }
                        sendEvent(parsedData);
                    } catch (e) {
                        console.error("[WARN] Failed to parse SSE line:", message);
                    }
                }
                boundary = buffer.indexOf("\n\n");
            }
        }

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

        const { question, repo_id } = req.body;

        if (!question) {
            return res.status(400).json({
                error: "Question is required"
            });
        }

        if (!repo_id) {
            return res.status(400).json({
                error: "repo_id is required. Select a repository before querying."
            });
        }

        console.log(`[QUERY] repo_id=${repo_id}, question="${question}"`);

        // Call Python Microservice for query — include repo_id
        const response = await fetch(`${PYTHON_API_URL}/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ question, repo_id })
        });

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            throw new Error(errorBody.error || `Python API responded with status ${response.status}`);
        }

        const result = await response.json();

        res.json(result);

    } catch (error) {

        console.error("[ERROR] Query execution failed:", error);

        res.status(500).json({
            error: "Query failed",
            message: error.message
        });
    }
}

export async function repositoriesController(req, res) {
    try {
        const response = await fetch(`${PYTHON_API_URL}/repositories`);
        
        if (!response.ok) {
            throw new Error(`Python API responded with status ${response.status}`);
        }

        const result = await response.json();
        res.json(result);
    } catch (error) {
        console.error("[ERROR] Failed to fetch repositories:", error);
        res.status(500).json({
            error: "Failed to fetch repositories",
            message: error.message
        });
    }
}