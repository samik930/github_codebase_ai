import mongoose from "mongoose";

const repositorySchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      default: null,
      index: true,
    },
    repoId: {
      type: String,
      required: true,
      index: true,
    },
    owner: { type: String, required: true },
    repo: { type: String, required: true },
    defaultBranch: { type: String, default: "main" },
    commitHash: { type: String, default: "" },
    filesCount: { type: Number, default: 0 },
    visualCount: { type: Number, default: 0 },
    ownerAvatar: { type: String, default: null },
    indexedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

// Compound index so each user can have their own indexed repositories
repositorySchema.index({ userId: 1, repoId: 1 }, { unique: true });

export const Repository = mongoose.model("Repository", repositorySchema);

