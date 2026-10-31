import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema(
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
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    sources: {
      type: Array,
      default: [],
    },
    telemetry: {
      type: Object,
      default: {},
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

chatMessageSchema.index({ userId: 1, repoId: 1, timestamp: 1 });

export const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);

