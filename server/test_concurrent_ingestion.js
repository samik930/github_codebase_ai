/**
 * test_concurrent_ingestion.js
 * Simulates 5 concurrent users submitting ingestion jobs to BullMQ.
 * Uses real Upstash Redis + real MongoDB. Does NOT call FastAPI/Qdrant.
 * A mock worker processes jobs with simulated delays (2–5s each).
 *
 * Run from: d:\codebase_copilot\server
 *   node test_concurrent_ingestion.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Queue, Worker, QueueEvents } from "bullmq";
import mongoose from "mongoose";
import { randomUUID as uuidv4 } from "crypto";
import { createRedisConnection } from "./src/queue/redis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

// ── ANSI colours ──────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};
const color = (c, s) => `${c}${s}${C.reset}`;
const ts = () => color(C.gray, `[${new Date().toISOString().slice(11, 23)}]`);

// ── Mongoose IngestionJob (inline) ────────────────────────────
const jobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    repoId: { type: String, required: true },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed"],
      default: "queued",
    },
    progress: { type: Number, default: 0 },
    stage: { type: String, default: "queued" },
    error: { type: String },
    startedAt: Date,
    completedAt: Date,
  },
  { timestamps: true }
);
const IngestionJob =
  mongoose.models.IngestionJob || mongoose.model("IngestionJob", jobSchema);

// ── 5 Simulated users ─────────────────────────────────────────
const USERS = [
  { userId: "user_alice@test.com", repoId: "alice/repo-alpha",    repo: "https://github.com/alice/repo-alpha" },
  { userId: "user_bob@test.com",   repoId: "bob/repo-beta",       repo: "https://github.com/bob/repo-beta" },
  { userId: "user_carol@test.com", repoId: "carol/repo-gamma",    repo: "https://github.com/carol/repo-gamma" },
  { userId: "user_dave@test.com",  repoId: "dave/repo-delta",     repo: "https://github.com/dave/repo-delta" },
  { userId: "user_eve@test.com",   repoId: "eve/repo-epsilon",    repo: "https://github.com/eve/repo-epsilon" },
];

const QUEUE_NAME = "sim-concurrent-ingestion-" + Date.now(); // isolated queue name
const CONCURRENCY  = 2; // matches real worker setting
const stats = {}; // jobId → tracking info

// ── Utility ───────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randomDelay() {
  return Math.floor(Math.random() * 3000) + 2000; // 2–5 s
}
function printLine(msg) {
  process.stdout.write(msg + "\n");
}

// ── Live dashboard ────────────────────────────────────────────
function printDashboard() {
  const rows = Object.values(stats);
  const col = (s, w) => String(s).padEnd(w);

  printLine(`\n${color(C.bold + C.cyan, "┌─── LIVE QUEUE DASHBOARD ──────────────────────────────────────┐")}`);
  printLine(color(C.cyan, `│ ${"User".padEnd(26)} ${"Repo".padEnd(20)} ${"Status".padEnd(12)} ${"Progress".padEnd(10)}│`));
  printLine(color(C.cyan, `│${"─".repeat(72)}│`));
  for (const r of rows) {
    const statusColor =
      r.status === "completed" ? C.green :
      r.status === "processing" ? C.yellow :
      r.status === "failed" ? C.red : C.gray;
    const bar = "█".repeat(Math.floor((r.progress || 0) / 10)).padEnd(10, "░");
    printLine(
      color(C.cyan, "│ ") +
      col(r.userId.replace("user_", ""), 26) +
      col(r.repoId.split("/")[1], 20) +
      color(statusColor, col(r.status, 12)) +
      color(C.blue, bar) +
      color(C.cyan, "│")
    );
  }
  printLine(color(C.bold + C.cyan, "└──────────────────────────────────────────────────────────────┘\n"));
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  printLine(color(C.bold + C.magenta, "\n╔══════════════════════════════════════════════════════════════╗"));
  printLine(color(C.bold + C.magenta,   "║   5-USER CONCURRENT INGESTION SIMULATION (BullMQ + Redis)   ║"));
  printLine(color(C.bold + C.magenta,   "╚══════════════════════════════════════════════════════════════╝\n"));

  // 1. MongoDB
  printLine(`${ts()} Connecting to MongoDB...`);
  await mongoose.connect(process.env.MONGODB_URI, { dbName: "codebase_copilot" });
  printLine(`${ts()} ${color(C.green, "MongoDB connected")}`);

  // 2. Redis / BullMQ queue
  const queueConn = createRedisConnection();
  const queue = new Queue(QUEUE_NAME, { connection: queueConn });
  printLine(`${ts()} ${color(C.green, "BullMQ queue ready:")} ${QUEUE_NAME}`);

  // Clean up any leftover jobs from previous runs with same name (shouldn't happen with timestamp)
  await queue.obliterate({ force: true }).catch(() => {});

  // 3. Create MongoDB IngestionJob docs + push all 5 jobs simultaneously
  printLine(`\n${ts()} ${color(C.bold, "Submitting 5 ingestion jobs simultaneously...")}\n`);

  const jobIds = [];
  const addPromises = USERS.map(async ({ userId, repoId, repo }) => {
    const jobId = uuidv4();
    jobIds.push(jobId);

    // Track in memory
    stats[jobId] = { jobId, userId, repoId, status: "queued", progress: 0, startedAt: null, completedAt: null };

    // Persist to MongoDB (mirrors what real ingestController does)
    await IngestionJob.create({
      jobId,
      userId,
      repoId,
      status: "queued",
      progress: 0,
      stage: "queued",
    });

    // Push to BullMQ
    await queue.add("ingest-repo", { userId, repoId, repoUrl: repo, branch: "main" }, { jobId });

    printLine(
      `${ts()} ${color(C.yellow, "QUEUED")}  jobId=${color(C.cyan, jobId.slice(0, 8))}…  ` +
      `user=${color(C.magenta, userId.replace("user_", ""))}  repo=${repoId}`
    );
  });

  await Promise.all(addPromises);

  printLine(`\n${ts()} ${color(C.green, "All 5 jobs submitted.")} Worker concurrency = ${CONCURRENCY}`);
  printLine(`${ts()} ${color(C.yellow, "Expect jobs 1-2 to start immediately; 3-5 wait in queue.\n")}`);

  // 4. Start mock worker (concurrency = 2, same as real setting)
  const workerConn = createRedisConnection();
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { userId, repoId } = job.data;
      const { jobId } = job.opts;

      // ── PROCESSING ──
      stats[jobId].status = "processing";
      stats[jobId].startedAt = new Date();

      printLine(
        `\n${ts()} ${color(C.yellow, "▶ PROCESSING")}  ` +
        `jobId=${color(C.cyan, jobId.slice(0, 8))}…  ` +
        `user=${color(C.magenta, userId.replace("user_", ""))}  repo=${repoId}`
      );

      // Count currently processing
      const processingCount = Object.values(stats).filter((s) => s.status === "processing").length;
      const queuedCount = Object.values(stats).filter((s) => s.status === "queued").length;
      printLine(
        `${ts()} ${color(C.blue, `Active: ${processingCount}/${CONCURRENCY}`)}  ` +
        `${color(C.gray, `Waiting in queue: ${queuedCount}`)}`
      );

      await IngestionJob.updateOne(
        { jobId },
        { status: "processing", stage: "downloading", startedAt: new Date(), progress: 10 }
      );

      // Simulate stages
      const delay = randomDelay();
      const stages = [
        { pct: 20, label: "downloading files" },
        { pct: 45, label: "chunking documents" },
        { pct: 65, label: "generating embeddings" },
        { pct: 85, label: "upserting to vector DB" },
        { pct: 100, label: "complete" },
      ];

      for (const { pct, label } of stages) {
        await sleep(delay / stages.length);
        stats[jobId].progress = pct;
        await IngestionJob.updateOne({ jobId }, { progress: pct, stage: label });
        process.stdout.write(
          `${ts()} ${color(C.gray, `  → [${userId.replace("user_", "")}] ${label} (${pct}%)\n`)}`
        );
      }

      // ── COMPLETED ──
      stats[jobId].status = "completed";
      stats[jobId].completedAt = new Date();
      const duration = ((stats[jobId].completedAt - stats[jobId].startedAt) / 1000).toFixed(1);

      await IngestionJob.updateOne(
        { jobId },
        { status: "completed", progress: 100, stage: "complete", completedAt: new Date() }
      );

      printLine(
        `${ts()} ${color(C.green, "✔ COMPLETED")}  ` +
        `jobId=${color(C.cyan, jobId.slice(0, 8))}…  ` +
        `user=${color(C.magenta, userId.replace("user_", ""))}  ` +
        `duration=${color(C.bold, duration + "s")}`
      );

      const remaining = Object.values(stats).filter((s) => !["completed", "failed"].includes(s.status)).length;
      printLine(`${ts()} ${color(C.gray, `Remaining (queued/processing): ${remaining}`)}`);
    },
    {
      connection: workerConn,
      concurrency: CONCURRENCY,
    }
  );

  worker.on("error", (err) => printLine(`${ts()} ${color(C.red, "[WORKER ERROR]")} ${err.message}`));

  // 5. Wait for all 5 to complete
  printLine(`${ts()} Waiting for all 5 jobs to complete...\n`);

  await new Promise((resolve) => {
    const check = setInterval(async () => {
      const done = Object.values(stats).filter((s) => s.status === "completed" || s.status === "failed").length;
      if (done === USERS.length) {
        clearInterval(check);
        resolve();
      }
    }, 500);
  });

  // 6. Final summary
  await sleep(300);
  printLine(color(C.bold + C.magenta, "\n╔══════════════════════════════════════════════════════════════╗"));
  printLine(color(C.bold + C.magenta,   "║                      FINAL SUMMARY                          ║"));
  printLine(color(C.bold + C.magenta,   "╚══════════════════════════════════════════════════════════════╝"));
  printDashboard();

  // Verify isolation: each job has its own userId + repoId
  printLine(color(C.bold, "Isolation Check (userId + repoId uniqueness):"));
  const pairs = Object.values(stats).map((s) => `${s.userId}:${s.repoId}`);
  const uniquePairs = new Set(pairs);
  const isolated = uniquePairs.size === USERS.length;
  printLine(`  ${isolated ? color(C.green, "✔ PASS") : color(C.red, "✘ FAIL")}  ${uniquePairs.size}/${USERS.length} unique (userId, repoId) pairs\n`);

  // Verify from MongoDB
  printLine(color(C.bold, "MongoDB Verification:"));
  for (const jobId of jobIds) {
    const doc = await IngestionJob.findOne({ jobId });
    const statusColor = doc.status === "completed" ? C.green : C.red;
    printLine(
      `  ${color(statusColor, "●")} jobId=${jobId.slice(0, 8)}…  ` +
      `user=${doc.userId.replace("user_", "")}  ` +
      `status=${color(statusColor, doc.status)}  ` +
      `progress=${doc.progress}%`
    );
  }

  const allCompleted = jobIds.every((id) => stats[id]?.status === "completed");
  printLine(
    `\n${color(C.bold, "Overall Result:")} ${
      allCompleted
        ? color(C.green + C.bold, "✔ ALL 5 JOBS COMPLETED SUCCESSFULLY")
        : color(C.red + C.bold, "✘ SOME JOBS DID NOT COMPLETE")
    }\n`
  );

  // Cleanup
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await mongoose.disconnect();
  printLine(`${ts()} ${color(C.gray, "Cleanup done. Exiting.")}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(color(C.red, "\n[FATAL]"), err);
  process.exit(1);
});
