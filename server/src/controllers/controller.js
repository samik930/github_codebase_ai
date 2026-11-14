import { parseGithubURL } from "../github/downloadRepo.js";
import { Repository } from "../models/Repository.js";
import { IngestionJob } from "../models/IngestionJob.js";
import { ChatMessage } from "../models/ChatMessage.js";
import { addIngestionJob, cancelAndRemoveIngestionJobs } from "../queue/ingestionQueue.js";
import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "crypto";

const FASTAPI_INTERNAL_URL =
  process.env.FASTAPI_INTERNAL_URL || "http://127.0.0.1:8000";
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

/**
 * Ingest Controller — Background job submission
 * Authenticates user, validates URL, prevents duplicates, enqueues to BullMQ, and returns immediately.
 */
export async function ingestController(req, res) {
  try {
    const { githubUrl, userId, isDemo, branch } = req.body;

    if (!githubUrl || !githubUrl.trim()) {
      return res.status(400).json({ error: "GitHub URL is required" });
    }

    const effectiveUserId = isDemo ? "demo_user" : userId;
    if (!effectiveUserId) {
      return res.status(401).json({
        error: "Authentication required to ingest repository",
      });
    }

    let parsed;
    try {
      parsed = parseGithubURL(githubUrl.trim());
    } catch (urlErr) {
      return res.status(400).json({ error: "Invalid GitHub repository URL" });
    }

    const { owner, repo } = parsed;
    const repoId = `${owner}/${repo}`;
    console.log(
      `[INGEST SUBMISSION] User=${effectiveUserId}, Repo=${repoId}, Branch=${branch || "main"}`
    );

    // Duplicate Prevention: Check if active or queued job already exists for this user and repository
    const existingActiveJob = await IngestionJob.findOne({
      userId: effectiveUserId,
      repoId,
      status: { $in: ["queued", "processing"] },
    });

    if (existingActiveJob) {
      return res.status(409).json({
        error: "An ingestion job is already active for this repository",
        jobId: existingActiveJob.jobId,
        repoId,
        status: existingActiveJob.status,
        progress: existingActiveJob.progress,
        stage: existingActiveJob.stage,
      });
    }

    // Upsert Repository record in queued status
    await Repository.findOneAndUpdate(
      { userId: effectiveUserId, repoId },
      {
        userId: effectiveUserId,
        repoId,
        repoUrl: githubUrl.trim(),
        repoName: repo,
        owner,
        repo,
        status: "queued",
        defaultBranch: branch || "main",
      },
      { upsert: true, new: true }
    );

    // Generate unique Job ID
    const jobId = `job_${Date.now()}_${randomUUID().slice(0, 8)}`;

    // Create IngestionJob record in MongoDB
    await IngestionJob.create({
      userId: effectiveUserId,
      repoId,
      repoUrl: githubUrl.trim(),
      jobId,
      branch: branch || "main",
      status: "queued",
      progress: 0,
      stage: "Queued in background",
    });

    // Add job to BullMQ queue
    await addIngestionJob({
      userId: effectiveUserId,
      repoId,
      repoUrl: githubUrl.trim(),
      branch: branch || "main",
      commitSHA: "",
      jobId,
    });

    console.log(`[BULLMQ] Job ${jobId} queued successfully for ${repoId}`);

    // Return job ID immediately without waiting for ingestion to finish
    return res.status(202).json({
      success: true,
      jobId,
      repoId,
      status: "queued",
      progress: 0,
      stage: "Queued in background",
      message: "Repository ingestion queued successfully.",
    });
  } catch (error) {
    console.error("[ERROR] Ingestion job submission failed:", error);
    return res.status(500).json({
      error: "Failed to queue ingestion job",
      message: error.message,
    });
  }
}

/**
 * Get status of an ingestion job
 */
export async function getJobStatusController(req, res) {
  try {
    const jobId = req.params.jobId || req.query.jobId;
    if (!jobId) {
      return res.status(400).json({ error: "jobId is required" });
    }

    const job = await IngestionJob.findOne({ jobId }).lean();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    return res.json({
      jobId: job.jobId,
      repoId: job.repoId,
      repoUrl: job.repoUrl,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      error: job.error,
      filesCount: job.filesCount,
      visualCount: job.visualCount,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  } catch (error) {
    console.error("[ERROR] Failed to fetch job status:", error.message);
    return res.status(500).json({ error: "Failed to fetch job status" });
  }
}

/**
 * List recent jobs for authenticated user
 */
export async function getUserJobsController(req, res) {
  try {
    const { userId, isDemo } = req.query;
    const effectiveUserId = isDemo === "true" ? "demo_user" : userId;
    if (!effectiveUserId) {
      return res.json({ jobs: [] });
    }

    const jobs = await IngestionJob.find({ userId: effectiveUserId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.json({ jobs });
  } catch (error) {
    console.error("[ERROR] Failed to fetch user jobs:", error.message);
    return res.status(500).json({ jobs: [] });
  }
}

/**
 * Retry a failed ingestion job
 */
export async function retryJobController(req, res) {
  try {
    const jobId = req.params.jobId;
    const { userId } = req.body;

    const job = await IngestionJob.findOne({ jobId });
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (userId && job.userId !== userId && job.userId !== "demo_user") {
      return res.status(403).json({ error: "Unauthorized to retry this job" });
    }

    // Reset job record
    job.status = "queued";
    job.progress = 0;
    job.stage = "Retry queued in background";
    job.error = null;
    await job.save();

    await Repository.findOneAndUpdate(
      { userId: job.userId, repoId: job.repoId },
      { status: "queued" }
    );

    // Re-enqueue into BullMQ
    await addIngestionJob({
      userId: job.userId,
      repoId: job.repoId,
      repoUrl: job.repoUrl,
      branch: job.branch,
      commitSHA: job.commitSHA,
      jobId: job.jobId,
    });

    console.log(`[BULLMQ] Job ${jobId} re-queued for retry`);

    return res.json({
      success: true,
      jobId: job.jobId,
      status: "queued",
      message: "Job re-queued successfully",
    });
  } catch (error) {
    console.error("[ERROR] Failed to retry job:", error.message);
    return res.status(500).json({ error: "Failed to retry job", message: error.message });
  }
}

/**
 * Query Controller with strict repository ownership and tenant isolation
 */
export async function queryController(req, res) {
  try {
    const { question, repo_id, no_save, userId, isDemo } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: "Question is required" });
    }

    if (!repo_id || !repo_id.trim()) {
      return res.status(400).json({
        error: "repo_id is required. Select a repository before querying.",
      });
    }

    const effectiveUserId = isDemo ? "demo_user" : userId;
    if (!effectiveUserId) {
      return res.status(401).json({ error: "Authentication required to query codebase" });
    }

    // Verify repository ownership in MongoDB
    if (!isDemo) {
      const ownedRepo = await Repository.findOne({
        userId: effectiveUserId,
        repoId: repo_id,
      });

      if (!ownedRepo) {
        return res.status(403).json({
          error: "Unauthorized: You do not have access to this repository.",
        });
      }
    }

    console.log(
      `[QUERY] user=${effectiveUserId}, repo_id=${repo_id}, question="${question}"`
    );

    // Call FastAPI RAG microservice with user_id & repo_id
    const headers = { "Content-Type": "application/json" };
    if (INTERNAL_SERVICE_SECRET) {
      headers["x-service-secret"] = INTERNAL_SERVICE_SECRET;
    }

    const response = await fetch(`${FASTAPI_INTERNAL_URL}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        question,
        repo_id,
        user_id: effectiveUserId,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(
        errorBody.error || `FastAPI responded with status ${response.status}`
      );
    }

    const result = await response.json();

    // Persist conversation turn to MongoDB for real authenticated accounts
    const shouldSave = !no_save && !isDemo && Boolean(userId);
    if (shouldSave) {
      try {
        await ChatMessage.create({
          userId: effectiveUserId,
          repoId: repo_id,
          role: "user",
          content: question,
          timestamp: new Date(),
        });

        await ChatMessage.create({
          userId: effectiveUserId,
          repoId: repo_id,
          role: "assistant",
          content: result.answer || "No response received.",
          sources: result.sources || [],
          telemetry: {
            sourcesCount: (result.sources || []).length,
          },
          timestamp: new Date(),
        });
      } catch (dbErr) {
        console.warn(`[MONGODB WARN] Could not persist chat: ${dbErr.message}`);
      }
    }

    return res.json(result);
  } catch (error) {
    console.error("[ERROR] Query execution failed:", error);
    return res.status(500).json({
      error: "Query failed",
      message: error.message,
    });
  }
}

/**
 * List repositories for authenticated user
 */
export async function repositoriesController(req, res) {
  try {
    const { userId, isDemo } = req.query;

    if (isDemo === "true" || !userId) {
      return res.json({ repositories: [] });
    }

    // Query MongoDB for repositories indexed by this specific user
    const dbRepos = await Repository.find({ userId })
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      repositories: (dbRepos || []).map((r) => ({
        repo_id: r.repoId,
        repository: r.repoId,
        repo_url: r.repoUrl,
        owner: r.owner,
        repo: r.repo,
        status: r.status || "completed",
        files: r.filesCount,
        visual_files: r.visualCount,
        owner_avatar: r.ownerAvatar,
        commit_hash: r.commitHash || r.lastIndexedCommit,
        indexed_at: r.indexedAt || r.updatedAt,
      })),
    });
  } catch (error) {
    console.error("[ERROR] Failed to fetch repositories:", error.message);
    return res.json({ repositories: [] });
  }
}

/**
 * Chat History
 */
export async function getChatHistoryController(req, res) {
  try {
    const { userId, isDemo } = req.query;
    const repoId = req.query.repo_id || req.params.repoId;

    if (isDemo === "true" || !userId) {
      return res.json({ messages: [] });
    }

    if (!repoId) {
      return res.status(400).json({ error: "repo_id is required", messages: [] });
    }

    const decodedRepoId = decodeURIComponent(repoId);
    const messages = await ChatMessage.find({ repoId: decodedRepoId, userId })
      .sort({ timestamp: 1 })
      .lean();

    return res.json({
      messages: messages.map((m) => ({
        id: m._id.toString(),
        role: m.role,
        content: m.content,
        sources: m.sources || [],
        telemetry: m.telemetry || {},
        timestamp: m.timestamp,
      })),
    });
  } catch (error) {
    console.error("[ERROR] Failed to fetch chat history:", error.message);
    return res.status(500).json({ error: "Failed to fetch chat history", messages: [] });
  }
}

export async function clearChatHistoryController(req, res) {
  try {
    const { userId, isDemo } = req.query;
    const repoId = req.query.repo_id || req.params.repoId;

    if (isDemo === "true" || !userId) {
      return res.json({ success: true, message: "Demo history cleared locally" });
    }

    if (!repoId) {
      return res.status(400).json({ error: "repo_id is required" });
    }

    const decodedRepoId = decodeURIComponent(repoId);
    await ChatMessage.deleteMany({ repoId: decodedRepoId, userId });
    return res.json({ success: true, message: `Chat history cleared for ${decodedRepoId}` });
  } catch (error) {
    console.error("[ERROR] Failed to clear chat history:", error.message);
    return res.status(500).json({ error: "Failed to clear chat history" });
  }
}

/**
 * Delete Repository: Cancels/purges BullMQ queue jobs, deletes Qdrant vectors via FastAPI, BM25 file, ChatMessages, IngestionJobs, and Repository
 */
export async function deleteRepositoryController(req, res) {
  try {
    const { userId } = req.query;
    const repoId = req.query.repo_id || req.params.repoId;

    if (!repoId) {
      return res.status(400).json({ error: "repo_id is required" });
    }

    const decodedRepoId = decodeURIComponent(repoId);
    const effectiveUserId = userId || "demo_user";

    console.log(
      `[DELETE REPO] Deleting ${decodedRepoId} for user ${effectiveUserId}`
    );

    // 1. Immediately cancel and purge any queued or active BullMQ jobs in Redis
    let jobsRemoved = 0;
    try {
      const queueResult = await cancelAndRemoveIngestionJobs({
        userId: effectiveUserId,
        repoId: decodedRepoId,
      });
      jobsRemoved = queueResult?.removedCount || 0;
      console.log(`[QUEUE PURGE] Removed ${jobsRemoved} jobs from queue for ${decodedRepoId}`);
    } catch (queueErr) {
      console.warn(`[WARN] Queue purge error (continuing with vector & DB cleanup): ${queueErr.message}`);
    }

    // 2. Delete vectors and BM25 index from FastAPI service
    try {
      const headers = { "Content-Type": "application/json" };
      if (INTERNAL_SERVICE_SECRET) {
        headers["x-service-secret"] = INTERNAL_SERVICE_SECRET;
      }

      await fetch(`${FASTAPI_INTERNAL_URL}/delete-repo`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          repo_id: decodedRepoId,
          user_id: effectiveUserId,
        }),
      });
      console.log(`[DELETE REPO] FastAPI vectors purged for ${decodedRepoId}`);
    } catch (apiErr) {
      console.warn(`[WARN] Could not reach FastAPI to purge vectors: ${apiErr.message}`);
    }

    // 3. Delete MongoDB records (supporting both demo and demo_user aliases)
    const userConditions = [effectiveUserId];
    if (effectiveUserId === "demo_user" || effectiveUserId === "demo") {
      userConditions.push("demo_user", "demo");
    }
    const filter = {
      repoId: decodedRepoId,
      userId: { $in: userConditions }
    };

    await Repository.deleteMany(filter);
    await ChatMessage.deleteMany(filter);
    await IngestionJob.deleteMany(filter);

    console.log(`[MONGODB] Cleaned up records for ${decodedRepoId}`);
    return res.json({
      success: true,
      message: `Repository ${decodedRepoId} and all associated queue jobs/vectors deleted successfully.`,
      jobsRemoved: queueResult.removedCount,
    });
  } catch (error) {
    console.error("[ERROR] Failed to delete repository:", error.message);
    return res.status(500).json({ error: "Failed to delete repository" });
  }
}

/**
 * Explicit Cancel Job endpoint: Cancels a specific job by jobId and purges associated queue entries
 */
export async function cancelJobController(req, res) {
  try {
    const { jobId } = req.params;
    const { userId } = req.body || req.query || {};

    if (!jobId) {
      return res.status(400).json({ error: "jobId is required" });
    }

    const jobDoc = await IngestionJob.findOne({ jobId });
    const repoId = jobDoc?.repoId;
    const effectiveUserId = userId || jobDoc?.userId || "demo_user";

    console.log(`[CANCEL JOB] Cancelling job ${jobId} (repo: ${repoId}, user: ${effectiveUserId})`);

    const queueResult = await cancelAndRemoveIngestionJobs({
      userId: effectiveUserId,
      repoId,
      jobId,
    });

    if (repoId) {
      // Purge vectors if any were partially created
      try {
        await fetch(`${FASTAPI_INTERNAL_URL}/delete-repo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo_id: repoId, user_id: effectiveUserId }),
        });
      } catch (e) {}

      await Repository.deleteOne({ repoId, userId: effectiveUserId });
    }

    await IngestionJob.deleteOne({ jobId });

    return res.json({
      success: true,
      message: `Job ${jobId} cancelled and purged from queue.`,
      jobsRemoved: queueResult.removedCount,
    });
  } catch (error) {
    console.error("[ERROR] Failed to cancel job:", error.message);
    return res.status(500).json({ error: "Failed to cancel job" });
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
      audience: process.env.GOOGLE_CLIENT_ID,
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
        provider: "google",
        isDemo: false,
      },
    });
  } catch (err) {
    console.error("[AUTH ERROR] Google token verification failed:", err.message);
    return res.status(401).json({
      error: "Invalid Google credential token",
      message: err.message,
    });
  }
}
