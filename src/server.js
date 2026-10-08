import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import { waitUntil } from "@vercel/functions";
import { checkClaude } from "./agent.js";
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
  claudeCheck = checkClaude,
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

  // Remembers what last happened, for the /status page. Never blocks a reply.
  const note = (key, value) =>
    store.setStatus?.(key, { at: new Date().toISOString(), ...value })?.catch?.(() => {});

  app.post("/whatsapp/webhook", (req, res) => {
    const appSecret = env.WHATSAPP_APP_SECRET;
    if (!appSecret && requireSecrets) {
      background(note("webhook", { result: "rejected: WHATSAPP_APP_SECRET is not set in Vercel" }));
      return res.status(500).json({ error: "WHATSAPP_APP_SECRET is not configured" });
    }
    if (appSecret && !verifySignature(req.rawBody, req.get("x-hub-signature-256"), appSecret)) {
      background(note("webhook", { result: "rejected: signature didn't match WHATSAPP_APP_SECRET" }));
      return res.sendStatus(401);
    }

    // Acknowledge straight away (Meta retries slow webhooks) and reply in the background.
    const messages = extractMessages(req.body);
    res.sendStatus(200);
    background(note("webhook", { result: "accepted", customerMessages: messages.length }));
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

        const { reply, error } = await handleCustomerMessage({
          store,
          leads,
          replyFn,
          customerId: `wa:${msg.from}`,
          phone: `+${msg.from}`,
          name: msg.name,
          text: msg.text,
        });
        if (error) await note("lastError", { where: "Claude", message: error });
        await whatsapp.sendText(msg.from, reply);
        await note("lastReply", { to: `…${msg.from.slice(-4)}` });
      } catch (err) {
        console.error(`Failed to handle WhatsApp message ${msg.id}:`, err);
        await note("lastError", { where: "sending the reply", message: err.message });
      }
    }
  }

  // ---- Status page -------------------------------------------------------

  // A plain-English health check of every connection. Protected by the
  // webhook verify token: /status?key=<WHATSAPP_VERIFY_TOKEN>
  app.get("/status", async (req, res) => {
    const key = env.WHATSAPP_VERIFY_TOKEN || env.WEBHOOK_SECRET;
    if (!key || !secretMatches(req.query.key, key)) return res.sendStatus(403);

    const check = async (fn) => {
      try { return `OK: ${await fn()}`; } catch (err) { return `PROBLEM: ${err.message}`; }
    };
    const has = (name) => (env[name] ? "set" : "MISSING");
    const fmt = (v) => (v ? JSON.stringify(v) : "nothing recorded yet");

    const lines = [
      "NWM WhatsApp assistant: status",
      "",
      "Settings in Vercel:",
      ...["ANTHROPIC_API_KEY", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "AIRTABLE_TOKEN"]
        .map((n) => `  ${n}: ${has(n)}`),
      `  Memory: ${store.constructor.name === "RedisConversationStore" ? "Redis (good)" : "RAM only (connect Upstash Redis)"}`,
      "",
      "Connections:",
      `  Claude: ${await check(() => claudeCheck())}`,
      `  WhatsApp: ${await check(() => whatsapp.checkPhoneNumber())}`,
      `  Airtable: ${leads.enabled ? await check(() => leads.check()) : "not connected (AIRTABLE_TOKEN missing)"}`,
      "",
      "Recent activity:",
      `  Last message from Meta: ${fmt(await store.getStatus?.("webhook"))}`,
      `  Last reply sent: ${fmt(await store.getStatus?.("lastReply"))}`,
      `  Last error: ${fmt(await store.getStatus?.("lastError"))}`,
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

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
