import { Redis } from "ioredis";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const rawRedisUrl = process.env.REDIS_URL ? process.env.REDIS_URL.trim().replace(/^["']|["']$/g, "") : "";
const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);
const redisPassword = process.env.REDIS_PASSWORD || undefined;

export function createRedisConnection(customOptions = {}) {
  const baseOptions = {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    retryStrategy(times) {
      const delay = Math.min(times * 150, 3000);
      return delay;
    },
    ...customOptions,
  };

  if (rawRedisUrl) {
    const isTls = rawRedisUrl.startsWith("rediss://");
    return new Redis(rawRedisUrl, {
      ...baseOptions,
      ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
    });
  }

  return new Redis({
    host: redisHost,
    port: redisPort,
    password: redisPassword,
    ...baseOptions,
  });
}

// Shared connection for generic operations
let sharedConnection = null;
export function getSharedRedisConnection() {
  if (!sharedConnection) {
    sharedConnection = createRedisConnection();
    sharedConnection.on("error", (err) => {
      console.error("[REDIS ERROR]", err.message);
    });
    sharedConnection.on("connect", () => {
      console.log("[REDIS] Connected successfully to Redis instance");
    });
  }
  return sharedConnection;
}
