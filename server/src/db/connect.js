import mongoose from "mongoose";
import "dotenv/config";

let isConnected = false;

export async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[WARN] MONGODB_URI not found in environment variables. Database persistence disabled.");
    return;
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    console.log(`[MONGODB] Connected successfully to host: ${conn.connection.host}`);
  } catch (error) {
    console.error(`[MONGODB ERROR] Failed to connect: ${error.message}`);
  }
}
