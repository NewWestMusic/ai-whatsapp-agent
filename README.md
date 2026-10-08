# AI WhatsApp agent (WhatsApp Cloud API + Claude)

A WhatsApp assistant for New West Music. Customers message your WhatsApp
number, Meta forwards each message to this server, Claude writes the reply
using `knowledge.md`, and the server sends it back on WhatsApp.

Along the way the assistant:

- **records leads** in the **WhatsApp Leads** table (Airtable base
  "Facebook Lead Forms Tracker"), one row per WhatsApp number, updated as it
  learns the student's name, age, instrument and preferred times;
- **offers two ways to book a demo**: the right teacher's Google Calendar
  booking link, or "leave your details and the team sends options";
- **flags conversations for staff** (refunds, billing, complaints, anything
  it can't answer) by ticking *Needs Team Follow-up* on the lead with a reason.

```
Customer ──WhatsApp──▶ Meta Cloud API ──webhook──▶ this server (Vercel) ──▶ Claude
                                                        │
                                                        ├──▶ Airtable: WhatsApp Leads
                                                        └──▶ reply via Meta Cloud API
```

The old Landbot endpoint (`/landbot/webhook`) still works if you ever go back
to Landbot; it shares the same brain and lead capture.

## What you need

| Thing | Where | Env var |
|---|---|---|
| Anthropic API key | console.anthropic.com → API Keys (billed separately from a claude.ai plan) | `ANTHROPIC_API_KEY` |
| Meta app secret | Meta app → App settings → Basic → App secret | `WHATSAPP_APP_SECRET` |
| WhatsApp access token (permanent) | Business Settings → System users (see below) | `WHATSAPP_TOKEN` |
| Phone number ID | Meta app → WhatsApp → API Setup | `WHATSAPP_PHONE_NUMBER_ID` |
| Webhook verify token | Any random string you make up | `WHATSAPP_VERIFY_TOKEN` |
| Airtable token | airtable.com/create/tokens | `AIRTABLE_TOKEN` |
| Redis (conversation memory) | Vercel → Storage → Upstash for Redis | `KV_REST_API_URL`, `KV_REST_API_TOKEN` (added automatically) |

## Setup

### 1. Airtable token
1. Go to https://airtable.com/create/tokens → **Create token**.
2. Scopes: `data.records:read` and `data.records:write`.
3. Access: only the **Facebook Lead Forms Tracker** base.
4. Copy the token into Vercel as `AIRTABLE_TOKEN`.

### 2. Meta app and WhatsApp number
1. At https://developers.facebook.com → **My Apps → Create app**, choose the
   WhatsApp use case and connect it to your (verified) business portfolio.
2. In **WhatsApp → API Setup**, add your business phone number and verify it
   by SMS or call. The number can't be active on the regular WhatsApp or
   WhatsApp Business app at the same time; delete that WhatsApp account on
   the phone first. Copy the **Phone number ID** into `WHATSAPP_PHONE_NUMBER_ID`.
3. **Permanent token:** in Meta Business Settings → **Users → System users**,
   add a system user (Admin), assign it your app and WhatsApp account with
   full control, then **Generate token** for the app with the permissions
   `whatsapp_business_messaging` and `whatsapp_business_management`. Put it in
   `WHATSAPP_TOKEN`. (The temporary token on the API Setup page expires in 24 hours.)
4. Copy **App settings → Basic → App secret** into `WHATSAPP_APP_SECRET`.
5. Add a payment method to the WhatsApp account (WhatsApp Manager → Payment
   settings). Replies to customers who message you first are free within the
   24-hour window, but Meta requires one on file.

### 3. Vercel
1. Add all the env vars above (Settings → Environment Variables, Production)
   and redeploy.
2. Check https://ai-whatsapp-agent-eight.vercel.app/health shows `{"ok":true}`.

### 4. Connect the webhook
1. In the Meta app: **WhatsApp → Configuration → Webhook → Edit**.
2. Callback URL: `https://ai-whatsapp-agent-eight.vercel.app/whatsapp/webhook`
3. Verify token: your `WHATSAPP_VERIFY_TOKEN`. Click **Verify and save**.
4. Under **Webhook fields**, subscribe to **messages**.
5. Set the app to **Live** (App Mode toggle / Publish) so real customers can reach it.

### 5. Test
Message the number from your own phone:
- "Hi, do you teach piano for a 6 year old?" → the bot offers a teacher's
  booking link or to have the team send options, and a row appears in
  **WhatsApp Leads**.
- "I'd like a refund" → *Needs Team Follow-up* gets ticked with a reason.

If nothing comes back, check Vercel → **Logs**. Common causes: wrong
`WHATSAPP_APP_SECRET` (401s), an expired token (WhatsApp API 401), or the
webhook not subscribed to **messages**.

## Day to day

- **Knowledge, prices, policies, booking links:** edit `knowledge.md`. Every
  push redeploys automatically. Send only one teacher link per reply; the
  bot is told never to send the whole list or the master calendar.
- **Leads:** watch the WhatsApp Leads table. Filter on *Needs Team Follow-up*
  for chats that need a person, and *Booking Path = Team to send options* for
  families waiting for times.
- **Replying as a person:** the WhatsApp Cloud API has no inbox of its own,
  so staff follow up by phone or email from the lead row. If you want staff to
  reply inside WhatsApp, look into a shared inbox tool, or WhatsApp's
  "coexistence" setup that lets the WhatsApp Business app and the API share a number.
- A customer can type `reset` to clear their conversation memory.

## Notes

- **Memory:** last 20 messages per customer for 6 hours, in Upstash Redis
  (falls back to RAM when Redis isn't configured, e.g. local dev).
- **Model:** `claude-opus-5-5` at low effort, for quick replies. Override with `CLAUDE_MODEL`.
- **Security:** the WhatsApp webhook only accepts requests signed with your
  Meta app secret, and the server refuses to run on Vercel without it.
- **Local dev:** `npm install`, copy `.env.example` to `.env`, `npm run dev`,
  and expose port 3000 with a tunnel (e.g. `ngrok http 3000`) for Meta.
- **Tests:** `npm test`.
