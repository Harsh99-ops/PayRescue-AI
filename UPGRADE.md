# Upgrade PayRescue AI (existing Windows/Docker installation)

**Do not delete your existing `.env` file, Docker volume, database, or Git repository.** The new version migrates your existing SQLite database in place and starts automated emails **disabled**. No new account is required beyond an eligible Gmail account.

## Upgrade while preserving your buyers, invoices and local ZIP project

1. Download `PAYRESCUE-AI-GMAIL-V2.zip` and place it in `Downloads`.
2. Open PowerShell in your CURRENT project folder. Example:

   ```powershell
   cd 'C:\Users\hp\CPP\ques\.vscode\projects\payrescue-ai'
   docker compose down
   Expand-Archive -Path "$HOME\Downloads\PAYRESCUE-AI-GMAIL-V2.zip" -DestinationPath "$env:TEMP\payrescue-v2" -Force
   Copy-Item -Path "$env:TEMP\payrescue-v2\payrescue-ai\*" -Destination . -Recurse -Force
   ```

   The ZIP does **not** contain a `.env` file. Running `docker compose down` **without** `-v` keeps the named SQLite volume. Extract into the SAME existing project directory so the Compose volume name stays unchanged.

3. Keep your original `APP_PIN`, `SESSION_SECRET`, and PayPal values in `.env`; append the Gmail variables from below using `notepad .env`.
4. Rebuild using `docker compose up --build -d`, then open `http://localhost:8787` and sign in using your existing PIN. **Do not use `docker compose down -v`**, which removes stored data.

## Connect Gmail SMTP

1. Your Google account must have 2-Step Verification on. Where App Passwords are available, create a **new App Password** at https://myaccount.google.com/apppasswords. If your managed Google account does not allow them, use a different eligible account or implement OAuth2 later. **Never use your normal Google password.**
2. In local `.env`, set:

   ```dotenv
   GMAIL_USER=you@gmail.com
   GMAIL_APP_PASSWORD=your-google-app-password
   MAIL_COPY_TO=you@gmail.com
   MAIL_TIMEZONE=Asia/Kolkata
   MAIL_DAILY_CAP=20
   ```

3. Run `docker compose up -d --force-recreate app` (required for changes to .env to reach the container).
4. Go to **Gmail & reminders** > **Verify connection**. Then click **Send test to myself**; check Gmail Sent and Inbox/Spam. Gmail may thread a BCC to your own sending account rather than display it as a separate Inbox message.
5. Add a real buyer email on a new Buyer. **The seeded `*.example` addresses are intentionally blocked.** Open an unpaid invoice > **Draft reminder** > **Send this draft**. Review the email, tick confirmation, and click **Send real email**. The email history stores attempt time, intended recipient, CC/BCC archive, status, and SMTP message ID/error.

## Enable automatic overdue reminders (OFF by default)

1. Go to **Buyers** and enable **Allow automatic reminder emails** for each genuine business contact. This is OFF by default, even for existing buyers. Don't enable without appropriate permission or a valid business relationship.
2. Go to **Gmail & reminders**. Set:
   - **Automatic overdue emails** = ON
   - **Repeat after** = e.g. 3 days
   - **Send hour** = e.g. 10 (10–11 AM; local time based on `MAIL_TIMEZONE`)
   - **Max automated emails per invoice** = e.g. 4
   - **Archive BCC copies** = ON, with optional `MAIL_COPY_TO`
3. Click **Save email settings**.
4. Scheduler runs once per minute while Docker is online and sends only during the specified hour. Eligible invoices must be overdue (including unpaid scheduled installments), have a positive balance, have a real buyer email, and be individually approved. It skips invoices paid in full, avoids duplicate sends using SQLite dedupe keys, honors the repeat interval, and stops after the configured max sends. By default no more than 20 automatic attempts per local date (`MAIL_DAILY_CAP`).

**Important delivery semantics:** A `sent` log means Gmail's SMTP server accepted the message, **not** proof of Inbox delivery, opening or a successful payment. If the SMTP connection is interrupted after Gmail accepts a message, status may be `failed` or `sending`; the scheduler intentionally does not resend automatically the same day. Review the Gmail Sent folder and email history before retrying manually. The app never automatically sends legal drafts or evidence attachments.

## Troubleshooting

```powershell
docker compose ps
docker compose logs --tail=80 app
```

- `Gmail is not configured`: set `.env` variables and run `docker compose up -d --force-recreate app`.
- `Invalid login/535`: use a Google App Password (not your Gmail password), with 2-Step Verification on.
- SMTP timeout: your network/firewall may block outbound port 465.
- No automatic mail: enable global automation and buyer's opt-in, check local send hour, real buyer email, positive overdue balance and max count.
- Buyer replies: go back to Gmail Inbox (the email's `Reply-To` is your Gmail address).
- Gmail password exposed? Revoke the App Password in your Google Account and create a new one; do not publish `.env` or Docker environment output.

The application uses Gmail SMTP via Nodemailer; it does not read or sync your Gmail Inbox. A Gmail App Password provides SMTP authentication for sending; reading incoming replies requires a separate integration.
