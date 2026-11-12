import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { db,invoiceSQL,getInvoice,addPayment,addRefund } from './db.js';
import {minor,major,safeStr,isoToday,nextStep} from './core.js';
import {getEmailSettings,updateEmailSettings,mailHistory,reminderText,deliverEmail,verifyGmail,processAutomaticReminders,isMailConfigured,validRealEmail} from './email.js';
const app=express(),PORT=Number(process.env.PORT||8787),mode=process.env.PAYPAL_MODE==='sandbox'?'sandbox':'demo';
const secret=process.env.SESSION_SECRET||'';
if(process.env.NODE_ENV==='production'&&(secret.length<32||!process.env.APP_PIN||process.env.APP_PIN==='change-this-pin')){console.error('Configure APP_PIN and SESSION_SECRET in .env');process.exit(1);}
const localOnly=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
app.disable('x-powered-by');app.use(helmet({contentSecurityPolicy:false}));app.use(cookieParser());
const loginLimit=rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:'draft-7',legacyHeaders:false});
const auth=(req,res,next)=>{const token=req.cookies.pr_session;if(!token)return res.status(401).json({error:'Sign in required'});const hash=crypto.createHash('sha256').update(token).digest('hex');const row=db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(hash);if(!row||row.expires_at<Date.now())return res.status(401).json({error:'Session expired'});next();};
const err=(res,e,status=400)=>res.status(status).json({error:e.message||String(e)});
const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(e=>{console.error(e.message);if(!res.headersSent)err(res,e,e.status||400);});
const apiBase=mode==='sandbox'?'https://api-m.sandbox.paypal.com':null;
async function paypalToken(){const id=process.env.PAYPAL_CLIENT_ID,sec=process.env.PAYPAL_CLIENT_SECRET;if(!id||!sec)throw Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');const r=await fetch(apiBase+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(id+':'+sec).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});const x=await r.json();if(!r.ok)throw Error('PayPal auth failed: '+JSON.stringify(x));return x.access_token;}
async function paypal(pathname,{method='GET',body,requestId}={}){const token=await paypalToken();const r=await fetch(apiBase+pathname,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(requestId?{'PayPal-Request-Id':requestId}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const x=await r.json().catch(()=>({}));if(!r.ok){const e=new Error('PayPal '+r.status+': '+JSON.stringify(x));e.status=502;throw e;}return x;}
const currencyOk=v=>['USD','EUR','GBP','AUD','CAD','INR'].includes(v); // Actual supported payment currency validated by PayPal; use USD for Sandbox.
const withInv=id=>{const inv=getInvoice(Number(id));if(!inv)throw Error('Invoice not found');return inv;};
app.get('/api/health',(req,res)=>res.json({status:'ok',mode,version:'1.0.0'}));
// Webhook route is before general JSON parser. Verification is required in sandbox.
app.post('/api/paypal/webhook',express.raw({type:'application/json',limit:'256kb'}),wrap(async(req,res)=>{
 if(mode!=='sandbox')return res.status(404).json({error:'Webhooks only in sandbox mode'});
 if(!process.env.PAYPAL_WEBHOOK_ID)return res.status(503).json({error:'PAYPAL_WEBHOOK_ID not configured'});
 const headers=req.headers;const keys=['paypal-transmission-id','paypal-transmission-time','paypal-transmission-sig','paypal-cert-url','paypal-auth-algo'];if(keys.some(k=>!headers[k]))return res.status(400).json({error:'Missing PayPal signature headers'});
 const event=JSON.parse(req.body.toString());
 const verified=await paypal('/v1/notifications/verify-webhook-signature',{method:'POST',body:{auth_algo:headers['paypal-auth-algo'],cert_url:headers['paypal-cert-url'],transmission_id:headers['paypal-transmission-id'],transmission_sig:headers['paypal-transmission-sig'],transmission_time:headers['paypal-transmission-time'],webhook_id:process.env.PAYPAL_WEBHOOK_ID,webhook_event:event}});
 if(verified.verification_status!=='SUCCESS')return res.status(401).json({error:'Invalid webhook signature'});
 if(!event.id)return res.status(400).json({error:'Missing event ID'});
 if(db.prepare('SELECT id FROM events WHERE id=?').get(event.id))return res.json({ok:true,duplicate:true});
 const type=event.event_type,resource=event.resource||{};
 if(type==='PAYMENT.CAPTURE.COMPLETED'){
   // PayPal-authenticated event, but capture identity and order must still be validated.
   const orderId=resource.supplementary_data?.related_ids?.order_id;
   const order=orderId&&db.prepare('SELECT * FROM orders WHERE id=? AND mode=?').get(orderId,'sandbox');
   if(order&&resource.id&&resource.status==='COMPLETED'){
     const cap=await paypal('/v2/payments/captures/'+encodeURIComponent(resource.id));
     if(cap.status==='COMPLETED'&&cap.supplementary_data?.related_ids?.order_id===orderId&&cap.amount?.currency_code===withInv(order.invoice_id).currency&&minor(cap.amount.value)===order.amount_cents){addPayment(order.invoice_id,order.amount_cents,'paypal',cap.id);db.prepare("UPDATE orders SET status='COMPLETED' WHERE id=?").run(orderId);}
   }
 } else if(type==='PAYMENT.CAPTURE.REFUNDED'){
   const captureId=resource.links?.find(x=>x.rel==='up')?.href?.split('/').pop()||resource.supplementary_data?.related_ids?.capture_id;
   const payment=captureId&&db.prepare('SELECT * FROM payments WHERE provider_id=?').get(captureId);
   if(payment&&resource.id&&resource.status==='COMPLETED'){
     const ref=await paypal('/v2/payments/refunds/'+encodeURIComponent(resource.id));
     if(ref.status==='COMPLETED'&&ref.amount?.currency_code===withInv(payment.invoice_id).currency)addRefund(payment.id,minor(ref.amount.value),ref.id);
   }
 }
 db.prepare('INSERT OR IGNORE INTO events(id,kind) VALUES(?,?)').run(event.id,type||'UNKNOWN');res.json({ok:true});
}));
app.use(express.json({limit:'100kb'}));
app.post('/api/login',loginLimit,wrap((req,res)=>{const a=Buffer.from(String(req.body.pin||'')),b=Buffer.from(process.env.APP_PIN||'');if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:'Wrong PIN'});const token=crypto.randomBytes(32).toString('hex'),hash=crypto.createHash('sha256').update(token).digest('hex');db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash,Date.now()+8*3600000);res.cookie('pr_session',token,{httpOnly:true,sameSite:'strict',secure:false,maxAge:8*3600000,path:'/'}).json({ok:true});}));
app.post('/api/logout',auth,(req,res)=>{db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(req.cookies.pr_session).digest('hex'));res.clearCookie('pr_session').json({ok:true});});
app.use('/api',auth);
app.get('/api/me',(req,res)=>res.json({ok:true,mode,aiConfigured:!!process.env.OPENAI_API_KEY,mailConfigured:isMailConfigured()}));
app.get('/api/buyers',(req,res)=>res.json(db.prepare('SELECT * FROM buyers ORDER BY id DESC').all()));
app.post('/api/buyers',wrap((req,res)=>{const name=safeStr(req.body.name,120);if(!name)throw Error('Buyer name required');const info=db.prepare('INSERT INTO buyers(name,email,phone) VALUES(?,?,?)').run(name,safeStr(req.body.email,180),safeStr(req.body.phone,30));res.status(201).json(db.prepare('SELECT * FROM buyers WHERE id=?').get(info.lastInsertRowid));}));
// Explicit, per-buyer consent for scheduled reminder emails. Existing buyers default to OFF.
app.patch('/api/buyers/:id/auto-email',wrap((req,res)=>{
 if(typeof req.body.enabled!=='boolean'||typeof req.body.confirmed!=='boolean'||(req.body.enabled&&!req.body.confirmed))throw Error('Confirm that the buyer may receive scheduled payment reminders');
 const result=db.prepare('UPDATE buyers SET auto_email_opt_in=? WHERE id=?').run(req.body.enabled?1:0,Number(req.params.id));
 if(!result.changes)throw Error('Buyer not found');res.json(db.prepare('SELECT * FROM buyers WHERE id=?').get(Number(req.params.id)));
}));
// Mail endpoints inherit the same PIN session protection as other /api endpoints.
// Reject cross-origin browser form calls for mail-changing operations.
const sameOrigin=(req,res,next)=>{const origin=req.get('origin');if(origin){try{if(new URL(origin).host!==req.get('host'))return res.status(403).json({error:'Cross-origin email request blocked'});}catch{return res.status(403).json({error:'Invalid request origin'});}}next();};
const emailRate=rateLimit({windowMs:60*1000,limit:10,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Email request limit reached. Please retry in a minute.'}});
app.get('/api/email/settings',(req,res)=>res.json(getEmailSettings()));
app.post('/api/email/settings',sameOrigin,wrap((req,res)=>res.json(updateEmailSettings(req.body))));
app.get('/api/email/history',(req,res)=>res.json(mailHistory()));
app.get('/api/invoices/:id/email-preview',wrap((req,res)=>{
 const inv=withInv(req.params.id);if(inv.paid_cents>=inv.amount_cents)throw Error('This invoice is fully paid');
 res.json({to:inv.buyer_email,...reminderText(inv)});
}));
app.get('/api/invoices/:id/email-history',wrap((req,res)=>{withInv(req.params.id);res.json(mailHistory(Number(req.params.id)));}));
app.post('/api/email/verify',sameOrigin,emailRate,wrap(async(req,res)=>res.json(await verifyGmail())));
app.post('/api/email/test',sameOrigin,emailRate,wrap(async(req,res)=>{
 if(req.body.confirmed!==true)throw Error('Confirm sending a test email');
 const recipient=process.env.GMAIL_USER;
 const sent=await deliverEmail({invoiceId:null,kind:'test',recipient,subject:'PayRescue AI — Gmail test',body:'Gmail SMTP is connected to your PayRescue AI instance. This is a test email requested by the signed-in seller.',dedupeKey:'test:'+crypto.randomUUID()});res.json(sent);
}));
app.post('/api/invoices/:id/send-email',sameOrigin,emailRate,wrap(async(req,res)=>{
 if(req.body.confirmed!==true)throw Error('Confirm the email contents before sending');
 const inv=withInv(req.params.id);
 if(inv.amount_cents-inv.paid_cents<=0)throw Error('Invoice already paid; sending is disabled');
 if(!validRealEmail(inv.buyer_email))throw Error('Buyer needs a real email address. Example/demo addresses cannot receive mail.');
 const id=safeStr(req.body.idempotency_key,90);if(!/^[a-zA-Z0-9_-]{16,90}$/.test(id))throw Error('Invalid email request ID');
 const sent=await deliverEmail({invoiceId:inv.id,kind:'manual',recipient:inv.buyer_email,subject:req.body.subject,body:req.body.body,dedupeKey:'manual:'+id});res.json(sent);
}));
app.get('/api/invoices',(req,res)=>res.json(db.prepare(invoiceSQL+' ORDER BY i.id DESC').all().map(inv=>({...inv,...nextStep(inv)}))));
app.post('/api/invoices',wrap((req,res)=>{const x=req.body,buyer=Number(x.buyer_id),due=safeStr(x.due_date,10),cur=safeStr(x.currency,3).toUpperCase(),amount=minor(x.amount);if(!db.prepare('SELECT id FROM buyers WHERE id=?').get(buyer))throw Error('Choose a buyer');if(!/^\d{4}-\d\d-\d\d$/.test(due)||Number.isNaN(Date.parse(due)))throw Error('Use YYYY-MM-DD due date');if(!currencyOk(cur))throw Error('Unsupported currency');const no='PR-'+new Date().getFullYear()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();const i=db.prepare('INSERT INTO invoices(number,buyer_id,amount_cents,currency,due_date,description,po_number,transport_receipt) VALUES(?,?,?,?,?,?,?,?)').run(no,buyer,amount,cur,due,safeStr(x.description,500),safeStr(x.po_number,100),safeStr(x.transport_receipt,100));res.status(201).json(getInvoice(i.lastInsertRowid));}));
app.get('/api/invoices/:id',wrap((req,res)=>{const inv=withInv(req.params.id);res.json({...inv,...nextStep(inv),payments:db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id DESC').all(inv.id),installments:db.prepare('SELECT * FROM installments WHERE invoice_id=? ORDER BY due_date').all(inv.id),evidence:db.prepare('SELECT id,kind,original_name,sha256,created_at FROM evidence WHERE invoice_id=?').all(inv.id),cases:db.prepare('SELECT * FROM cases WHERE invoice_id=?').all(inv.id),reminders:db.prepare('SELECT * FROM reminders WHERE invoice_id=? ORDER BY id DESC').all(inv.id),email_logs:mailHistory(inv.id),orders:db.prepare('SELECT * FROM orders WHERE invoice_id=? ORDER BY created_at DESC').all(inv.id)});}));
app.post('/api/invoices/:id/installments',wrap((req,res)=>{const inv=withInv(req.params.id),amount=minor(req.body.amount),due=safeStr(req.body.due_date,10);if(!/^\d{4}-\d\d-\d\d$/.test(due)||Number.isNaN(Date.parse(due)))throw Error('Invalid due date');const planned=db.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM installments WHERE invoice_id=?').get(inv.id).n;if(planned+amount>inv.amount_cents)throw Error('Installments exceed invoice total');const r=db.prepare('INSERT INTO installments(invoice_id,due_date,amount_cents) VALUES(?,?,?)').run(inv.id,due,amount);res.status(201).json({id:r.lastInsertRowid});}));
app.post('/api/invoices/:id/demo-payment',wrap((req,res)=>{if(mode!=='demo')return res.status(403).json({error:'Only available in demo mode'});const inv=withInv(req.params.id);const id=safeStr(req.body.idempotency_key,100);if(!/^[a-zA-Z0-9_-]{6,100}$/.test(id))throw Error('Provide idempotency key (6+ chars)');const amount=minor(req.body.amount);const p=addPayment(inv.id,amount,'demo','demo:'+id);res.json({...p,invoice:getInvoice(inv.id)});}));
app.post('/api/invoices/:id/demo-refund',wrap((req,res)=>{if(mode!=='demo')return res.status(403).json({error:'Demo mode only'});const inv=withInv(req.params.id),payment=db.prepare("SELECT * FROM payments WHERE invoice_id=? AND provider='demo' ORDER BY id DESC LIMIT 1").get(inv.id);if(!payment)throw Error('No demo payment to refund');const key=safeStr(req.body.idempotency_key,100);if(!/^[a-zA-Z0-9_-]{6,100}$/.test(key))throw Error('Invalid idempotency key');res.json(addRefund(payment.id,minor(req.body.amount),'demo-refund:'+key));}));
app.post('/api/invoices/:id/paypal-order',wrap(async(req,res)=>{if(mode!=='sandbox')return res.status(403).json({error:'Set PAYPAL_MODE=sandbox to use PayPal'});const inv=withInv(req.params.id),amount=minor(req.body.amount);if(amount>inv.amount_cents-inv.paid_cents)throw Error('Exceeds outstanding');if(inv.currency!=='USD')throw Error('Use USD invoice for Sandbox demo; INR not supported for this checkout flow');const order=await paypal('/v2/checkout/orders',{method:'POST',requestId:'pr-create-'+crypto.randomUUID(),body:{intent:'CAPTURE',purchase_units:[{reference_id:String(inv.id),custom_id:String(inv.id),invoice_id:inv.number.slice(0,127),amount:{currency_code:inv.currency,value:major(amount)}}]}});db.prepare('INSERT INTO orders(id,invoice_id,amount_cents,mode,status) VALUES(?,?,?,?,?)').run(order.id,inv.id,amount,'sandbox',order.status);res.json({id:order.id,approve_url:order.links?.find(l=>l.rel==='approve'||l.rel==='payer-action')?.href});}));
app.post('/api/paypal/orders/:orderId/capture',wrap(async(req,res)=>{if(mode!=='sandbox')throw Error('Only in Sandbox mode');const id=safeStr(req.params.orderId,100),o=db.prepare("SELECT * FROM orders WHERE id=? AND mode='sandbox'").get(id);if(!o)throw Error('Unknown order');if(o.status==='COMPLETED')return res.json({ok:true,duplicate:true,invoice:getInvoice(o.invoice_id)});const result=await paypal('/v2/checkout/orders/'+encodeURIComponent(id)+'/capture',{method:'POST',body:{},requestId:'pr-capture-'+id});const cap=result.purchase_units?.flatMap(u=>u.payments?.captures||[]).find(x=>x.status==='COMPLETED');if(!cap||result.status!=='COMPLETED'||cap.amount.currency_code!==withInv(o.invoice_id).currency||minor(cap.amount.value)!==o.amount_cents)throw Error('Capture not complete or amount mismatch');const recorded=addPayment(o.invoice_id,o.amount_cents,'paypal',cap.id);db.prepare("UPDATE orders SET status='COMPLETED' WHERE id=?").run(id);res.json({ok:true,duplicate:recorded.duplicate,invoice:getInvoice(o.invoice_id),capture_id:cap.id});}));
app.post('/api/paypal/payments/:paymentId/refund',wrap(async(req,res)=>{if(mode!=='sandbox')throw Error('Sandbox only');const p=db.prepare("SELECT * FROM payments WHERE id=? AND provider='paypal'").get(Number(req.params.paymentId));if(!p)throw Error('PayPal payment not found');const amount=minor(req.body.amount),inv=withInv(p.invoice_id);const ref=await paypal('/v2/payments/captures/'+encodeURIComponent(p.provider_id)+'/refund',{method:'POST',requestId:'pr-refund-'+p.provider_id+'-'+crypto.randomUUID(),body:{amount:{currency_code:inv.currency,value:major(amount)}}});if(ref.status!=='COMPLETED')throw Error('Refund pending; reconcile before recording');res.json(addRefund(p.id,amount,ref.id));}));
const uploadDir=path.dirname(process.env.DATABASE_PATH||path.resolve('data/payrescue.sqlite'))+'/uploads';fs.mkdirSync(uploadDir,{recursive:true});
const upload=multer({storage:multer.diskStorage({destination:uploadDir,filename:(req,file,cb)=>cb(null,crypto.randomUUID())}),limits:{fileSize:8*1024*1024},fileFilter:(req,file,cb)=>cb(null,['application/pdf','image/png','image/jpeg','text/plain'].includes(file.mimetype))});
app.post('/api/invoices/:id/evidence',upload.single('file'),wrap((req,res)=>{const inv=withInv(req.params.id);if(!req.file)throw Error('Upload PDF, PNG, JPG or TXT, up to 8 MB');const sha=crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');const i=db.prepare('INSERT INTO evidence(invoice_id,kind,original_name,stored_name,sha256) VALUES(?,?,?,?,?)').run(inv.id,safeStr(req.body.kind,40)||'other',safeStr(req.file.originalname,220),req.file.filename,sha);res.status(201).json({id:i.lastInsertRowid,sha256:sha});}));
app.get('/api/evidence/:id/download',wrap((req,res)=>{const e=db.prepare('SELECT * FROM evidence WHERE id=?').get(Number(req.params.id));if(!e)throw Error('Evidence not found');res.download(path.join(uploadDir,e.stored_name),e.original_name);}));
app.post('/api/invoices/:id/cases',wrap((req,res)=>{const inv=withInv(req.params.id),type=safeStr(req.body.type,60),notes=safeStr(req.body.notes,2000);if(!['payment_dispute','cheque_dishonour','other'].includes(type))throw Error('Choose valid case type');const i=db.prepare('INSERT INTO cases(invoice_id,type,notes) VALUES(?,?,?)').run(inv.id,type,notes);res.status(201).json({id:i.lastInsertRowid});}));
app.post('/api/cases/:id/stage',wrap((req,res)=>{const stage=safeStr(req.body.stage,40);if(!['open','evidence_review','advocate_review','resolved'].includes(stage))throw Error('Invalid case stage');const r=db.prepare('UPDATE cases SET stage=? WHERE id=?').run(stage,Number(req.params.id));if(!r.changes)throw Error('Case not found');res.json({ok:true});}));
function draft(inv,kind){const steps=nextStep(inv),sum=major(steps.outstanding);if(kind==='legal')return `DRAFT — FOR ADVOCATE REVIEW ONLY\nSubject: Payment recovery evidence summary for ${inv.number}\nBuyer: ${inv.buyer_name}\nAmount: ${inv.currency} ${sum} outstanding; invoice total ${major(inv.amount_cents)}.\nDue date: ${inv.due_date}; purchase order: ${inv.po_number||'not provided'}; transport receipt: ${inv.transport_receipt||'not provided'}.\nSuggested review: verify contract, debt, proof of dispatch/delivery, demand communications, actual cheque return memo and all applicable statutory deadlines. Do not assume Section 138 NI Act applies without verified cheque dishonour.\nThis document is a working summary, not legal advice or a filed complaint.`;return `Subject: Friendly payment follow-up for invoice ${inv.number}\nDear ${inv.buyer_name},\nOur records show an outstanding balance of ${inv.currency} ${sum} against invoice ${inv.number}, due ${inv.due_date}. Please confirm your expected payment date or share remittance details if already paid. We can discuss an installment arrangement if needed.\nRegards,\nAccounts Team`}
app.post('/api/invoices/:id/draft',wrap(async(req,res)=>{const inv=withInv(req.params.id),kind=req.body.kind==='legal'?'legal':'reminder';let output=draft(inv,kind),source='template';if(process.env.OPENAI_API_KEY&&req.body.useAI===true){try{const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4.1-mini',temperature:0.2,messages:[{role:'system',content:'You are a cautious receivables assistant. Rewrite the supplied draft. Never invent facts, legal deadlines, evidence or guarantee a result. For legal drafts clearly label ADVOCATE REVIEW ONLY.'},{role:'user',content:output}]})});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));output=data.choices?.[0]?.message?.content||output;source='ai';}catch(e){console.error('AI fallback:',e.message);}}
 db.prepare('INSERT INTO reminders(invoice_id,channel,content) VALUES(?,?,?)').run(inv.id,kind==='legal'?'legal_draft':'draft',output);res.json({content:output,source});}));
app.get('/api/invoices/:id/summary.pdf',wrap((req,res)=>{const inv=withInv(req.params.id),steps=nextStep(inv),doc=new PDFDocument({margin:48});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${inv.number}-summary.pdf"`);doc.pipe(res);doc.fontSize(22).text('PAYRESCUE AI — Evidence Summary');doc.moveDown().fontSize(12).text(`Invoice: ${inv.number}\nBuyer: ${inv.buyer_name}\nTotal: ${inv.currency} ${major(inv.amount_cents)}\nPaid net: ${inv.currency} ${major(inv.paid_cents)}\nOutstanding: ${inv.currency} ${major(steps.outstanding)}\nDue date: ${inv.due_date}\nPO: ${inv.po_number||'Not provided'}\nTransport receipt: ${inv.transport_receipt||'Not provided'}\n\nRecovery recommendation: ${steps.recommendation}`);doc.moveDown().fontSize(10).text('Generated for administrative reference only. Verify all figures and evidence before legal use.');doc.end();}));
app.get('/api/overview',(req,res)=>{const invoices=db.prepare(invoiceSQL).all();const total=invoices.reduce((n,i)=>n+i.amount_cents-i.paid_cents,0);const overdue=invoices.filter(i=>nextStep(i).daysOverdue>0&&i.paid_cents<i.amount_cents);res.json({buyers:db.prepare('SELECT COUNT(*) n FROM buyers').get().n,invoices:invoices.length,outstanding_cents:total,overdue_cents:overdue.reduce((n,i)=>n+i.amount_cents-i.paid_cents,0),overdue_count:overdue.length,cases:db.prepare("SELECT COUNT(*) n FROM cases WHERE stage!='resolved'").get().n,events:db.prepare('SELECT COUNT(*) n FROM events').get().n});});
app.post('/api/demo/seed',wrap((req,res)=>{if(mode!=='demo'||process.env.ALLOW_DEMO_SEED!=='true')return res.status(403).json({error:'Demo seed disabled'});if(db.prepare('SELECT COUNT(*) n FROM buyers').get().n)return res.json({ok:true,alreadySeeded:true});db.transaction(()=>{const buyers=[['Northstar Retail','accounts@northstar.example','+1 555 0101'],['Bluewave Supplies','finance@bluewave.example','+1 555 0102'],['Vertex Trading','payables@vertex.example','+1 555 0103']];buyers.forEach(b=>db.prepare('INSERT INTO buyers(name,email,phone) VALUES(?,?,?)').run(...b));const today=new Date();for(let i=0;i<5;i++){const d=new Date(today);d.setDate(d.getDate()+[-45,-17,-4,7,21][i]);db.prepare('INSERT INTO invoices(number,buyer_id,amount_cents,currency,due_date,description,po_number,transport_receipt) VALUES(?,?,?,?,?,?,?,?)').run('DEMO-'+(i+1),i%3+1,[125000,89000,320000,76000,145000][i],'USD',d.toISOString().slice(0,10),['Industrial supply order','Packaging material','Equipment components','Maintenance parts','Bulk supplies'][i],'PO-00'+(i+1),'LR-00'+(i+1));}addPayment(1,40000,'demo','seed-demo-1');addPayment(3,75000,'demo','seed-demo-2');})();res.json({ok:true});}));
const dist=path.resolve('dist');if(fs.existsSync(dist)){app.use(express.static(dist));app.get('*',(req,res)=>res.sendFile(path.join(dist,'index.html')));}else app.get('/',(req,res)=>res.send('PayRescue API running. Start Vite for UI or build frontend.'));
app.use((e,req,res,next)=>{console.error(e.message);if(e.code==='LIMIT_FILE_SIZE')return err(res,new Error('File exceeds 8 MB'),413);err(res,e,400);});
setInterval(()=>{db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());},60*60*1000).unref();
// Scheduler runs only while this backend is online; it never sends by default.
// Only the configured local hour is eligible; each invoice/day has a unique database key.
setTimeout(()=>processAutomaticReminders().catch(e=>console.error('Mail scheduler:',e.message)),8000).unref();
setInterval(()=>processAutomaticReminders().catch(e=>console.error('Mail scheduler:',e.message)),60000).unref();
app.listen(PORT,'0.0.0.0',()=>console.log(`PayRescue AI ${mode} on :${PORT}`));
