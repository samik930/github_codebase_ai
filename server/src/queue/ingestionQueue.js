import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.js";
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

export async function closeIngestionQueue() {
  if (ingestionQueue) {
    await ingestionQueue.close();
    ingestionQueue = null;
  }
}

