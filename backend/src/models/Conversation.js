import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant", "system"], required: true },
    content: { type: String, default: "" },
    structuredContext: {
      patientName: String,
      disease: String,
      additionalQuery: String,
      location: String,
    },
    assistantPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
  },
  { _id: true, timestamps: true }
);

const ConversationSchema = new mongoose.Schema(
  {
    title: { type: String, default: "New conversation" },
    summaryContext: {
      patientName: String,
      disease: String,
      additionalQuery: String,
      location: String,
      lastExpandedQuery: String,
    },
    messages: [MessageSchema],
  },
  { timestamps: true }
);

export const Conversation = mongoose.model("Conversation", ConversationSchema);
