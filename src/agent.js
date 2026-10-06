import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

// Written as a literal URL so Vercel's bundler sees knowledge.md and ships it.
const DEFAULT_KNOWLEDGE = new URL("../knowledge.md", import.meta.url);

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
export const HANDOFF_TOKEN = "[HANDOFF]";

const FALLBACK_REPLY =
  "Sorry, I couldn't answer that just now. A member of our team will get back to you shortly.";

let systemPrompt;
function buildSystemPrompt() {
  systemPrompt ??= renderSystemPrompt(fs.readFileSync(process.env.KNOWLEDGE_FILE || DEFAULT_KNOWLEDGE, "utf8"));
  return systemPrompt;
}

function renderSystemPrompt(knowledge) {
  return `You are the WhatsApp assistant for the business described below. You chat with customers on WhatsApp.

How to reply:
- Keep replies short and friendly: usually 1-4 sentences. This is a phone chat, not an email.
- WhatsApp formatting only: *bold*, _italic_, plain line breaks and simple "-" lists. No headings, tables or markdown links; paste URLs as plain text.
- Reply in the language the customer writes in.
- Only state facts that are in the business information below. If you don't know something, say so and offer to connect them with the team. Never invent prices, dates, policies or availability.
- If the customer asks for a human, is upset, wants to make a payment or account change, or needs something you can't answer from the information below, write a short reply saying a team member will follow up, and end your message with ${HANDOFF_TOKEN} on its own line.

<business_information>
${knowledge}
</business_information>`;
}

let cachedClient;
function defaultClient() {
  cachedClient ??= new Anthropic({ timeout: 25_000, maxRetries: 1 });
  return cachedClient;
}

/**
 * Ask Claude for the next reply in a conversation.
 * @param {Array<{role: "user" | "assistant", content: string}>} history  earlier turns
 * @param {string} userMessage  the customer's new message
 * @returns {Promise<{reply: string, handoff: boolean, ok: boolean}>}
 */
export async function generateReply(history, userMessage, { client = defaultClient() } = {}) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2048,
    // Chat replies don't need deep reasoning; low effort keeps WhatsApp responses fast and cheap.
    output_config: { effort: "low" },
    // If a safety classifier declines, the API retries on a recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
    messages: [...history, { role: "user", content: userMessage }],
  });

  if (response.stop_reason === "refusal") {
    return { reply: FALLBACK_REPLY, handoff: true, ok: false };
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) return { reply: FALLBACK_REPLY, handoff: true, ok: false };

  const handoff = text.includes(HANDOFF_TOKEN);
  const reply = text.replaceAll(HANDOFF_TOKEN, "").trim();
  return { reply: reply || FALLBACK_REPLY, handoff, ok: true };
}

export { FALLBACK_REPLY };
