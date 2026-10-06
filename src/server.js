import crypto from "node:crypto";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { generateReply, FALLBACK_REPLY } from "./agent.js";
import { ConversationStore } from "./history.js";

const RESET_WORDS = new Set(["reset", "restart", "start over"]);

function secretMatches(provided, expected) {
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createApp({ store = new ConversationStore(), replyFn = generateReply, secret = process.env.WEBHOOK_SECRET } = {}) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Landbot "Webhook" block posts here. See README for the exact block setup.
  app.post("/landbot/webhook", async (req, res) => {
    if (secret && !secretMatches(req.get("x-webhook-secret"), secret)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const message = String(req.body?.message ?? "").trim();
    const customerId = String(req.body?.customer_id ?? "").trim();
    if (!message || !customerId) {
      return res.status(400).json({ error: "message and customer_id are required" });
    }

    if (RESET_WORDS.has(message.toLowerCase())) {
      store.reset(customerId);
      return res.json({ reply: "No problem, let's start fresh. How can I help?", handoff: false });
    }

    const name = String(req.body?.name ?? "").trim();
    const userMessage = name && store.get(customerId).length === 0
      ? `(Customer's name: ${name})\n${message}`
      : message;

    try {
      const { reply, handoff, ok } = await replyFn(store.get(customerId), userMessage);
      if (ok) {
        store.append(customerId, { role: "user", content: userMessage }, { role: "assistant", content: reply });
      }
      return res.json({ reply, handoff });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        console.warn("Claude rate limited:", err.message);
      } else if (err instanceof Anthropic.APIError) {
        console.error(`Claude API error ${err.status}:`, err.message);
      } else {
        console.error("Unexpected error:", err);
      }
      // Always give Landbot something to send, and route to a human.
      return res.json({ reply: FALLBACK_REPLY, handoff: true });
    }
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.WEBHOOK_SECRET) {
    console.warn("WEBHOOK_SECRET is not set: anyone who finds this URL can use your Claude credits.");
  }
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`AI WhatsApp agent listening on port ${port}`));
}
