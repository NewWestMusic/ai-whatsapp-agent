# Worklog: NWM WhatsApp AI Assistant

## Done
- **Built the AI server** (Node.js + Claude): answers parent questions from `knowledge.md`, remembers each chat (last 20 messages, 6 h).
- **Knowledge base** filled from the NWM Master FAQ + office email templates: prices, policies, studios, demo price ($17.50), registration links, teacher Google Calendar booking links, office hours.
- **Deployed to Vercel**: https://ai-whatsapp-agent-eight.vercel.app (auto-redeploys on every push), with Upstash Redis for chat memory.
- **Landbot attempt**: connected, but Meta disabled that WhatsApp Business account (Oct 8). Appeal/Landbot support route noted; moved on.
- **Switched to WhatsApp Cloud API directly** (own Meta app, new stable business account):
  - Webhook at `/whatsapp/webhook`, verified with Meta; signature-checked; ignores duplicate deliveries.
  - App published; privacy policy hosted at `/privacy` (incl. data-deletion instructions).
  - Test number +1 555 650 4504 set up.
- **Lead capture**: new **WhatsApp Leads** table in Airtable (Facebook Lead Forms Tracker base), separate from Facebook leads. One row per WhatsApp number, updated as the bot learns details.
- **Booking**: two routes: teacher's Google Calendar demo link, or "team sends options" (lead flagged).
- **Staff handoff**: refunds, billing, complaints, data deletion and unknown questions tick *Needs Team Follow-up* with a reason.
- **Safety**: secrets only in Vercel env vars, webhook auth, spending limit recommended.
- **Cost estimate**: ~2–5¢ per message, ~$25–50/month at 150 conversations.

## In progress / next
- [ ] Confirm bot replies on the test number (run `POST {WABA_ID}/subscribed_apps` in Graph API Explorer if no webhook hits in Vercel Logs).
- [ ] Verify Meta account email → generate **permanent** access token → update `WHATSAPP_TOKEN` in Vercel.
- [ ] Create Airtable token → add `AIRTABLE_TOKEN` in Vercel → test lead saving.
- [ ] Get a **dedicated phone number** for the bot (prepaid SIM or SMS-capable VoIP), register it in Meta production setup, update `WHATSAPP_PHONE_NUMBER_ID`.
- [ ] Start Meta **Business verification**; add payment method; display name "New West Music".
- [ ] Set a monthly spending limit in the Anthropic console; review usage after week 1.

## Open questions
- Semi-private rates: $24/$36/$47 (chosen) vs $23/$35/$46 in office notes. Which is correct?
- Fill *Google Booking Link* / *Show in Chatbot* in the Airtable Teachers table so the bot can read links live?
- How staff reply to WhatsApp chats (shared inbox tool or coexistence) vs phone/email follow-up.
