import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import { waitUntil } from "@vercel/functions";
import { handleCustomerMessage } from "./conversation.js";
import { createStore } from "./history.js";
import { AirtableLeads } from "./leads.js";
import { WhatsAppClient, extractMessages, verifySignature } from "./whatsapp.js";

// Written as a literal URL so Vercel's bundler ships the file. Meta requires a
// privacy policy URL before an app can be published.
const PRIVACY_POLICY = new URL("../public/privacy.html", import.meta.url);

const UNSUPPORTED_MEDIA_REPLY =
  "Thanks! I can only read text messages at the moment. Could you type your question?";

function secretMatches(provided, expected) {
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createApp({
  store = createStore(),
  leads = new AirtableLeads(),
  whatsapp = new WhatsAppClient(),
  replyFn,
  env = process.env,
  // On a public host, never run without authentication: anyone could spend your Claude credits.
  requireSecrets = Boolean(env.VERCEL),
  background = waitUntil,
} = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  let privacyHtml;
  app.get(["/privacy", "/privacy.html"], (_req, res) => {
    privacyHtml ??= fs.readFileSync(PRIVACY_POLICY, "utf8");
    res.type("html").send(privacyHtml);
  });

  // ---- WhatsApp Cloud API (Meta) ----------------------------------------

  // Meta calls this once when you save the webhook URL in the app dashboard.
  app.get("/whatsapp/webhook", (req, res) => {
    const verifyToken = env.WHATSAPP_VERIFY_TOKEN;
    if (
      verifyToken &&
      req.query["hub.mode"] === "subscribe" &&
      secretMatches(req.query["hub.verify_token"], verifyToken)
    ) {
      return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
    }
    return res.sendStatus(403);
  });

  app.post("/whatsapp/webhook", (req, res) => {
    const appSecret = env.WHATSAPP_APP_SECRET;
    if (!appSecret && requireSecrets) {
      return res.status(500).json({ error: "WHATSAPP_APP_SECRET is not configured" });
    }
    if (appSecret && !verifySignature(req.rawBody, req.get("x-hub-signature-256"), appSecret)) {
      return res.sendStatus(401);
    }

    // Acknowledge straight away (Meta retries slow webhooks) and reply in the background.
    const messages = extractMessages(req.body);
    res.sendStatus(200);
    if (messages.length) background(processWhatsAppMessages(messages));
  });

  async function processWhatsAppMessages(messages) {
    for (const msg of messages) {
      try {
        if (!(await store.claimMessage(msg.id))) continue; // duplicate delivery
        whatsapp.markReadAndTyping(msg.id).catch((err) => console.warn("Typing indicator failed:", err.message));

        if (!msg.text) {
          await whatsapp.sendText(msg.from, UNSUPPORTED_MEDIA_REPLY);
          continue;
        }

        const { reply } = await handleCustomerMessage({
          store,
          leads,
          replyFn,
          customerId: `wa:${msg.from}`,
          phone: `+${msg.from}`,
          name: msg.name,
          text: msg.text,
        });
        await whatsapp.sendText(msg.from, reply);
      } catch (err) {
        console.error(`Failed to handle WhatsApp message ${msg.id}:`, err);
      }
    }
  }

  // ---- Landbot (optional) -----------------------------------------------

  // Landbot "Webhook" block posts here. See README for the block setup.
  app.post("/landbot/webhook", async (req, res) => {
    const secret = env.WEBHOOK_SECRET;
    if (!secret && requireSecrets) {
      return res.status(500).json({ error: "WEBHOOK_SECRET is not configured" });
    }
    if (secret && !secretMatches(req.get("x-webhook-secret"), secret)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const text = String(req.body?.message ?? "").trim();
    const customerId = String(req.body?.customer_id ?? "").trim();
    if (!text || !customerId) {
      return res.status(400).json({ error: "message and customer_id are required" });
    }

    const result = await handleCustomerMessage({
      store,
      leads,
      replyFn,
      customerId,
      phone: /^\+?\d{7,15}$/.test(customerId) ? `+${customerId.replace(/^\+/, "")}` : undefined,
      name: String(req.body?.name ?? "").trim(),
      text,
    });
    return res.json(result);
  });

  return app;
}

// Vercel imports this default export and serves it as a function.
const app = createApp();
export default app;

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`AI WhatsApp agent listening on port ${port}`));
}
