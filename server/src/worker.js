import { connectDB } from "./db/connect.js";
import { createIngestionWorker } from "./queue/ingestionWorker.js";
import "dotenv/config";

async function startWorker() {
  console.log(`[WORKER PROCESS ${process.pid}] Initializing background ingestion worker...`);

  // Ensure DB connection
  await connectDB();

  const worker = createIngestionWorker();
  console.log(`[WORKER PROCESS ${process.pid}] Worker listening on queue with concurrency ${process.env.INGESTION_WORKER_CONCURRENCY || 2}`);

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    console.log(`[WORKER PROCESS ${process.pid}] Received ${signal}, closing worker gracefully...`);
    try {
      await worker.close();
      console.log(`[WORKER PROCESS ${process.pid}] Worker closed cleanly.`);
      process.exit(0);
    } catch (err) {
      console.error(`[WORKER PROCESS ${process.pid}] Error during shutdown:`, err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

startWorker().catch((err) => {
  console.error("[WORKER FATAL]", err);
  process.exit(1);
});

