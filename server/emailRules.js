const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function validRealEmail(v) {
  const email = String(v || '').trim().toLowerCase();

  // Validate standard email format
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(email) || email.length > 254) {
    return false;
  }

  const domain = email.split('@')[1];

  // Block fake and test-only domains
  const blockedDomains = [
    'example.com',
    'example.org',
    'example.net',
    'localhost',
    'test',
    'invalid'
  ];

  if (blockedDomains.includes(domain)) {
    return false;
  }

  if (/(^|\.)(example|test|invalid|localhost)$/.test(domain)) {
    return false;
  }

  return true;
}

export function localClock(now = new Date(),timezone=process.env.MAIL_TIMEZONE||'Asia/Kolkata'){
  const pieces= new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const obj=Object.fromEntries(pieces.map(x=>[x.type,x.value]));return {date:`${obj.year}-${obj.month}-${obj.day}`,hour:Number(obj.hour)};
}
export function shouldAutoSend({today,dueDate,outstanding,optIn,priorSentAt=null,automatedCount=0,maxPerInvoice=4,intervalDays=3}){
  if(!optIn||outstanding<=0||dueDate>=today||automatedCount>=maxPerInvoice)return false;
  if(priorSentAt){const prior=String(priorSentAt).slice(0,10); const elapsed=(Date.parse(today+'T00:00:00Z')-Date.parse(prior+'T00:00:00Z'))/86400000; if(!Number.isFinite(elapsed)||elapsed<intervalDays)return false;}
  return true;
}

// Treat recorded payments as settling the earliest installment first.
export function overdueDueDate({today,invoiceDueDate,invoiceAmount,paid,installments=[]}){
  if(paid>=invoiceAmount)return null;
  if(invoiceDueDate<today)return invoiceDueDate;
  let due=0;
  for(const i of [...installments].sort((a,b)=>a.due_date.localeCompare(b.due_date))){
    if(i.due_date>=today)break;
    due+=i.amount_cents;
    if(due>paid)return i.due_date;
  }
  return null;
}
