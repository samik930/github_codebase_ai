import mongoose from "mongoose";

const ingestionJobSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    repoId: {
      type: String,
      required: true,
      index: true,
    },
    repoUrl: {
      type: String,
      required: true,
    },
    jobId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    branch: {
      type: String,
      default: "main",
    },
    commitSHA: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed"],
      default: "queued",
      index: true,
    },
    progress: {
      type: Number,
      default: 0,
    },
    stage: {
      type: String,
      default: "Queued in background",
    },
    error: {
      type: String,
      default: null,
    },
    filesCount: {
      type: Number,
      default: 0,
    },
    visualCount: {
      type: Number,
      default: 0,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes
ingestionJobSchema.index({ userId: 1, repoId: 1, status: 1 });
ingestionJobSchema.index({ userId: 1, createdAt: -1 });

export const IngestionJob = mongoose.model("IngestionJob", ingestionJobSchema);

