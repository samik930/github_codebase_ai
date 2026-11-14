import { Worker } from "bullmq";
import { createRedisConnection, getSharedRedisConnection } from "./redis.js";
import { INGESTION_QUEUE_NAME } from "./ingestionQueue.js";
import { IngestionJob } from "../models/IngestionJob.js";
import { Repository } from "../models/Repository.js";
import {
  parseGithubURL,
  getRepository,
  getRepositoryTree,
  getUsefulFiles,
  getVisualFiles,
} from "../github/downloadRepo.js";
import "dotenv/config";

const FASTAPI_INTERNAL_URL =
  process.env.FASTAPI_INTERNAL_URL || "http://127.0.0.1:8000";
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";
const CONCURRENCY = parseInt(
  process.env.INGESTION_WORKER_CONCURRENCY || "2",
  10
);

export function createIngestionWorker() {
  const connection = createRedisConnection();

  const worker = new Worker(
    INGESTION_QUEUE_NAME,
    async (job) => {
      const { userId, repoId, repoUrl, branch, commitSHA } = job.data;
      const jobId = job.opts.jobId || job.id;

      console.log(
        `[WORKER ${process.pid}] Starting job ${jobId} for repo ${repoId} (user: ${userId})`
      );

      const redis = getSharedRedisConnection();
      const cancelRepoKey = `cancel_ingest:${userId || "all"}:${repoId}`;
      const cancelJobKey = `cancel_job:${jobId}`;

      const checkIfCancelled = async () => {
        try {
          const [valRepo, valJob, repoDoc] = await Promise.all([
            redis.get(cancelRepoKey),
            redis.get(cancelJobKey),
            Repository.findOne({ userId, repoId }),
          ]);
          if (valRepo === "1" || valJob === "1" || !repoDoc || repoDoc.status === "cancelled") {
            return true;
          }
        } catch (e) {
          // ignore
        }
        return false;
      };

      // Check if job was purged before starting
      if (await checkIfCancelled()) {
        console.log(`[WORKER ${process.pid}] Job ${jobId} for ${repoId} was cancelled/purged. Skipping execution.`);
        await job.discard().catch(() => {});
        await job.remove().catch(() => {});
        return { cancelled: true };
      }

      // 1. Mark as processing in MongoDB
      await IngestionJob.findOneAndUpdate(
        { jobId },
        {
          status: "processing",
          startedAt: new Date(),
          progress: 5,
          stage: "Connecting to GitHub API...",
          error: null,
        },
        { upsert: true }
      );

      await Repository.findOneAndUpdate(
        { userId, repoId },
        { status: "processing" }
      );

      await job.updateProgress(5);

      try {
        // 2. Fetch files from GitHub
        const { owner, repo } = parseGithubURL(repoUrl);
        const ghRepo = await getRepository(owner, repo);
        const effectiveBranch = branch || ghRepo.default_branch || "main";

        if (await checkIfCancelled()) {
          console.log(`[WORKER ${process.pid}] Job ${jobId} for ${repoId} was cancelled/purged after repo info. Aborting.`);
          await job.discard().catch(() => {});
          await job.remove().catch(() => {});
          return { cancelled: true };
        }

        const treeResult = await getRepositoryTree(owner, repo, effectiveBranch);
        const effectiveCommit = commitSHA || treeResult.sha || "";

        await job.updateProgress(15);
        await IngestionJob.findOneAndUpdate(
          { jobId },
          {
            progress: 15,
            stage: "Downloading code and visual assets...",
            commitSHA: effectiveCommit,
            branch: effectiveBranch,
          }
        );

        if (await checkIfCancelled()) {
          console.log(`[WORKER ${process.pid}] Job ${jobId} for ${repoId} was cancelled/purged before file fetch. Aborting.`);
          await job.discard().catch(() => {});
          await job.remove().catch(() => {});
          return { cancelled: true };
        }

        const files = await getUsefulFiles(owner, repo, treeResult.tree);
        const visualFiles = await getVisualFiles(
          owner,
          repo,
          treeResult.tree,
          effectiveBranch
        );

        console.log(
          `[WORKER ${process.pid}] Fetched ${files.length} code files and ${visualFiles.length} visual assets for ${repoId}`
        );

        if (await checkIfCancelled()) {
          console.log(`[WORKER ${process.pid}] Job ${jobId} for ${repoId} was cancelled/purged after downloading files. Aborting.`);
          await job.discard().catch(() => {});
          await job.remove().catch(() => {});
          return { cancelled: true };
        }

        await job.updateProgress(30);
        await IngestionJob.findOneAndUpdate(
          { jobId },
          {
            progress: 30,
            stage: `Downloaded ${files.length} code files. Initiating RAG vector indexing...`,
            filesCount: files.length,
            visualCount: visualFiles.length,
          }
        );

        // 3. Invoke FastAPI /ingest endpoint with AbortController for cancelability
        const headers = {
          "Content-Type": "application/json",
        };
        if (INTERNAL_SERVICE_SECRET) {
          headers["x-service-secret"] = INTERNAL_SERVICE_SECRET;
        }

        const ingestPayload = {
          user_id: userId,
          repo_id: repoId,
          commit_hash: effectiveCommit,
          branch: effectiveBranch,
          files,
          visual_files: visualFiles,
        };

        const abortController = new AbortController();
        const response = await fetch(`${FASTAPI_INTERNAL_URL}/ingest`, {
          method: "POST",
          headers,
          body: JSON.stringify(ingestPayload),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(
            `FastAPI /ingest returned HTTP ${response.status}: ${errText}`
          );
        }

        // 4. Stream response from FastAPI SSE
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let isCompletedSuccessfully = false;
        let lastError = null;

        while (true) {
          if (await checkIfCancelled()) {
            console.log(`[WORKER ${process.pid}] Job ${jobId} for ${repoId} was cancelled/purged during SSE indexing. Aborting stream...`);
            abortController.abort();
            reader.cancel().catch(() => {});
            // Clean up any partially ingested vectors from Qdrant and BM25
            try {
              await fetch(`${FASTAPI_INTERNAL_URL}/delete-repo`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repo_id: repoId, user_id: userId }),
              });
            } catch (e) {}
            await job.discard().catch(() => {});
            await job.remove().catch(() => {});
            return { cancelled: true };
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const message = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            if (message.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(message.replace("data: ", ""));

                if (parsed.type === "error") {
                  lastError = parsed.error || "FastAPI reported an error";
                  throw new Error(lastError);
                }

                if (parsed.type === "progress") {
                  // Map progress 0-100 from FastAPI to 30-95 in overall job
                  const mappedPercent = Math.min(
                    95,
                    Math.round(30 + (parsed.percent || 0) * 0.65)
                  );
                  await job.updateProgress(mappedPercent);
                  await IngestionJob.findOneAndUpdate(
                    { jobId },
                    {
                      progress: mappedPercent,
                      stage: `Indexing chunks (${parsed.processedChunks || 0} / ${parsed.totalChunks || 0})...`,
                    }
                  );
                }

                if (parsed.type === "status") {
                  await IngestionJob.findOneAndUpdate(
                    { jobId },
                    { stage: parsed.message }
                  );
                }

                if (parsed.type === "complete") {
                  isCompletedSuccessfully = true;
                }
              } catch (e) {
                if (e.message && e.message.startsWith("FastAPI")) {
                  throw e;
                }
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }

        if (!isCompletedSuccessfully) {
          throw new Error(
            lastError || "Ingestion pipeline terminated without completion signal"
          );
        }

        // Before finalizing, double-check if repo was purged while finishing
        if (await checkIfCancelled()) {
          console.log(`[WORKER ${process.pid}] Job ${jobId} for ${repoId} was cancelled right before completion. Purging.`);
          try {
            await fetch(`${FASTAPI_INTERNAL_URL}/delete-repo`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ repo_id: repoId, user_id: userId }),
            });
          } catch (e) {}
          await job.discard().catch(() => {});
          await job.remove().catch(() => {});
          return { cancelled: true };
        }

        // 5. Update MongoDB upon verified success
        await IngestionJob.findOneAndUpdate(
          { jobId },
          {
            status: "completed",
            progress: 100,
            stage: "Ingestion completed successfully",
            completedAt: new Date(),
            filesCount: files.length,
            visualCount: visualFiles.length,
            error: null,
          }
        );

        await Repository.findOneAndUpdate(
          { userId, repoId },
          {
            userId,
            repoId,
            repoUrl,
            repoName: repo,
            owner,
            repo,
            status: "completed",
            defaultBranch: effectiveBranch,
            lastIndexedCommit: effectiveCommit,
            commitHash: effectiveCommit,
            filesCount: files.length,
            visualCount: visualFiles.length,
            ownerAvatar: ghRepo.owner?.avatar_url || null,
            indexedAt: new Date(),
          },
          { upsert: true, new: true }
        );

        await job.updateProgress(100);

        console.log(
          `[WORKER ${process.pid}] Successfully completed job ${jobId} for repo ${repoId}`
        );

        return {
          success: true,
          repoId,
          filesCount: files.length,
          visualCount: visualFiles.length,
        };
      } catch (err) {
        // If cancellation caused the abort, exit cleanly without recording error
        if (await checkIfCancelled()) {
          console.log(`[WORKER ${process.pid}] Job ${jobId} aborted due to purge/cancellation.`);
          await job.discard().catch(() => {});
          await job.remove().catch(() => {});
          return { cancelled: true };
        }

        console.error(
          `[WORKER ${process.pid}] Job ${jobId} failed: ${err.message}`
        );

        // Record failure in MongoDB
        await IngestionJob.findOneAndUpdate(
          { jobId },
          {
            status: "failed",
            error: err.message,
            stage: `Failed: ${err.message}`,
          }
        );

        await Repository.findOneAndUpdate(
          { userId, repoId },
          { status: "failed" }
        );

        // Re-throw so BullMQ initiates configured retry with exponential backoff
        throw err;
      }
    },
    {
      connection,
      concurrency: CONCURRENCY,
    }
  );

  worker.on("failed", async (job, err) => {
    console.error(
      `[WORKER ${process.pid}] Job ${job?.id} failed after attempts: ${err.message}`
    );
  });

  worker.on("completed", (job) => {
    console.log(
      `[WORKER ${process.pid}] Job ${job?.id} marked COMPLETED in queue`
    );
  });

  return worker;
}
