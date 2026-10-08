import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { INSTRUMENT_OPTIONS } from "./leads.js";

// Written as a literal URL so Vercel's bundler sees knowledge.md and ships it.
const DEFAULT_KNOWLEDGE = new URL("../knowledge.md", import.meta.url);

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 4;

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
- Only state facts that are in the business information below. If you don't know something, say so and offer to connect them with the team. Never invent prices, dates, policies, teachers or availability.
- Ask at most one question per message.

Leads:
- When someone is interested in lessons, find out (over a few messages, not all at once) the parent's name, the student's name and age, the instrument, and whether they'd like to book a demo themselves or have the team send times.
- Call save_lead as soon as you know the instrument or the person's name, and again whenever you learn something new. Each call updates the same record, so include everything known so far.
- Don't ask for a phone number; you already have their WhatsApp number.

Handing over:
- If the customer asks for a person, is upset, raises a refund, billing or payment issue, wants to withdraw, or needs something you can't answer from the information below, call flag_for_team, then tell them a team member will follow up during office hours.

<business_information>
${knowledge}
</business_information>`;
}

const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });

export const TOOLS = [
  {
    name: "save_lead",
    description:
      "Create or update this customer's lead record in the school's CRM. Call whenever you learn new details about a prospective student. Every call overwrites the record, so pass everything known so far; use null for unknown fields.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["parent_name", "student_name", "student_age", "email", "instruments", "preferred_times", "location", "booking_path", "notes"],
      properties: {
        parent_name: { ...nullable("string"), description: "Name of the person chatting (parent, or the adult student)." },
        student_name: { ...nullable("string"), description: "Student's name, if different from the person chatting." },
        student_age: { ...nullable("number"), description: "Student's age in years." },
        email: nullable("string"),
        instruments: {
          type: "array",
          items: { type: "string", enum: INSTRUMENT_OPTIONS },
          description: "Instruments of interest. Electric guitar counts as Guitar; group piano for ages 3-5 is '123 (Preschool Piano)'.",
        },
        preferred_times: { ...nullable("string"), description: "Preferred days and times, in the customer's words." },
        location: {
          anyOf: [{ type: "string", enum: ["Princess Street", "6th Street", "Online", "In-home", "No preference"] }, { type: "null" }],
        },
        booking_path: {
          anyOf: [{ type: "string", enum: ["Sent demo booking link", "Team to send options"] }, { type: "null" }],
          description: "Which booking route the customer chose, if any yet.",
        },
        notes: { ...nullable("string"), description: "Anything else useful for the team: level, goals, questions asked." },
      },
    },
  },
  {
    name: "flag_for_team",
    description:
      "Flag this conversation for a staff member to follow up personally. Use for requests for a person, complaints, refunds, billing or payment issues, withdrawals, or anything you can't answer.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["reason", "summary"],
      properties: {
        reason: { type: "string", description: "Short category, e.g. 'Billing question' or 'Asked for a person'." },
        summary: { type: "string", description: "One or two sentences the team can act on without reading the chat." },
      },
    },
  },
];

let cachedClient;
function defaultClient() {
  cachedClient ??= new Anthropic({ timeout: 25_000, maxRetries: 1 });
  return cachedClient;
}

/**
 * Ask Claude for the next reply in a conversation, running any tool calls.
 * @param {Array<{role: "user" | "assistant", content: string}>} history  earlier turns (text only)
 * @param {string} userMessage  the customer's new message
 * @param {{ saveLead?: (input: object) => Promise<string>, flagForTeam?: (input: object) => Promise<string> }} [actions]
 * @returns {Promise<{reply: string, handoff: boolean, ok: boolean}>}
 */
export async function generateReply(history, userMessage, { client = defaultClient(), actions = {} } = {}) {
  // Earlier turns are replayed as plain text. Within this turn, assistant
  // content (including thinking blocks) is appended back unchanged, as the
  // API requires for tool use.
  const messages = [...history, { role: "user", content: userMessage }];
  let handoff = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4096,
      // Chat replies don't need deep reasoning; low effort keeps WhatsApp responses fast and cheap.
      output_config: { effort: "low" },
      // If a safety classifier declines, the API retries on a recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { reply: FALLBACK_REPLY, handoff: true, ok: false };
    }

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    if (response.stop_reason === "tool_use" && toolUses.length) {
      messages.push({ role: "assistant", content: response.content });
      const results = await Promise.all(toolUses.map((use) => runTool(use, actions)));
      if (toolUses.some((use) => use.name === "flag_for_team")) handoff = true;
      messages.push({ role: "user", content: results });
      continue;
    }

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) return { reply: FALLBACK_REPLY, handoff: true, ok: false };
    return { reply: text, handoff, ok: true };
  }

  return { reply: FALLBACK_REPLY, handoff: true, ok: false };
}

async function runTool(use, actions) {
  const handler = { save_lead: actions.saveLead, flag_for_team: actions.flagForTeam }[use.name];
  try {
    if (!handler) throw new Error(`${use.name} is not available right now`);
    const result = await handler(use.input);
    return { type: "tool_result", tool_use_id: use.id, content: result || "Done." };
  } catch (err) {
    console.error(`Tool ${use.name} failed:`, err.message);
    return {
      type: "tool_result",
      tool_use_id: use.id,
      is_error: true,
      content: `Failed: ${err.message}. Carry on helping the customer; don't mention technical problems.`,
    };
  }
}

export { FALLBACK_REPLY };
