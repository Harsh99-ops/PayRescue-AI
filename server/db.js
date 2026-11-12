import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
const file=process.env.DATABASE_PATH||path.resolve('data/payrescue.sqlite');
fs.mkdirSync(path.dirname(file),{recursive:true});
export const db=new Database(file);
db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS buyers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT,phone TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY,number TEXT UNIQUE NOT NULL,buyer_id INTEGER NOT NULL REFERENCES buyers(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),currency TEXT NOT NULL,due_date TEXT NOT NULL,description TEXT,po_number TEXT,transport_receipt TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS installments(id INTEGER PRIMARY KEY,invoice_id INTEGER NOT NULL REFERENCES invoices(id),due_date TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,invoice_id INTEGER NOT NULL REFERENCES invoices(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),provider TEXT NOT NULL,provider_id TEXT NOT NULL UNIQUE,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS refunds(id INTEGER PRIMARY KEY,payment_id INTEGER NOT NULL REFERENCES payments(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),provider_id TEXT UNIQUE NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,invoice_id INTEGER NOT NULL REFERENCES invoices(id),amount_cents INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'CREATED',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS evidence(id INTEGER PRIMARY KEY,invoice_id INTEGER NOT NULL REFERENCES invoices(id),kind TEXT NOT NULL,original_name TEXT NOT NULL,stored_name TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS cases(id INTEGER PRIMARY KEY,invoice_id INTEGER NOT NULL REFERENCES invoices(id),type TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'open',notes TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reminders(id INTEGER PRIMARY KEY,invoice_id INTEGER NOT NULL REFERENCES invoices(id),channel TEXT NOT NULL DEFAULT 'draft',content TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS email_settings(id INTEGER PRIMARY KEY CHECK(id=1),auto_enabled INTEGER NOT NULL DEFAULT 0,interval_days INTEGER NOT NULL DEFAULT 3,send_hour INTEGER NOT NULL DEFAULT 10,max_per_invoice INTEGER NOT NULL DEFAULT 4,copy_enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS email_logs(id INTEGER PRIMARY KEY,invoice_id INTEGER REFERENCES invoices(id),kind TEXT NOT NULL,to_email TEXT NOT NULL,bcc_email TEXT,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,smtp_message_id TEXT,error TEXT,dedupe_key TEXT UNIQUE NOT NULL,scheduled_on TEXT,attempted_at TEXT NOT NULL,sent_at TEXT);
CREATE INDEX IF NOT EXISTS email_logs_invoice ON email_logs(invoice_id,id);
CREATE INDEX IF NOT EXISTS email_logs_kind_date ON email_logs(kind,scheduled_on);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS invoice_buyer ON invoices(buyer_id);
CREATE INDEX IF NOT EXISTS payment_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS refunds_payment ON refunds(payment_id);
`);
// Non-destructive migration for existing Docker SQLite volumes.
if(!db.prepare("PRAGMA table_info(buyers)").all().some(c=>c.name==='auto_email_opt_in')) db.exec('ALTER TABLE buyers ADD COLUMN auto_email_opt_in INTEGER NOT NULL DEFAULT 0');
db.prepare('INSERT OR IGNORE INTO email_settings(id) VALUES(1)').run();
export const invoiceSQL=`SELECT i.*,b.name buyer_name,b.email buyer_email,b.phone buyer_phone,COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id=i.id),0)-COALESCE((SELECT SUM(r.amount_cents) FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.invoice_id=i.id),0) paid_cents FROM invoices i JOIN buyers b ON b.id=i.buyer_id`;
export function getInvoice(id){return db.prepare(invoiceSQL+' WHERE i.id=?').get(id);}
export function addPayment(invoiceId,amount,provider,providerId){return db.transaction(()=>{const existing=db.prepare('SELECT * FROM payments WHERE provider_id=?').get(providerId);if(existing)return {payment:existing,duplicate:true};const inv=getInvoice(invoiceId);if(!inv)throw new Error('Invoice not found');if(amount<=0||amount>inv.amount_cents-inv.paid_cents)throw new Error('Payment exceeds outstanding balance');const info=db.prepare('INSERT INTO payments(invoice_id,amount_cents,provider,provider_id) VALUES(?,?,?,?)').run(invoiceId,amount,provider,providerId);return {payment:db.prepare('SELECT * FROM payments WHERE id=?').get(info.lastInsertRowid),duplicate:false};})();}
export function addRefund(paymentId,amount,providerId){return db.transaction(()=>{const exists=db.prepare('SELECT * FROM refunds WHERE provider_id=?').get(providerId);if(exists)return {refund:exists,duplicate:true};const p=db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);if(!p)throw new Error('Payment not found');const refunded=db.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM refunds WHERE payment_id=?').get(paymentId).n;if(amount<=0||amount+refunded>p.amount_cents)throw new Error('Refund exceeds captured payment');const i=db.prepare('INSERT INTO refunds(payment_id,amount_cents,provider_id) VALUES(?,?,?)').run(paymentId,amount,providerId);return {refund:db.prepare('SELECT * FROM refunds WHERE id=?').get(i.lastInsertRowid),duplicate:false};})();}
