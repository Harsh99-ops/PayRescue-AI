import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { db, invoiceSQL, getInvoice } from './db.js';
import { major } from './core.js';
import {validRealEmail,localClock,shouldAutoSend,overdueDueDate} from './emailRules.js';
export {validRealEmail} from './emailRules.js';

const utcNow = () => new Date().toISOString();
const settingsStmt = () => db.prepare('SELECT * FROM email_settings WHERE id=1').get();
export const isMailConfigured = () => Boolean(process.env.GMAIL_USER?.trim() && process.env.GMAIL_APP_PASSWORD?.trim());
export function getEmailSettings() {
  const row = settingsStmt();
  const timezone = process.env.MAIL_TIMEZONE || 'Asia/Kolkata';
  return {
    automatic_enabled: Boolean(row.auto_enabled),
    interval_days: row.interval_days,
    send_hour: row.send_hour,
    max_per_invoice: row.max_per_invoice,
    copy_enabled: Boolean(row.copy_enabled),
    timezone,
    configured: isMailConfigured(),
    from_address: process.env.GMAIL_USER || '',
    copy_target: process.env.MAIL_COPY_TO || process.env.GMAIL_USER || '',
    buyer_opt_in_count: db.prepare('SELECT COUNT(*) n FROM buyers WHERE auto_email_opt_in=1').get().n,
  };
}
export function updateEmailSettings(input) {
  const auto = input.automatic_enabled === true ? 1 : 0;
  const interval = Number(input.interval_days), hour = Number(input.send_hour), max = Number(input.max_per_invoice);
  if (![interval,hour,max].every(Number.isInteger) || interval < 1 || interval > 30 || hour < 0 || hour > 23 || max < 1 || max > 12) throw Error('Reminder interval must be 1–30 days, hour 0–23, maximum 1–12');
  if (auto && !isMailConfigured()) throw Error('Set GMAIL_USER and GMAIL_APP_PASSWORD in .env before enabling automatic emails');
  db.prepare('UPDATE email_settings SET auto_enabled=?, interval_days=?, send_hour=?, max_per_invoice=?, copy_enabled=? WHERE id=1').run(auto, interval, hour, max, input.copy_enabled === true ? 1 : 0);
  return getEmailSettings();
}
function transporter() {
  if (!isMailConfigured()) throw Error('Gmail is not configured. Add GMAIL_USER and GMAIL_APP_PASSWORD to .env and recreate the app container.');
  return nodemailer.createTransport({host:'smtp.gmail.com', port:465, secure:true, auth:{user:process.env.GMAIL_USER.trim(), pass:process.env.GMAIL_APP_PASSWORD.replace(/\s/g,'')},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:25000});
}
export async function verifyGmail() { await transporter().verify(); return {ok:true}; }
export function reminderText(inv, overdueDate=null) {
  const outstanding = inv.amount_cents-inv.paid_cents;
  const debtLine = overdueDate && overdueDate!==inv.due_date
    ? `An installment due on ${overdueDate} remains unpaid under invoice ${inv.number}. The current invoice balance is ${inv.currency} ${major(outstanding)} (final invoice due date: ${inv.due_date}).`
    : `Our records show that invoice ${inv.number} has an outstanding balance of ${inv.currency} ${major(outstanding)}, due on ${inv.due_date}.`;
  return {
    subject:`Payment follow-up: invoice ${inv.number}`,
    body:`Dear ${inv.buyer_name},\n\n${debtLine}\n\nCould you please confirm your expected payment date, or let us know if you have already paid? If you need to discuss installment options, please reply to this email.\n\nThank you,\nAccounts Team`,
  };
}
function toEmail(input) {const addr=String(input||'').trim();if(!validRealEmail(addr))throw Error('Please use a valid, real buyer email address. Demo addresses ending in .example cannot receive mail.');return addr;}
function cleanText(input,limit,name) {const v=String(input||'').trim();if(!v||v.length>limit||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v))throw Error(`${name} is missing or too long`);return v;}
function safeCopyAddress(){const v=process.env.MAIL_COPY_TO?.trim()||process.env.GMAIL_USER?.trim();return v&&validRealEmail(v)?v:undefined;}
function sanitizeEmailError(e){const m=String(e?.code||'')+' '+String(e?.responseCode||'')+' '+String(e?.message||'SMTP error');return m.replaceAll(process.env.GMAIL_APP_PASSWORD||'\u0000','[redacted]').slice(0,500);}

// Each message is claimed before delivery. A duplicate request never sends twice.
// In an uncertain network failure we keep the attempt in history rather than silently retrying.
export async function deliverEmail({invoiceId=null,kind,recipient,subject,body,dedupeKey,scheduledOn=null}) {
  const to=toEmail(recipient),from=toEmail(process.env.GMAIL_USER),subj=cleanText(subject,180,'Subject'),message=cleanText(body,8000,'Message');
  if(!['manual','automatic','test'].includes(kind))throw Error('Unknown email kind');
  const settings = getEmailSettings();
  const copy = settings.copy_enabled ? safeCopyAddress() : undefined;
  const key=String(dedupeKey||crypto.randomUUID()).slice(0,150);
  const insert=db.prepare('INSERT OR IGNORE INTO email_logs(invoice_id,kind,to_email,bcc_email,subject,body,status,dedupe_key,scheduled_on,attempted_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(invoiceId,kind,to,copy||null,subj,message,'sending',key,scheduledOn,utcNow());
  const id=insert.changes?Number(insert.lastInsertRowid):null;
  if(!id) return {...db.prepare('SELECT * FROM email_logs WHERE dedupe_key=?').get(key),duplicate:true};
  try {
    const info=await transporter().sendMail({from,to,bcc:copy,subject:subj,text:message,replyTo:from});
    // Gmail SMTP's acceptance does not guarantee inbox placement / a read receipt.
    const accepted=(info.accepted||[]).map(x=>x.toLowerCase());
    if(!accepted.includes(to.toLowerCase()))throw Error('SMTP server did not accept the intended recipient');
    db.prepare("UPDATE email_logs SET status='sent',smtp_message_id=?,sent_at=?,error=NULL WHERE id=?").run(info.messageId||null,utcNow(),id);
  } catch (e) {
    db.prepare("UPDATE email_logs SET status='failed',error=? WHERE id=?").run(sanitizeEmailError(e),id);
    const failure=new Error('Gmail send failed: '+sanitizeEmailError(e));failure.status=502;throw failure;
  }
  return {...db.prepare('SELECT * FROM email_logs WHERE id=?').get(id),duplicate:false};
}
export function mailHistory(invoiceId=null){return invoiceId===null ? db.prepare('SELECT * FROM email_logs ORDER BY id DESC LIMIT 150').all() : db.prepare('SELECT * FROM email_logs WHERE invoice_id=? ORDER BY id DESC LIMIT 100').all(invoiceId);}
let running=false;
export async function processAutomaticReminders(now = new Date()){
  const cfg=getEmailSettings();if(running||!cfg.automatic_enabled||!cfg.configured)return {skipped:true};
  const clock=localClock(now,cfg.timezone);
  // Restricted local-hour window; startup at night will not cause an unexpected mail blast.
  if(clock.hour!==cfg.send_hour)return {skipped:true,reason:'Outside configured sending hour',clock};
  running=true;let sent=0,failed=0;
  try{
    const dailyCap=Math.min(100,Math.max(1,Number(process.env.MAIL_DAILY_CAP)||20));
    const daily=db.prepare("SELECT COUNT(*) n FROM email_logs WHERE kind='automatic' AND scheduled_on=?").get(clock.date).n;
    let remaining=Math.max(0,dailyCap-daily);
    const eligible=db.prepare(`${invoiceSQL} WHERE b.auto_email_opt_in=1 AND (i.due_date<? OR EXISTS (SELECT 1 FROM installments ins WHERE ins.invoice_id=i.id AND ins.due_date<?)) ORDER BY i.due_date ASC LIMIT 300`).all(clock.date,clock.date);
    for(const inv of eligible){
      if(!remaining)break;
      const outstanding=inv.amount_cents-inv.paid_cents;
      const installments=db.prepare('SELECT due_date,amount_cents FROM installments WHERE invoice_id=? ORDER BY due_date').all(inv.id);
      const effectiveDue=overdueDueDate({today:clock.date,invoiceDueDate:inv.due_date,invoiceAmount:inv.amount_cents,paid:inv.paid_cents,installments});
      if(!effectiveDue)continue;
      const prior=db.prepare("SELECT sent_at FROM email_logs WHERE invoice_id=? AND status='sent' AND kind IN ('manual','automatic') ORDER BY id DESC LIMIT 1").get(inv.id);
      const n=db.prepare("SELECT COUNT(*) n FROM email_logs WHERE invoice_id=? AND kind='automatic' AND status='sent'").get(inv.id).n;
      if(!shouldAutoSend({today:clock.date,dueDate:effectiveDue,outstanding,optIn:true,priorSentAt:prior?.sent_at?localClock(new Date(prior.sent_at),cfg.timezone).date:null,automatedCount:n,maxPerInvoice:cfg.max_per_invoice,intervalDays:cfg.interval_days}))continue;
      if(!validRealEmail(inv.buyer_email))continue;
      if(db.prepare('SELECT id FROM email_logs WHERE dedupe_key=?').get(`auto:${inv.id}:${clock.date}`))continue;
      const fresh=getInvoice(inv.id);if(!fresh||fresh.amount_cents-fresh.paid_cents<=0)continue;
      const buyer=db.prepare('SELECT auto_email_opt_in,email FROM buyers WHERE id=?').get(fresh.buyer_id);if(!buyer?.auto_email_opt_in||buyer.email!==inv.buyer_email)continue;
      const letter=reminderText(fresh,effectiveDue);
      remaining--;
      try{await deliverEmail({invoiceId:inv.id,kind:'automatic',recipient:inv.buyer_email,subject:letter.subject,body:letter.body,dedupeKey:`auto:${inv.id}:${clock.date}`,scheduledOn:clock.date});sent++;}
      catch(e){failed++;console.error('Automatic reminder failed for invoice',inv.id,e.code||e.message.slice(0,90));}
    }
    return {sent,failed,date:clock.date};
  }finally{running=false;}
}
