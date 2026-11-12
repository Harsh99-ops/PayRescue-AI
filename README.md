# PayRescue AI — Local-first Hackathon Edition

A runnable React + Vite + Express + SQLite seller receivables recovery platform. **V2 adds Gmail SMTP, manual sending of generated drafts, buyer-approved automatic overdue emails, BCC archive copies and persistent email history.** Features include a buyer directory, invoice ledger, installments, late-payment dashboard, payment reconciliation, SHA-256 evidence vault, reminder drafts, disputes/legal review workspace, PDF summaries, PayPal Sandbox Orders/Capture/Refund API support, and a built-in demonstration mode.

> **Works without PayPal, webhooks, cloud deployment, OpenAI, or Node installed on your Windows computer.** Docker Desktop / Engine is enough.

**Already have PayRescue AI running? Start with [UPGRADE.md](UPGRADE.md) to preserve your existing database, `.env` and Docker volume.**

## Quick start — Windows + Docker

1. Extract this ZIP and open the folder in VS Code.
2. Open a terminal (PowerShell) in that folder, then run:

   ```powershell
   Copy-Item .env.example .env
   ```
3. Edit `.env` and replace `APP_PIN` with your own PIN and `SESSION_SECRET` with a random secret of **32 characters or more**. Example generator (PowerShell): `[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')`.
4. Keep `PAYPAL_MODE=demo`. In VS Code terminal:

   ```powershell
   docker compose up --build -d
   ```
5. Open **http://localhost:8787** and sign in with your PIN.
6. For demo sample data click the command below in a new PowerShell terminal after signing in (or create buyer/invoice manually). The seed endpoint needs your session cookie, so the simplest way is to open DevTools on the signed-in dashboard and run:

   ```js
   fetch('/api/demo/seed',{method:'POST'}).then(r=>r.json()).then(console.log).then(()=>location.reload())
   ```

To stop: `docker compose down`. To view logs: `docker compose logs -f app`.

**Persistent database:** stored in the named Docker volume `payrescue_data`. `docker compose down` preserves it; `docker compose down -v` DELETES all user data and uploads.

## Hackathon showcase flow (5 minutes)

1. Start in Demo mode; seed or create 3 buyers and invoices.
2. Open an overdue invoice and demonstrate its amount due and recommended action.
3. Generate a payment reminder or review-only legal summary (template without API key, AI-enhanced with key).
4. Upload a PDF purchase order or transport receipt; notice the SHA-256 hash.
5. Create an installment, then pay partially using **Record demo payment**.
6. Demonstrate an idempotent retry: call the demo payment API twice with an identical `idempotency_key`; second is a duplicate with no second ledger entry.
7. Refund (demo), open a complaint case, change its review stage, download PDF summary.
8. Explain that PayPal Sandbox is an optional payment adapter, not a prerequisite.

## PayPal Sandbox: no webhook ID needed for Checkout + Capture

Set in `.env`:

```dotenv
PAYPAL_MODE=sandbox
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_secret
# PAYPAL_WEBHOOK_ID remains empty until you want external events
```

Restart: `docker compose up -d --force-recreate app`.

1. Create a USD invoice (**use USD** for the demo checkout; INR via standard PayPal cross-border checkout is not supported for this flow).
2. Open invoice > Create PayPal checkout. A separate browser tab opens PayPal Sandbox to approve.
3. After buyer approval, return to PayRescue and click **Capture** on that order.
4. The server checks the returned capture ID, status, currency, and amount and posts the payment once to the SQLite ledger.
5. The server also supports partial refunds via `POST /api/paypal/payments/:paymentId/refund` (use Postman/browser authenticated request).

**No Webhook ID, tunnel, public URL, Render, Vercel or Netlify required for this flow.** The user actively initiates capture through the app. A remote PayPal event will *not* be pushed to a private localhost backend unless you configure a public HTTPS callback.

### Optional PayPal webhooks

The API supports `POST /api/paypal/webhook` and validates signatures with PayPal's `/v1/notifications/verify-webhook-signature` API using `PAYPAL_WEBHOOK_ID`. To test real event deliveries, provide an HTTPS URL forwarding to this route, register that URL in the PayPal Developer Dashboard and set the issued Webhook ID. Do **not** expose the entire dashboard to the internet: place a reverse proxy in front which forwards **only** the webhook path, with an appropriate body-size limit. Docker alone does not create an accessible public URL.

PayPal reference: https://developer.paypal.com/api/rest/webhooks/rest/ and https://developer.paypal.com/docs/api/orders/v2/

## Gmail email sending and scheduled overdue follow-ups

Mail sending requires Gmail App Password authentication (and a Google account eligible for App Passwords), with email credentials stored only in your local `.env`. Add:

```dotenv
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=your-app-password
MAIL_COPY_TO=you@gmail.com
MAIL_TIMEZONE=Asia/Kolkata
MAIL_DAILY_CAP=20
```

Then rebuild or recreate the app container to load the variables. The new **Gmail & reminders** sidebar tab lets you verify the SMTP connection, send a test message to yourself, review email history, and configure scheduled reminders. Open an invoice to **Draft reminder → Send this draft** or **Send email reminder**. Manual emails require an explicit confirmation and a real buyer email (not the fictional seeded `.example` addresses). Gmail sends via `smtp.gmail.com:465` with TLS and Nodemailer. Copies are archived via BCC to `MAIL_COPY_TO` (default your Gmail) and Gmail usually lists sent mail in its Sent folder.

**Default safe behavior:** Automatic reminders are DISABLED by default. Every buyer also has an individual consent/eligibility toggle OFF by default. The scheduler only runs while Docker is online, at the configured local hour, and respects overdue invoice/installment dates, interval, maximum count and daily cap. Payments that settle the invoice stop reminders. An SMTP 'sent' entry means accepted by Gmail's SMTP server, not guaranteed inbox delivery. A crash/network ambiguity may result in a missed reminder rather than a duplicate; check Sent and email history.

See [UPGRADE.md](UPGRADE.md) for setup, copy behavior, safety and troubleshooting. 

## Optional AI draft generation

Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL`; without an API key, the app generates useful structured templates. Legal content is always a preliminary draft requiring human/advocate review. The app does not automatically send SMS, legal drafts, file complaints, or claim legal eligibility. **Avoid using actual sensitive debtor data in a public hackathon demonstration.**

## Development without Docker

Install Node 22+, run `npm install`, `npm run dev`, then visit http://localhost:5173. The Express API runs on port 8787; Vite proxies `/api` to it. Create `.env` values in your shell first (Node does not automatically read .env outside Docker); alternatively run `node --env-file=.env server/index.js` for the API and `npx vite` for the UI in separate terminals. `npm run build` and `npm start` for single-server production mode.

## Test and performance targets

- `npm test` runs **48 core and email-rule unit tests** for money, statuses and recovery recommendations; tests are included as a baseline, not a substitute for real integration tests.
- `node tests/load.js` runs an **opt-in local-only** 1,000-request smoke test at 100 concurrent workers against `/api/health` and reports P95 latency and requests/sec. **Target**: 100 RPS and P95 under 150 ms; do not claim this was achieved until you run it on your own machine.
- Repeatable payment and refund testing is covered by DB uniqueness/transactions and API-level idempotency keys, but a full set of 30 payment integration tests is not yet implemented. Additional regression work is recommended before production use.

## New email endpoints (authenticated)

| Method | Endpoint | Purpose |
|---|---|---|
| GET/POST | `/api/email/settings` | SMTP status and scheduled reminder settings (POST to change) |
| GET | `/api/email/history` | most recent 150 delivery attempts |
| POST | `/api/email/verify` | verify SMTP authentication without sending |
| POST | `/api/email/test` | explicitly send a test to GMAIL_USER |
| PATCH | `/api/buyers/:id/auto-email` | buyer opt-in for automation |
| GET | `/api/invoices/:id/email-preview` | safe recipient and reminder preview |
| POST | `/api/invoices/:id/send-email` | explicitly approved, idempotent manual sending |
| GET | `/api/invoices/:id/email-history` | invoice-specific delivery history |

## Key endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | container health |
| POST | `/api/login` | PIN login |
| GET/POST | `/api/buyers` | buyer management |
| GET/POST | `/api/invoices` | invoice ledger |
| GET | `/api/invoices/:id` | full detail, installments, evidence, cases, payments |
| POST | `/api/invoices/:id/installments` | add installment |
| POST | `/api/invoices/:id/demo-payment` | record idempotent demo capture |
| POST | `/api/invoices/:id/demo-refund` | demo refund |
| POST | `/api/invoices/:id/paypal-order` | PayPal order create |
| POST | `/api/paypal/orders/:id/capture` | PayPal capture |
| POST | `/api/paypal/payments/:id/refund` | PayPal refund |
| POST | `/api/paypal/webhook` | signed PayPal events |
| POST | `/api/invoices/:id/draft` | AI or template draft |
| POST | `/api/invoices/:id/evidence` | document upload |
| POST | `/api/invoices/:id/cases` | complaint record |
| POST | `/api/cases/:id/stage` | complaint stage |
| GET | `/api/invoices/:id/summary.pdf` | export PDF |
| GET | `/api/overview` | dashboard metrics |
| POST | `/api/demo/seed` | sample data in demo mode |

## Security boundaries and caveats

This is a **hackathon/local development app**, not audited financial software. The PIN + cookie session is for localhost use only. Add proper user accounts, HTTPS and secure cookies, CSRF protection, access control, privacy/legal compliance, backup strategy, audit logs, malware scanning of uploads, strong webhook reconciliation, payout/chargeback handling, and production-grade idempotency before offering it publicly. Uploaded documents are private only insofar as the local app and Docker host are secured. PayPal webhook verification requires actual verified PayPal communication. Demo events are NOT authentic PayPal events.

### DBeaver / SQLite

SQLite lives in the Docker named volume at `/app/data/payrescue.sqlite`; do not live-edit that file while app is running. For offline exploration, stop the app and copy the `.sqlite` database (and WAL files if relevant) or use a SQLite backup workflow.
