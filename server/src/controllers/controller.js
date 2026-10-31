import { parseGithubURL, getRepository, getRepositoryTree, getUsefulFiles, getVisualFiles } from "../github/downloadRepo.js";
import { Repository } from "../models/Repository.js";
import { ChatMessage } from "../models/ChatMessage.js";
import { OAuth2Client } from "google-auth-library";

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
        const { githubUrl, userId, isDemo } = req.body;
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

        const visualFiles = await getVisualFiles(
            owner,
            repo,
            treeResult.tree,
            repository.default_branch || "main"
        );

        console.log(`Downloaded ${files.length} code files and ${visualFiles.length} visual assets`);
        sendEvent({ 
            type: 'status', 
            message: `Downloaded ${files.length} code files and ${visualFiles.length} visual assets. Processing multimodal content...` 
        });

        // Call Python Microservice for ingestion — include repo_id, commit_hash, files, and visual_files
        const response = await fetch(`${PYTHON_API_URL}/ingest`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files,
                visual_files: visualFiles,
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
                        if (parsedData.type === 'complete') {
                            parsedData.repository = repoId;
                            parsedData.files = files.length;
                            parsedData.visualFiles = visualFiles.length;
                            parsedData.ownerAvatar = repository.owner?.avatar_url || null;
                            parsedData.commitHash = commitHash;

                            // Persist repository metadata to MongoDB ONLY for real authenticated users (not Demo)
                            if (!isDemo && userId) {
                                try {
                                    await Repository.findOneAndUpdate(
                                        { userId: userId, repoId: repoId },
                                        {
                                            userId: userId,
                                            repoId: repoId,
                                            owner: owner,
                                            repo: repo,
                                            defaultBranch: repository.default_branch || "main",
                                            commitHash: commitHash,
                                            filesCount: files.length,
                                            visualCount: visualFiles.length,
                                            ownerAvatar: repository.owner?.avatar_url || null,
                                            indexedAt: new Date()
                                        },
                                        { upsert: true, new: true }
                                    );
                                    console.log(`[MONGODB] Saved repository '${repoId}' for user '${userId}'.`);
                                } catch (dbErr) {
                                    console.warn(`[MONGODB WARN] Could not persist repository: ${dbErr.message}`);
                                }
                            } else {
                                console.log(`[INGEST] Ingested in-memory for demo / session (not saved to MongoDB) for '${repoId}'.`);
                            }
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
        const { question, repo_id, no_save, userId, isDemo } = req.body;

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

        console.log(`[QUERY] repo_id=${repo_id}, question="${question}", user=${userId || 'guest'}, isDemo=${Boolean(isDemo)}`);

        // Call Python Microservice for query
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

        // Persist to MongoDB ONLY for real authenticated accounts (strict zero-save for demo)
        const shouldSave = !no_save && !isDemo && Boolean(userId);
        if (shouldSave) {
            try {
                await ChatMessage.create({
                    userId: userId,
                    repoId: repo_id,
                    role: "user",
                    content: question,
                    timestamp: new Date()
                });

                await ChatMessage.create({
                    userId: userId,
                    repoId: repo_id,
                    role: "assistant",
                    content: result.answer || "No response received.",
                    sources: result.sources || [],
                    telemetry: {
                        sourcesCount: (result.sources || []).length
                    },
                    timestamp: new Date()
                });
                console.log(`[MONGODB] Saved conversation turn for ${repo_id} (user: ${userId})`);
            } catch (dbErr) {
                console.warn(`[MONGODB WARN] Could not persist chat message: ${dbErr.message}`);
            }
        } else {
            console.log(`[DEMO USER / NO-SAVE] Query answered strictly in-memory. Zero DB persistence for ${repo_id}.`);
        }

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
        const { userId, isDemo } = req.query;

        // If Demo mode or unauthenticated, do NOT return another user's cloud repositories
        if (isDemo === 'true' || !userId) {
            return res.json({ repositories: [] });
        }

        // Query MongoDB for repositories indexed by this specific user
        const dbRepos = await Repository.find({ userId }).sort({ indexedAt: -1 }).lean();
        
        return res.json({
            repositories: (dbRepos || []).map(r => ({
                repo_id: r.repoId,
                owner: r.owner,
                repo: r.repo,
                files: r.filesCount,
                visual_files: r.visualCount,
                owner_avatar: r.ownerAvatar,
                commit_hash: r.commitHash,
                indexed_at: r.indexedAt
            }))
        });
    } catch (error) {
        console.error("[ERROR] Failed to fetch repositories:", error.message);
        res.json({ repositories: [] });
    }
}

export async function getChatHistoryController(req, res) {
    try {
        const { userId, isDemo } = req.query;
        const repoId = req.query.repo_id || req.params.repoId;

        // In demo mode or if no user, return empty messages array immediately (strict zero history)
        if (isDemo === 'true' || !userId) {
            return res.json({ messages: [] });
        }

        if (!repoId) {
            return res.status(400).json({ error: "repo_id is required", messages: [] });
        }

        const decodedRepoId = decodeURIComponent(repoId);

        const messages = await ChatMessage.find({ repoId: decodedRepoId, userId })
            .sort({ timestamp: 1 })
            .lean();

        res.json({
            messages: messages.map(m => ({
                id: m._id.toString(),
                role: m.role,
                content: m.content,
                sources: m.sources || [],
                telemetry: m.telemetry || {},
                timestamp: m.timestamp
            }))
        });
    } catch (error) {
        console.error("[ERROR] Failed to fetch chat history:", error.message);
        res.status(500).json({ error: "Failed to fetch chat history", messages: [] });
    }
}

export async function clearChatHistoryController(req, res) {
    try {
        const { userId, isDemo } = req.query;
        const repoId = req.query.repo_id || req.params.repoId;

        if (isDemo === 'true' || !userId) {
            return res.json({ success: true, message: "Demo history cleared locally" });
        }

        if (!repoId) {
            return res.status(400).json({ error: "repo_id is required" });
        }

        const decodedRepoId = decodeURIComponent(repoId);
        await ChatMessage.deleteMany({ repoId: decodedRepoId, userId });
        console.log(`[MONGODB] Cleared chat history for ${decodedRepoId} (user: ${userId})`);
        res.json({ success: true, message: `Chat history cleared for ${decodedRepoId}` });
    } catch (error) {
        console.error("[ERROR] Failed to clear chat history:", error.message);
        res.status(500).json({ error: "Failed to clear chat history" });
    }
}

export async function deleteRepositoryController(req, res) {
    try {
        const { userId } = req.query;
        const repoId = req.query.repo_id || req.params.repoId;

        if (!repoId) {
            return res.status(400).json({ error: "repo_id is required" });
        }

        const decodedRepoId = decodeURIComponent(repoId);
        const filter = userId ? { repoId: decodedRepoId, userId } : { repoId: decodedRepoId };

        await Repository.deleteOne(filter);
        await ChatMessage.deleteMany(filter);
        console.log(`[MONGODB] Removed repository and chats for ${decodedRepoId} (user: ${userId || 'all'})`);
        res.json({ success: true, message: `Repository ${decodedRepoId} deleted` });
    } catch (error) {
        console.error("[ERROR] Failed to delete repository:", error.message);
        res.status(500).json({ error: "Failed to delete repository" });
    }
}


const oauthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export async function googleAuthController(req, res) {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ error: "Missing Google ID token" });
        }

        const ticket = await oauthClient.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();
        const { sub, email, name, picture } = payload;

        console.log(`[AUTH] Google user verified: ${email} (${name})`);

        return res.json({
            success: true,
            user: {
                id: sub,
                name,
                email,
                avatar: picture,
                provider: 'google',
                isDemo: false
            }
        });
    } catch (err) {
        console.error("[AUTH ERROR] Google token verification failed:", err.message);
        return res.status(401).json({ error: "Invalid Google credential token", message: err.message });
    }
}