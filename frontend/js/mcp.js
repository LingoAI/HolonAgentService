document.querySelectorAll('[data-endpoint]').forEach(el=>el.textContent=location.origin+el.dataset.endpoint);
fetch('/api/xlayer/verification').then(r=>r.json()).then(info=>{
  document.getElementById('payment-availability').textContent=info.payment?.enabled && info.payment?.configured
    ? 'Price: 0.01 USDT per verification. Your payment client must approve the charge.'
    : 'Paid verification is awaiting activation. Tool discovery is available; no payment is requested.';
}).catch(()=>{document.getElementById('payment-availability').textContent='Service availability could not be checked.';});
const example=document.getElementById('curl-example');
example.textContent=example.textContent.replace('https://holonagentservice.lingoai.io',location.origin);
document.getElementById('verify-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.currentTarget.querySelector('button'),status=document.getElementById('verify-status'),output=document.getElementById('verify-result');
  button.disabled=true;status.textContent='Checking payment challenge…';output.hidden=true;
  try {
    const response=await fetch('/verify',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({transactionHash:document.getElementById('transaction-hash').value.trim()}),signal:AbortSignal.timeout(60000)});
    const data=await response.json();
    if(response.status===402){status.textContent='Payment required: 0.01 USDT. No payment was made by this preview.';output.textContent=JSON.stringify(data,null,2);output.hidden=false;return;}
    if(!response.ok || !data.ok)throw new Error(data.error || `Request failed (${response.status})`);
    status.textContent=data.verified?'Receipt checks passed. Review the evidence below.':`Verification result: ${data.verificationStatus}. Review the failed checks below.`;
    output.textContent=JSON.stringify(data,null,2);output.hidden=false;
  }catch(error){status.textContent=error.message || 'Verification unavailable; try again.'}
  finally{button.disabled=false}
});
