import mongoose from "mongoose";

const repositorySchema = new mongoose.Schema(
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
    repoName: {
      type: String,
      required: true,
    },
    owner: {
      type: String,
      required: true,
    },
    repo: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed"],
      default: "queued",
      index: true,
    },
    defaultBranch: {
      type: String,
      default: "main",
    },
    lastIndexedCommit: {
      type: String,
      default: "",
    },
    commitHash: {
      type: String,
      default: "",
    },
    filesCount: {
      type: Number,
      default: 0,
    },
    visualCount: {
      type: Number,
      default: 0,
    },
    ownerAvatar: {
      type: String,
      default: null,
    },
    indexedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for fast multi-user & repository queries
repositorySchema.index({ userId: 1, repoId: 1 }, { unique: true });
repositorySchema.index({ userId: 1, status: 1 });
repositorySchema.index({ userId: 1, createdAt: -1 });

export const Repository = mongoose.model("Repository", repositorySchema);
