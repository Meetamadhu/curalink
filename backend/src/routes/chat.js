import { Router } from "express";
import mongoose from "mongoose";
import { Conversation } from "../models/Conversation.js";
import { runResearchPipeline } from "../services/pipeline.js";

export const chatRouter = Router();

function safePayloadForDb(payload) {
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch {
    return { error: "payload_not_serializable" };
  }
}

chatRouter.post("/", async (req, res) => {
  try {
    const { conversationId, message, structured } = req.body || {};
    const text = String(message || "").trim();
    if (!text && !(structured && (structured.disease || structured.additionalQuery))) {
      return res.status(400).json({ error: "message or structured fields required" });
    }

    const env = {
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || "llama3.2",
      PUBMED_EMAIL: process.env.PUBMED_EMAIL || "unknown@example.com",
      PUBMED_TOOL: process.env.PUBMED_TOOL || "curalink",
    };

    let conv = null;
    const rawId = conversationId != null ? String(conversationId).trim() : "";
    if (rawId && mongoose.Types.ObjectId.isValid(rawId)) {
      conv = await Conversation.findById(rawId);
    }
    if (!conv) {
      const initialTitle =
        text.slice(0, 80) || String(structured?.disease || structured?.additionalQuery || "").slice(0, 80) || "Conversation";
      conv = await Conversation.create({ title: initialTitle });
    }

    const structuredPayload = {
      patientName: structured?.patientName ?? conv?.summaryContext?.patientName,
      disease: structured?.disease || conv?.summaryContext?.disease,
      additionalQuery: structured?.additionalQuery || text,
      location: structured?.location || conv?.summaryContext?.location,
    };

    const userDisplayContent = text || structuredPayload.additionalQuery || structuredPayload.disease || "(structured query)";

    conv.messages.push({
      role: "user",
      content: userDisplayContent,
      structuredContext: {
        patientName: structured?.patientName,
        disease: structured?.disease,
        additionalQuery: structured?.additionalQuery,
        location: structured?.location,
      },
    });

    const prior = conv.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));

    const pipeline = await runResearchPipeline(
      {
        message: userDisplayContent,
        structured: {
          ...structuredPayload,
          additionalQuery: structuredPayload.additionalQuery || userDisplayContent,
        },
        priorMessages: prior,
        env,
      },
      {}
    );

    conv.messages.push({
      role: "assistant",
      content: pipeline.assistantText,
      assistantPayload: safePayloadForDb(pipeline.assistantPayload),
    });

    conv.summaryContext = {
      patientName: structuredPayload.patientName || conv.summaryContext?.patientName,
      disease: structuredPayload.disease || conv.summaryContext?.disease,
      additionalQuery: structuredPayload.additionalQuery || text,
      location: structuredPayload.location || conv.summaryContext?.location,
      lastExpandedQuery: pipeline.meta?.expandedQuery,
    };

    if (conv.title === "New conversation" || conv.title === "Conversation") {
      conv.title =
        userDisplayContent.slice(0, 80) || String(structuredPayload.disease || "").slice(0, 80) || "Conversation";
    }

    await conv.save();

    return res.json({
      conversationId: conv._id,
      reply: pipeline.assistantText,
      payload: pipeline.assistantPayload,
      meta: pipeline.meta,
    });
  } catch (err) {
    console.error("POST /api/chat", err?.name, err?.message, err?.stack);
    const msg = err?.message || String(err);
    return res.status(500).json({
      error: "chat_failed",
      message: msg,
      code: err?.name,
    });
  }
});

chatRouter.get("/:id", async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "not_found" });
    return res.json({ conversation: conv });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});
