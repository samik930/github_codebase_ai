import express from "express";
import cors from "cors";
import router from "./routes/routes.js";
import { connectDB } from "./db/connect.js";
import { closeIngestionQueue } from "./queue/ingestionQueue.js";
import "dotenv/config";

const app = express();

app.use(cors());
app.use(express.json());

// Initialize MongoDB Connection
connectDB();

app.get("/", (req, res) => {
    res.json({
        message: "Codebase Copilot API & Ingestion Queue Service is running",
        timestamp: new Date().toISOString()
    });
});

app.use("/api", router);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
const handleShutdown = async (signal) => {
    console.log(`[SERVER] Received ${signal}, closing gracefully...`);
    server.close(async () => {
        await closeIngestionQueue();
        console.log("[SERVER] Ingestion queue and HTTP connections closed.");
        process.exit(0);
    });
};

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
