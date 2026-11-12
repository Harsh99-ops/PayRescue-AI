export const minor = amount => { const x=Number(amount); if(!Number.isFinite(x)||x<=0||Math.round(x*100)!==x*100 && Math.abs(x*100-Math.round(x*100))>1e-6) throw new Error('Amount must be positive with at most two decimal places'); return Math.round(x*100); };
export const major = cents => (cents/100).toFixed(2);
export const statusFor=(total,paid,due)=>paid>=total?'paid':paid>0?'partial':due && due<new Date().toISOString().slice(0,10)?'overdue':'open';
export const isoToday=()=>new Date().toISOString().slice(0,10);
export const safeStr=(v,max=200)=>String(v??'').trim().slice(0,max);
export function nextStep(invoice){const outstanding=Math.max(0,invoice.amount_cents-invoice.paid_cents);const days=Math.floor((Date.now()-Date.parse(invoice.due_date+'T00:00:00Z'))/86400000);return {outstanding,daysOverdue:Math.max(0,days),recommendation:outstanding===0?'Paid in full: archive the case.':days>30?'Escalate for human review, verify delivery evidence, and draft formal demand.':days>0?'Send a courteous overdue reminder and offer an installment plan.':'Send a pre-due payment reminder and confirm buyer receipt.'};}
