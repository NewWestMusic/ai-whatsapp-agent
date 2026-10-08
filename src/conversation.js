import { generateReply as defaultReplyFn, FALLBACK_REPLY } from "./agent.js";

const RESET_WORDS = new Set(["reset", "restart", "start over"]);

/**
 * Handles one customer message end to end: memory, Claude, and lead tools.
 * Shared by the WhatsApp Cloud API webhook and the Landbot webhook.
 * @returns {Promise<{reply: string, handoff: boolean}>}
 */
export async function handleCustomerMessage({ store, leads, replyFn = defaultReplyFn, customerId, phone, name, text }) {
  if (RESET_WORDS.has(text.trim().toLowerCase())) {
    await store.reset(customerId);
    return { reply: "No problem, let's start fresh. How can I help?", handoff: false };
  }

  const history = await store.get(customerId);
  const userMessage = name && history.length === 0 ? `(Customer's WhatsApp name: ${name})\n${text}` : text;

  const writeLead = async (fields) => {
    if (!leads?.enabled) throw new Error("lead storage is not configured");
    const existingId = await store.getLeadId(customerId);
    const recordId = await leads.upsert(existingId, { phone, ...fields });
    if (recordId !== existingId) await store.setLeadId(customerId, recordId);
  };

  const actions = {
    saveLead: async (input) => {
      const isNew = !(await store.getLeadId(customerId));
      await writeLead({ ...input, status: isNew ? "New" : undefined });
      return "Saved.";
    },
    flagForTeam: async ({ reason, summary }) => {
      const isNew = !(await store.getLeadId(customerId));
      await writeLead({
        follow_up_reason: `${reason}: ${summary}`,
        ...(isNew && { parent_name: name || null, status: "New" }),
      });
      return "The team has been notified.";
    },
  };

  try {
    const { reply, handoff, ok } = await replyFn(history, userMessage, { actions });
    if (ok) {
      await store.append(customerId, { role: "user", content: userMessage }, { role: "assistant", content: reply });
    }
    return { reply, handoff };
  } catch (err) {
    console.error("Failed to generate a reply:", err);
    return { reply: FALLBACK_REPLY, handoff: true };
  }
}
