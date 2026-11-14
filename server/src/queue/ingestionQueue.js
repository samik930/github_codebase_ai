import { Queue } from "bullmq";
import { createRedisConnection, getSharedRedisConnection } from "./redis.js";
import "dotenv/config";

export const INGESTION_QUEUE_NAME = process.env.INGESTION_QUEUE_NAME || "repository-ingestion";

let ingestionQueue = null;

export function getIngestionQueue() {
  if (!ingestionQueue) {
    const connection = createRedisConnection();
    ingestionQueue = new Queue(INGESTION_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 3000,
        },
        removeOnComplete: {
          age: 86400, // 24 hours
          count: 500,
        },
        removeOnFail: {
          age: 604800, // 7 days
          count: 1000,
        },
      },
    });

    ingestionQueue.on("error", (err) => {
      console.error("[QUEUE ERROR]", err.message);
    });
  }
  return ingestionQueue;
}

/**
 * Add ingestion job to BullMQ queue
 */
export async function addIngestionJob({ userId, repoId, repoUrl, branch, commitSHA, jobId }) {
  const queue = getIngestionQueue();

  const job = await queue.add(
    "ingest-repo",
    {
      userId,
      repoId,
      repoUrl,
      branch: branch || "main",
      commitSHA: commitSHA || "",
    },
    {
      jobId: jobId, // Deterministic or custom UUID jobId
    }
  );

  return job;
}

/**
 * Cancel and purge any queued or active ingestion jobs for a specific user and repository / jobId.
 * Ensures that purged repositories do not linger in the queue or get processed by workers.
 */
export async function cancelAndRemoveIngestionJobs({ userId, repoId, jobId }) {
  const queue = getIngestionQueue();
  const redis = getSharedRedisConnection();

  // Set Redis cancellation flags (TTL 30 mins) so any active worker immediately detects it and stops
  if (repoId) {
    const cancelRepoKey = `cancel_ingest:${userId || "all"}:${repoId}`;
    await redis.set(cancelRepoKey, "1", "EX", 1800).catch(() => {});
  }
  if (jobId) {
    const cancelJobKey = `cancel_job:${jobId}`;
    await redis.set(cancelJobKey, "1", "EX", 1800).catch(() => {});
  }

  let removedCount = 0;
  let activeFound = false;

  try {
    const states = ["waiting", "delayed", "prioritized", "paused", "failed", "active"];
    const jobs = await queue.getJobs(states);

    for (const job of jobs) {
      if (!job || !job.data) continue;

      const currentJobId = job.opts?.jobId || job.id;
      const jobRepoId = job.data.repoId;
      const jobUserId = job.data.userId;

      const matchesJobId = jobId && currentJobId === jobId;
      const matchesRepo = repoId && jobRepoId === repoId;
      const matchesUser = !userId || jobUserId === userId || userId === "demo_user" || jobUserId === "demo_user";

      if (matchesJobId || (matchesRepo && matchesUser)) {
        console.log(`[QUEUE PURGE] Found job ${currentJobId} for ${jobRepoId} (user: ${jobUserId}). Purging from queue...`);
        try {
          await job.discard();
        } catch (e) {
          // ignore
        }

        try {
          await job.remove();
          removedCount++;
          console.log(`[QUEUE PURGE] Successfully removed job ${currentJobId} from BullMQ queue.`);
        } catch (err) {
          console.warn(`[QUEUE PURGE WARN] Could not directly remove job ${currentJobId} (status may be active): ${err.message}`);
          activeFound = true;
        }
      }
    }
  } catch (err) {
    console.error("[QUEUE PURGE ERROR] Failed inspecting queue jobs:", err.message);
  }

  return { removedCount, activeFound };
}

export async function closeIngestionQueue() {
  if (ingestionQueue) {
    await ingestionQueue.close();
    ingestionQueue = null;
  }
}
