import crypto from "node:crypto";

// Helpers for the WhatsApp Business Cloud API (Meta).

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
const MAX_TEXT_LENGTH = 4096;

/** Checks Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!rawBody || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Pulls customer messages out of a webhook payload. Delivery/read status
 * updates are ignored.
 * @returns {Array<{id: string, from: string, name: string, text: string | null, type: string}>}
 */
export function extractMessages(payload) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? ""]));
      for (const msg of value.messages ?? []) {
        out.push({
          id: msg.id,
          from: msg.from,
          name: names.get(msg.from) ?? "",
          type: msg.type,
          text: messageText(msg),
        });
      }
    }
  }
  return out;
}

function messageText(msg) {
  switch (msg.type) {
    case "text":
      return msg.text?.body ?? null;
    case "button":
      return msg.button?.text ?? null;
    case "interactive":
      return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null;
    default:
      return null; // images, voice notes, stickers, locations...
  }
}

export class WhatsAppClient {
  constructor({
    token = process.env.WHATSAPP_TOKEN,
    phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID,
    fetchFn = fetch,
  } = {}) {
    this.token = token;
    this.phoneUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}`;
    this.url = `${this.phoneUrl}/messages`;
    this.fetch = fetchFn;
  }

  async #post(body) {
    const res = await this.fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return res.json();
  }

  /** Confirms the token and phone number ID work. Used by /status. */
  async checkPhoneNumber() {
    const res = await this.fetch(`${this.phoneUrl}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    return `${body.verified_name ?? "?"} (${body.display_phone_number ?? "?"})`;
  }

  sendText(to, text) {
    const body = text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
    return this.#post({ to, type: "text", text: { body, preview_url: true } });
  }

  /** Shows blue ticks and a "typing…" indicator while Claude writes the reply. */
  markReadAndTyping(messageId) {
    return this.#post({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });
  }
}
