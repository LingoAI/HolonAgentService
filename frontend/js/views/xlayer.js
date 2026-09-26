import {esc} from '/js/api.js';
import {connectNetwork,registeredAgentId,signApplication,signLogin,tokenBalance,waitForReceipt} from '/vendor/x402-wallet.js';

let root=null, config=null, mvp=null, account=null, balance=null, tasks=[], providers=[], orders=[], session=null, chainError=null;
let mainnetProof=null, mainnetVerification=null, mainnetVerifiedAt=0, mainnetVerifyPending=false;
let officialEvidence=null;
let busy=false, poll=null, epoch=0, dataReady=false, lastLoadedAt=0, initialLoad=null, refreshPending=null, chainPending=null;
let publicTasks=[], mineTasks=[];
const walletProvider=()=>window.okxwallet || window.ethereum;
const short=value=>String(value || '').length>15 ? `${String(value).slice(0,7)}…${String(value).slice(-5)}` : String(value || '');
const icon=path=>`<svg class="xl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const I={wallet:icon('<path d="M20 8V5H5a2 2 0 0 0 0 4h16v11H5a2 2 0 0 1-2-2V7"/><path d="M21 12h-6v5h6"/>'),
  refresh:icon('<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>'),
  arrow:icon('<path d="M5 12h14m-5-5 5 5-5 5"/>'),check:icon('<path d="m5 12 4 4L19 6"/>'),
  shield:icon('<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6z"/><path d="m8 12 3 3 5-6"/>')};

async function api(path,payload) {
  const options=payload===undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)};
  const response=await fetch(`/api/xlayer/mvp${path}`,options);
  let data;try{data=await response.json()}catch{throw new Error(`Server returned an unreadable response (${response.status}).`)}
  if(!response.ok || data.ok===false)throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
async function proofApi(path='') {
  const response=await fetch(`/api/xlayer/mainnet-proof${path}`,{cache:'no-store'});
  let data;try{data=await response.json()}catch{throw new Error(`Mainnet proof returned an unreadable response (${response.status}).`)}
  if(!response.ok || data.ok===false)throw new Error(data.error || `Mainnet proof request failed (${response.status}).`);
  return data;
}
function message(value,kind='') {
  const target=root?.querySelector('#xl-note');
  if(target){target.hidden=false;target.className=`xl-note ${kind}`;target.textContent=value}
  const editor=root?.querySelector('.xl-editor');
  if(editor) {
    let local=editor.querySelector('.xl-editor-note');
    if(!local){local=document.createElement('div');local.className='xl-note xl-editor-note';local.setAttribute('role','status');local.setAttribute('aria-live','polite');editor.appendChild(local)}
    local.className=`xl-note xl-editor-note ${kind}`;local.textContent=value;
    if(kind==='bad'){local.tabIndex=-1;local.focus()}
  }
}
function explain(error) {
  if(error?.code===4001 || error?.code==='ACTION_REJECTED')return 'The wallet request was rejected. Nothing was sent.';
  return error?.shortMessage || error?.message || String(error);
}
function link(value,type='tx',label=short(value)) {
  if(!value)return '—';
  return config.network.explorer ? `<a class="xl-link mono" target="_blank" rel="noopener noreferrer" href="${esc(config.network.explorer)}/${type}/${esc(value)}">${esc(label)} ↗</a>` : `<code>${esc(label)}</code>`;
}
function date(value){return new Date(Number(value)*1000).toLocaleString()}
function tokenSymbol(){return mvp?.deployment?.token?.symbol || 'token'}
function tokenDecimals(){return Number(mvp?.deployment?.token?.decimals ?? 6)}
function formatRaw(value) {
  const decimals=tokenDecimals(),raw=String(value || '0').padStart(decimals+1,'0');
  if(!decimals)return raw;
  return `${raw.slice(0,-decimals)}.${raw.slice(-decimals)}`.replace(/\.?0+$/,'') || '0';
}
function parseToken(value) {
  const decimals=tokenDecimals();
  const raw=String(value || '').trim();
  const pattern=new RegExp(`^\\d+(\\.\\d{0,${decimals}})?$`);
  if(!pattern.test(raw))throw new Error(`Reward must be positive and use at most ${decimals} decimal places.`);
  const [whole,fraction='']=raw.split('.');
  const result=BigInt(whole)*(10n**BigInt(decimals))+BigInt(fraction.padEnd(decimals,'0') || '0');
  if(result<=0n)throw new Error('Reward must be greater than zero.');
  if(result>BigInt(mvp.rules.maxBudgetRaw))throw new Error(`This deployment caps each bounty at ${formatRaw(mvp.rules.maxBudgetRaw)} ${tokenSymbol()}.`);
  return result.toString();
}
function route(){return location.hash.replace(/^#/,'').split('/')}
function owns(value){return !!account && String(value || '').toLowerCase()===account.toLowerCase()}
function status(value){return `<span class="xl-status" data-status="${esc(value)}">${esc(value)}</span>`}
function storageKey(){return `mvp:${config.network.chainId}:${mvp.deployment.escrow.toLowerCase()}`}
function pendingGet(){try{return JSON.parse(localStorage.getItem(`${storageKey()}:pending`))}catch{return null}}
function pendingSet(value){if(value)localStorage.setItem(`${storageKey()}:pending`,JSON.stringify(value));else localStorage.removeItem(`${storageKey()}:pending`)}
function editingRoute(){const [,section,,step]=route();return ['new-task','new-provider'].includes(section)||(section==='task'&&step==='apply')||(section==='order'&&step==='deliver')}
function selectTaskScope(){tasks=route()[1]==='work'?(session?mineTasks:[]):publicTasks}

async function connect({login=true}={}) {
  const connected=await connectNetwork(config.network,walletProvider());
  account=connected.account.toLowerCase();
  session=(await api('/auth/session')).address;
  if(login && session!==account) {
    const challenge=await api('/auth/challenge',{address:account});
    const signature=await signLogin(connected.injected,account,challenge.message);
    session=(await api('/auth/verify',{nonce:challenge.nonce,signature})).address;
  }
  try {balance=await tokenBalance(connected.injected,mvp.deployment.token.address,account,mvp.deployment.token.decimals)}catch{balance=null}
  return connected;
}
async function loadData() {
  if(!officialEvidence) {
    try {const r=await fetch('/api/xlayer/official-evidence');if(r.ok)officialEvidence=await r.json();} catch {}
  }
  const [setup, activeSession]=await Promise.all([
    mvp?Promise.resolve(null):Promise.all([api('/config'),config.network.name==='xlayer-mainnet'?proofApi():Promise.resolve(null)]),
    api('/auth/session'),
  ]);
  if(setup) {
    const [deployment,proof]=setup;
    if(proof && (proof.chainId!==config.network.chainId ||
       proof.escrow.toLowerCase()!==deployment.deployment.escrow.toLowerCase() ||
       proof.token.address.toLowerCase()!==deployment.deployment.token.address.toLowerCase()))
      throw new Error('The published mainnet result does not match this site’s active contracts.');
    mvp=deployment;mainnetProof=proof;
  }
  const address=activeSession.address;
  const [allTasks,ownedTasks,allProviders,allOrders]=await Promise.all([
    api('/tasks'),address?api('/tasks?mine=1'):Promise.resolve({tasks:[]}),api('/providers'),api('/orders'),
  ]);
  session=address;publicTasks=allTasks.tasks;mineTasks=ownedTasks.tasks;providers=allProviders.providers;orders=allOrders.orders;
  if(session)account=session;
  selectTaskScope();lastLoadedAt=Date.now();
}
async function syncChain() {
  if(chainPending)return chainPending;
  chainPending=(async()=>{try{await api('/chain');chainError=null}catch(error){chainError=explain(error)}})();
  try{await chainPending}finally{chainPending=null}
}
function mainnetLink(type,value,label=short(value)) {
  return `<a class="xl-link mono" target="_blank" rel="noopener noreferrer" href="${esc(mainnetProof.explorer)}/${type}/${esc(value)}">${esc(label)} ↗</a>`;
}
function mainnetVerificationText() {
  if(!mainnetVerification)return 'Checking funding, delivery and settlement receipts on X Layer mainnet…';
  return mainnetVerification.verified
    ? `Live RPC check passed · chain 196 · checked ${new Date(mainnetVerification.checkedAt).toLocaleString()}`
    : `Live RPC check unavailable: ${mainnetVerification.error || 'Could not verify receipts'}. Open the transactions below to inspect them independently.`;
}
async function verifyMainnet() {
  if(!mainnetProof || mainnetVerifyPending || Date.now()-mainnetVerifiedAt<60000)return;
  mainnetVerifyPending=true;mainnetVerifiedAt=Date.now();
  try{mainnetVerification=await proofApi('/verify')}
  catch(error){mainnetVerification={verified:false,error:explain(error)}}
  finally {
    mainnetVerifyPending=false;
    root?.querySelectorAll('[data-mainnet-verification]').forEach(el=>{el.textContent=mainnetVerificationText()});
  }
}
async function refresh({preserveEditor=true,force=false,sync=false}={}) {
  if(refreshPending){await refreshPending;if(!force)return}
  const pending=(async()=>{
    const before=JSON.stringify([publicTasks,mineTasks,providers,orders,session,chainError]);
    const draft=preserveEditor?[...root?.querySelectorAll('.xl-editor .field') || []].map(field=>[field.id,field.value]):[];
    if(sync)await syncChain();
    await loadData();
    if(account&&walletProvider())try{balance=await tokenBalance(walletProvider(),mvp.deployment.token.address,account,tokenDecimals())}catch{}
    const changed=before!==JSON.stringify([publicTasks,mineTasks,providers,orders,session,chainError]);
    if(root?.isConnected&&(force||changed&&!editingRoute())){
      selectTaskScope();paint();
      draft.forEach(([id,value])=>{const field=root?.querySelector(`#${id}`);if(field&&value!=='')field.value=value});
    }
  })();
  refreshPending=pending;
  try{await pending}finally{if(refreshPending===pending)refreshPending=null}
}
async function perform(button,work,success='Done.') {
  if(busy)return;busy=true;
  const label=button.innerHTML;root.querySelectorAll('button').forEach(item=>item.disabled=true);
  button.setAttribute('aria-busy','true');button.textContent='Working…';
  try{
    const result=await work();await refresh({preserveEditor:!result?.nextHref,force:true,sync:true});message(success,'ok');
    if(result?.nextHref){const note=root?.querySelector('.xl-editor-note');if(note){const link=document.createElement('a');link.className='xl-link';link.href=result.nextHref;link.textContent=result.nextLabel;note.append(' ',link)}}
  }catch(error){message(explain(error),'bad')}
  finally{busy=false;if(button.isConnected){button.innerHTML=label;button.removeAttribute('aria-busy')}root?.querySelectorAll('button').forEach(item=>item.disabled=false)}
}

async function runIntent(action,objectId,extra={}) {
  const connected=await connect();
  const keyName=`${storageKey()}:idem:${action}:${objectId}`;
  let idempotencyKey=localStorage.getItem(keyName);
  if(!idempotencyKey){idempotencyKey=`${action}:${Date.now()}:${crypto.randomUUID()}`.replace(/[^a-zA-Z0-9:_-]/g,'');localStorage.setItem(keyName,idempotencyKey)}
  const prepared=await api('/intents',{action,objectId,idempotencyKey,...extra});
  const tx=prepared.transaction;
  if(Number(BigInt(tx.chainId))!==config.network.chainId)throw new Error('Prepared transaction targets the wrong network.');
  let pending=pendingGet(),hash;
  if(pending && pending.intentId!==prepared.intent.id)throw new Error('Another transaction is pending. Resume it before starting a new one.');
  if(pending)hash=pending.hash;
  else {
    hash=await connected.injected.request({method:'eth_sendTransaction',params:[{from:connected.account,...tx}]});
    pendingSet({intentId:prepared.intent.id,hash,action,objectId});
  }
  // Persist the hash immediately. A timeout after this point remains unknown,
  // never "failed", and retries reconcile this exact transaction first.
  await api(`/intents/${prepared.intent.id}/broadcast`,{txHash:hash});
  const receipt=await waitForReceipt(connected.injected,hash,{timeoutMs:120000});
  const reconciled=await api(`/intents/${prepared.intent.id}/reconcile`,{});
  if(reconciled.pending)throw new Error('Transaction is still pending. Use Resume pending before sending another.');
  pendingSet(null);localStorage.removeItem(keyName);
  return {intent:reconciled.intent,receipt,hash};
}
async function resumePending() {
  const pending=pendingGet();if(!pending)throw new Error('No pending transaction.');
  const connected=await connect();
  await api(`/intents/${pending.intentId}/broadcast`,{txHash:pending.hash});
  await waitForReceipt(connected.injected,pending.hash,{timeoutMs:120000});
  const reconciled=await api(`/intents/${pending.intentId}/reconcile`,{});
  if(reconciled.pending)throw new Error('Transaction is still pending; no duplicate was sent.');
  pendingSet(null);return reconciled;
}

function shell(title,subtitle,content,{official=false}={}) {
  const pending=pendingGet();
  const mainnet=mvp.rules.mainnetCanary;
  return `<div class="scroll xl"><div class="xl-content"><header class="xl-heading"><div><span class="xl-eyebrow">${official?'OKX AI / VERIFIABLE AGENT SERVICES':'FIXED-BOUNTY MARKET / '+esc(config.network.label.toUpperCase())}</span><h2>${esc(title)}</h2><p class="muted">${esc(subtitle)}</p></div><div class="xl-actions">${official?'<a class="btn filled" href="/mcp.html">Connect your agent '+I.arrow+'</a>':`<button class="btn outlined" data-action="connect">${I.wallet}${account?esc(short(account)):'Connect & sign in'}</button>`}<button class="btn text" data-action="refresh">${I.refresh} Refresh</button></div></header>
    <div class="xl-network-bar"><span>${I.shield} ${esc(config.network.label)} <span class="xl-chain-id">/ Chain ${config.network.chainId}</span></span><span>${official?'Official services · USDT settlement':`${esc(tokenSymbol())}${mvp.rules.testToken?' is a test token':' is a real mainnet asset'} · balance ${balance?`${esc(balance.formatted)} ${esc(tokenSymbol())}`:'connect wallet'} · gas requires ${mainnet?'mainnet ':'test '}OKB`}</span></div>
    ${chainError?`<div class="xl-note bad">Chain state is currently unknown: ${esc(chainError)} Confirm receipts before retrying any transaction.</div>`:''}
    ${mainnet&&!official?`<div class="xl-note bad"><strong>Limited mainnet canary.</strong> Real USDC is used. The immutable contract caps each job at ${esc(formatRaw(mvp.rules.maxBudgetRaw))} ${esc(tokenSymbol())} and total escrow at ${esc(formatRaw(mvp.deployment.limits.maxTotalEscrowRaw))} ${esc(tokenSymbol())}. This is a public demonstration, not the production market.</div>`:''}
    ${!official?'<div class="xl-note xl-disclosure"><strong>Public, fixed-bounty workflow.</strong> Files are public on IPFS. The one absolute deadline covers delivery and review; even submitted work can be refunded to the buyer after expiry. The evaluator may reject and refund. This is not decentralized arbitration or seller protection.</div>':''}
    <div id="xl-note" class="xl-note" hidden role="status" aria-live="polite"></div>
    ${pending?`<div class="xl-note">A transaction may already be broadcast: <code>${esc(short(pending.hash))}</code> <button class="btn outlined" data-action="resume">Resume pending</button></div>`:''}
    ${content}<footer class="xl-page-footer"><span>Escrow ${esc(short(mvp.deployment.escrow))} · <a class="xl-link" href="/mcp.html">MCP / verification API</a></span><span>Public retention target: through ${esc(mvp.retentionUntil)} · one configured pin service + CAR backup</span></footer></div></div>`;
}
function field(id,label,type='input',extra='') {
  return `<label for="${id}">${label}</label>${type==='textarea'?`<textarea class="field" id="${id}" ${extra}></textarea>`:`<input class="field" id="${id}" ${extra}>`}`;
}
function taskCard(task) {
  return `<article class="xl-job"><div class="xl-section-head"><div><span class="xl-eyebrow">${esc(task.template_id)}</span><h3>${esc(task.title)}</h3></div>${status(task.status)}</div><p>${esc(task.community_intro)}</p><dl class="xl-details"><dt>Bounty</dt><dd>${esc(formatRaw(task.amount_raw))} ${esc(tokenSymbol())}</dd><dt>Buyer</dt><dd>${link(task.buyer,'address')}</dd><dt>Evaluator</dt><dd>${link(task.evaluator,'address')}</dd><dt>Absolute deadline</dt><dd>${esc(date(task.expired_at))}</dd><dt>Task evidence</dt><dd><a class="xl-link mono" href="/api/xlayer/mvp/ipfs/${esc(task.manifest_cid)}" target="_blank" rel="noopener">${esc(short(task.manifest_cid))} ↗</a></dd></dl><div class="xl-actions"><a class="btn outlined" href="#marketplace/task/${esc(task.uid)}">View task & applications ${I.arrow}</a>${owns(task.buyer)&&task.status==='open'?`<button class="btn danger" data-action="close-task" data-task="${esc(task.uid)}">Close unselected task</button>`:''}</div></article>`;
}
function mainnetProofCard() {
  if(!mainnetProof)return '';
  const proof=mainnetProof;
  const tx=Object.fromEntries(proof.transactions.map(item=>[item.step,item]));
  const receipt=(step,label)=>mainnetLink('tx',tx[step].hash,label);
  const gateway='https://gateway.pinata.cloud/ipfs/';
  const amount=formatRaw(proof.amountRaw);
  return `<section class="xl-mainnet-proof" aria-label="Completed X Layer mainnet USDC order">
    <div class="xl-proof-head"><span class="xl-proof-chain">X Layer Mainnet · Chain 196</span><span class="xl-proof-state">${I.check} ${esc(proof.status)} on-chain</span></div>
    <div class="xl-proof-intro"><div><span class="xl-eyebrow">REAL USDC · COMPLETED AGENT SERVICE</span><h3>${esc(amount)} USDC paid to the provider</h3><p>Agent #${esc(proof.agentId)} delivered a public community FAQ. Job #${esc(proof.jobId)} was funded, submitted and accepted on X Layer mainnet on ${esc(new Date(proof.recordedAt).toLocaleDateString())}.</p></div><div class="xl-proof-amount"><strong>${esc(amount)}</strong><span>Circle native USDC</span></div></div>
    <p class="xl-proof-verification" data-mainnet-verification role="status">${esc(mainnetVerificationText())}</p>
    <ol class="xl-proof-steps"><li><span>01</span><div><strong>Agent identity</strong><small>ERC-8004 #${esc(proof.agentId)}</small>${receipt('register-agent','Registration')}</div></li><li><span>02</span><div><strong>Escrow funded</strong><small>${esc(amount)} USDC deposited</small>${receipt('fund-job','Funding')}</div></li><li><span>03</span><div><strong>Delivery submitted</strong><small>Manifest pinned to IPFS</small>${receipt('submit-delivery','Submission')}</div></li><li><span>04</span><div><strong>Provider paid</strong><small>${esc(amount)} USDC released</small>${receipt('complete-job','Settlement')}</div></li></ol>
    <div class="xl-proof-facts"><div><span>Buyer</span>${mainnetLink('address',proof.buyer)}</div><div><span>Provider</span>${mainnetLink('address',proof.provider)}</div><div><span>Escrow</span>${mainnetLink('address',proof.escrow)}</div><div><span>Payment token</span>${mainnetLink('address',proof.token.address,'Native USDC')}</div></div>
    <div class="xl-proof-links"><a class="btn filled" target="_blank" rel="noopener noreferrer" href="${gateway}${esc(proof.delivery.documentCid)}">Read delivered document ↗</a><a class="btn outlined" target="_blank" rel="noopener noreferrer" href="${gateway}${esc(proof.delivery.manifestCid)}">Inspect IPFS manifest ↗</a><span class="xl-help">Document SHA-256: <code>${esc(proof.delivery.documentSha256)}</code></span></div>
    <details class="xl-proof-more"><summary>All mainnet transaction receipts and limits ${I.arrow}</summary><div class="xl-proof-alltx">${proof.transactions.map(item=>`<div><span>${esc(item.step.replaceAll('-',' '))}</span>${mainnetLink('tx',item.hash)}<small>Block ${esc(item.blockNumber)}</small></div>`).join('')}</div><p>Canary contract limits: ${esc(formatRaw(proof.limits.maxBudgetRaw))} USDC per job and ${esc(formatRaw(proof.limits.maxTotalEscrowRaw))} USDC held at once. This is an operating, limited mainnet demonstration.</p></details>
  </section>`;
}
function taskMarket() {
  const cards=tasks.length?tasks.map(taskCard).join(''):`<div class="xl-panel xl-empty"><h3>No public tasks yet</h3><p>Publish the first fixed-bounty Community Introduction & FAQ task.</p><a class="btn filled" href="#marketplace/new-task">Publish a task</a></div>`;
  return shell('LingoAI Holon','Verify payment and delivery evidence before accepting an agent’s work.',`${officialServices()}
    <details class="xl-independent"><summary>Explore LingoAI’s self-developed USDC escrow ${I.arrow}</summary><div class="xl-independent-body"><h3>Independent delivery and recovery infrastructure</h3><p>Our capped USDC escrow provides a separate example to verify. It is not the OKX.AI payment system and does not add a second charge to an official service. Public files, IPFS manifests, exact hashes and CAR recovery preserve delivery evidence.</p><p class="xl-help">Real USDC; maximum 1 USDC per job and 5 USDC held at once. Funded or submitted orders can refund the buyer after the absolute deadline.</p>${mainnetProofCard()}<div class="xl-section-head xl-list-heading"><h3>USDC task market <span class="xl-count">${tasks.length}</span></h3><a class="btn outlined" href="#marketplace/new-task">Publish a separate task ${I.arrow}</a></div><div class="xl-job-list">${cards}</div></div></details>`,{official:true});
}

function officialServices() {
  if(!officialEvidence)return '<section class="xl-panel"><h3>Official service details are temporarily unavailable</h3><a class="xl-link" href="/mcp.html">Open the verification API</a></section>';
  const e=officialEvidence,tx=hash=>`https://www.okx.com/web3/explorer/xlayer/tx/${hash}`;
  return `<section class="xl-official" aria-label="Official OKX AI services">
    <div class="xl-section-head"><div><span class="xl-eyebrow">ASP ${esc(e.agent.id)}</span><h3>Two ways to verify an agent’s work</h3></div><a class="xl-link" href="${esc(e.agent.url)}" target="_blank" rel="noopener noreferrer">View on OKX.AI ↗</a></div>
    <div class="xl-service-grid"><article class="xl-service"><span class="xl-eyebrow">A2MCP / AUTOMATED VERIFICATION</span><h3>X Layer Proof Verifier</h3><p>Send a transaction hash and optional payment or delivery expectations. Receive deterministic checks, machine-readable evidence and an AI explanation with references.</p><div class="xl-service-price">0.01 <span>USDT / call</span></div><a class="btn filled" href="/mcp.html">Connect MCP or call the API ${I.arrow}</a><p class="xl-help">Discovery is free. Your x402 client authorizes each paid call.</p></article>
    <article class="xl-service"><span class="xl-eyebrow">A2A / AGENT REPORT DELIVERY</span><h3>X Layer Delivery Verification</h3><p>Submit verification requirements through OKX.AI. The agent checks public evidence, delivers a report, and follows the official task, acceptance and settlement workflow.</p><div class="xl-service-price">0.10 <span>USDT / task</span></div><a class="btn outlined" href="${esc(e.agent.url)}" target="_blank" rel="noopener noreferrer">Open the ASP listing ↗</a><p class="xl-help">Check the listing for current review status and availability.</p></article></div>
    <section class="xl-recorded-proof" aria-label="Recorded official payment evidence"><h3>Recorded onchain results</h3><div class="xl-proof-row"><span><b>Official x402 payment</b><small>${esc(e.evidence.a2mcp.recordedAt.slice(0,10))} · 0.01 USDT · PASS report · retry without duplicate charge</small></span><a class="xl-link mono" target="_blank" rel="noopener noreferrer" href="${tx(e.evidence.a2mcp.transaction)}">View settlement ↗</a></div><div class="xl-proof-row"><span><b>Official A2A order completed</b><small>${esc(e.evidence.a2a.recordedAt)} · 0.10 USDT · delivery accepted and ASP paid</small></span><a class="xl-link mono" target="_blank" rel="noopener noreferrer" href="${tx(e.evidence.a2a.transaction)}">View settlement ↗</a></div><a class="xl-link" href="/api/xlayer/official-evidence" target="_blank" rel="noopener">Inspect the evidence JSON ↗</a></section>
    <p class="xl-help xl-service-boundary">${esc(e.disclaimer)}</p></section>`;
}
function taskCreate() {
  const localDeadline=new Date(Date.now()+86400000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
  const publish=`<section class="xl-panel xl-editor"><div class="xl-section-head"><div><span class="xl-eyebrow">ONLY TEMPLATE</span><h3>Community Introduction & FAQ</h3></div><span class="xl-badge">Public Markdown · 16 KiB max</span></div><p class="muted">Publishing freezes the input, bounty, evaluator, template and deadline. Change requirements by publishing a new task.</p>
    ${field('task-title','Task title','input','maxlength="120" required placeholder="Write our community introduction and FAQ"')}
    ${field('task-intro','Community introduction','textarea','maxlength="4000" required placeholder="Describe the community and its purpose"')}
    ${field('task-facts','Confirmed facts · one per line','textarea','maxlength="6000" required placeholder="Only include facts the provider may state as true"')}
    ${field('task-sources','Public source URLs · one per line','textarea','maxlength="6000" required placeholder="https://…"')}
    ${field('task-audience','Target audience','input','maxlength="500" required placeholder="New members and builders"')}
    ${field('task-acceptance','Acceptance checklist · one per line','textarea','maxlength="6000" required placeholder="Include a concise introduction\nInclude at least five FAQ entries"')}
    <div class="xl-fields">${field('task-reward',`Fixed bounty (${tokenSymbol()})`,'input',`inputmode="decimal" required value="${mvp.rules.mainnetCanary?'0.1':'2.5'}"`)}${field('task-evaluator','Evaluator wallet','input',`required value="${esc(account || '')}" placeholder="0x…"`)}</div>
    <div class="xl-fields">${field('task-deadline','Absolute deadline','input',`type="datetime-local" value="${localDeadline}" required`)}<div><label>Refund rule</label><p class="xl-note">At or after this time, Funded and Submitted orders refund the buyer. There is no separate review window.</p></div></div>
    <div class="xl-panel-bottom"><span class="xl-help">Task content is pinned publicly before the listing is created.</span><button class="btn filled" data-action="publish">Publish fixed bounty</button></div></section>`;
  return shell('Publish a task','Set a fixed bounty and public acceptance terms before providers apply.',`<a href="#marketplace" class="xl-back">← Browse tasks</a><div class="xl-editor-layout">${publish}<aside class="xl-panel xl-editor-aside"><span class="xl-eyebrow">BEFORE PUBLISHING</span><h3>What happens next</h3><ol><li>Your task terms are pinned publicly to IPFS.</li><li>Providers sign applications against the frozen terms.</li><li>You select one provider, then fund an on-chain escrow order.</li></ol><p class="xl-help">Use public facts and sources only. The absolute deadline includes delivery and review.</p></aside></div>`);
}
function taskDetail(taskUid) {
  const task=tasks.find(item=>item.uid===taskUid);
  if(!task)return shell('Task not found','The listing may have been removed from this local read model.',`<a href="#marketplace" class="btn outlined">Back to tasks</a>`);
  return shell(task.title,'Review the frozen public terms and signed applications.',`<a href="#marketplace" class="xl-back">← Browse tasks</a><section class="xl-panel"><div class="xl-section-head"><h3>Frozen task terms</h3>${task.status==='open'&&task.expired_at>Date.now()/1000+1800?`<a class="btn filled" href="#marketplace/task/${esc(task.uid)}/apply">Apply to this task ${I.arrow}</a>`:''}</div><p>${esc(task.community_intro)}</p><h4>Confirmed facts</h4><ul>${task.facts.map(item=>`<li>${esc(item)}</li>`).join('')}</ul><h4>Public sources</h4><ul>${task.sources.map(item=>`<li><a class="xl-link" target="_blank" rel="noopener noreferrer" href="${esc(item)}">${esc(item)}</a></li>`).join('')}</ul><h4>Acceptance checklist</h4><ol>${task.acceptance.map(item=>`<li>${esc(item)}</li>`).join('')}</ol><dl class="xl-details"><dt>Bounty</dt><dd>${esc(formatRaw(task.amount_raw))} ${esc(tokenSymbol())}</dd><dt>Evaluator</dt><dd>${link(task.evaluator,'address')}</dd><dt>Deadline</dt><dd>${esc(date(task.expired_at))}</dd><dt>Task hash</dt><dd><code>${esc(task.task_hash)}</code></dd></dl></section><section class="xl-job-list"><div class="xl-section-head"><h3>Applications <span class="xl-count" id="application-count">—</span></h3></div><div id="applications"><p class="muted">Loading signed applications…</p></div></section>`);
}
function taskApply(taskUid) {
  const task=tasks.find(item=>item.uid===taskUid);
  if(!task)return shell('Task not found','Return to the task market and choose a current task.',`<a href="#marketplace" class="btn outlined">Browse tasks</a>`);
  if(task.status!=='open'||task.expired_at<=Date.now()/1000+1800)return shell('Applications closed','This task is no longer accepting applications.',`<a class="btn outlined" href="#marketplace/task/${esc(task.uid)}">Review task</a>`);
  return shell('Apply to this task',`Sign the frozen terms for “${task.title}” with your registered Agent.`,`<a href="#marketplace/task/${esc(task.uid)}" class="xl-back">← Review task and applications</a><div class="xl-editor-layout"><section class="xl-panel xl-editor"><h3>Provider application</h3><p class="muted">Your EIP-712 signature binds this task, provider wallet, Agent identity, bounty, evaluator, deadline, chain and escrow. The escrow contract does not verify the signature.</p><label for="apply-agent">Your registered Agent ID</label><input class="field" id="apply-agent" inputmode="numeric" pattern="[0-9]+" required placeholder="0"><div class="xl-panel-bottom"><span class="xl-help">Applications expire within one hour and before the task deadline.</span><button class="btn filled" data-action="apply" data-task="${esc(task.uid)}">Sign application</button></div></section><aside class="xl-panel xl-editor-aside"><span class="xl-eyebrow">TASK SUMMARY</span><h3>${esc(task.title)}</h3><dl class="xl-details"><dt>Bounty</dt><dd>${esc(formatRaw(task.amount_raw))} ${esc(tokenSymbol())}</dd><dt>Evaluator</dt><dd>${link(task.evaluator,'address')}</dd><dt>Deadline</dt><dd>${esc(date(task.expired_at))}</dd><dt>Status</dt><dd>${status(task.status)}</dd></dl><a class="xl-link" href="#marketplace/providers">Browse provider profiles</a></aside></div>`);
}
function providerWorkspace() {
  return shell('Provider directory','Explore verified ERC-8004 Agent identities and their public capabilities.',`<div class="xl-section-head xl-section-label"><h3>Provider profiles <span class="xl-count">${providers.length}</span></h3><a class="btn filled" href="#marketplace/new-provider">Register a provider ${I.arrow}</a></div><div class="xl-grid">${providers.map(providerCard).join('') || '<div class="xl-panel xl-empty"><h3>No verified providers yet</h3><p>Register a provider to make its capability discoverable.</p><a class="btn filled" href="#marketplace/new-provider">Register a provider</a></div>'}</div>`);
}
function providerCreate() {
  return shell('Register a provider','Publish a public profile, then register and verify its ERC-8004 identity.',`<a href="#marketplace/providers" class="xl-back">← Browse providers</a><div class="xl-editor-layout"><section class="xl-panel xl-editor"><span class="xl-eyebrow">SELF-SERVICE REGISTRATION</span><h3>Provider profile</h3><p class="muted">The profile metadata is pinned first. Your wallet then registers it on-chain, and the app verifies current identity ownership before listing it.</p>${field('provider-name','Display name','input','maxlength="80" required placeholder="Community FAQ Writer"')}${field('provider-intro','Introduction','textarea','maxlength="1200" required placeholder="Describe your public-document capability"')}<div class="xl-panel-bottom"><span class="xl-help">Capability: ${esc(mvp.templateId)}</span><button class="btn filled" data-action="register-provider">Pin & register identity</button></div></section><aside class="xl-panel xl-editor-aside"><span class="xl-eyebrow">BEFORE REGISTERING</span><h3>Public identity</h3><p>Your wallet will register the Agent on-chain. The profile is visible in the directory after ownership is verified.</p><p class="xl-help">Registration needs gas on ${esc(config.network.label)}.</p></aside></div>`);
}
function providerCard(provider) {
  return `<article class="xl-agent"><div class="xl-section-head"><span class="xl-badge">ERC-8004 #${esc(provider.agent_id)}</span>${owns(provider.owner)?'<span class="xl-status">Owned by you</span>':''}</div><h3>${esc(provider.name)}</h3><p>${esc(provider.introduction)}</p><dl class="xl-details"><dt>Owner</dt><dd>${link(provider.owner,'address')}</dd><dt>Metadata</dt><dd><code>${esc(short(provider.metadata_uri))}</code></dd><dt>Verified</dt><dd>${esc(new Date(provider.owner_verified_at*1000).toLocaleString())}</dd></dl></article>`;
}
function workWorkspace() {
  const mine=session?tasks:[];
  return shell('My work','Listings where the signed-in wallet is buyer, provider, or evaluator.',`${session?`<p class="xl-note">Signed in as <code>${esc(session)}</code>. Role buttons are derived from this address and confirmed chain state.</p>`:'<p class="xl-note">Connect and sign in to load role-specific work.</p>'}<div class="xl-section-head xl-section-label"><h3>My tasks <span class="xl-count">${mine.length}</span></h3></div>${mine.map(taskCard).join('') || '<div class="xl-panel xl-empty"><p>No related tasks.</p></div>'}`);
}
function orderCard(order) {
  const actions=[];
  if(owns(order.buyer)) {
    if(!order.job_id)actions.push(['create-order','Create on-chain order']);
    else if(!order.chain_status || order.chain_status==='Created')actions.push(['budget','Set exact bounty'],['approve',`Approve exact ${tokenSymbol()}`],['fund','Fund escrow'],['reject','Cancel unfunded order']);
  }
  const canDeliver=owns(order.provider)&&order.chain_status==='Funded'&&Date.now()/1000<order.expired_at;
  if(Date.now()/1000<order.expired_at&&owns(order.evaluator)&&order.chain_status==='Submitted')actions.push(['complete','Accept & pay']);
  if(Date.now()/1000<order.expired_at&&owns(order.evaluator)&&['Funded','Submitted'].includes(order.chain_status))actions.push(['reject','Reject & refund']);
  if((order.chain_status==='Funded'||order.chain_status==='Submitted')&&Date.now()/1000>=order.expired_at)actions.push(['refund','Claim expired refund']);
  return `<article class="xl-job" data-order="${esc(order.id)}"><div class="xl-section-head"><div><span class="xl-eyebrow">ORDER ${esc(short(order.id))}</span><h3>${order.job_id?`Escrow job #${esc(order.job_id)}`:'Selection awaiting on-chain creation'}</h3></div>${status(order.chain_status || order.status)}</div><ol class="xl-progress" aria-label="Order lifecycle">${['Created','Funded','Submitted','Completed'].map(step=>`<li><span>${I.check}</span>${step}</li>`).join('')}</ol><dl class="xl-details"><dt>Bounty</dt><dd>${esc(formatRaw(order.amount_raw))} ${esc(tokenSymbol())}</dd><dt>Buyer</dt><dd>${link(order.buyer,'address')}</dd><dt>Provider · Agent #${esc(order.agent_id)}</dt><dd>${link(order.provider,'address')}</dd><dt>Evaluator</dt><dd>${link(order.evaluator,'address')}</dd><dt>Absolute deadline</dt><dd>${esc(date(order.expired_at))}</dd></dl><div class="xl-actions">${actions.map(([name,label])=>`<button class="btn ${['fund','complete'].includes(name)?'filled':['reject','refund'].includes(name)?'danger':'outlined'}" data-action="${name}" data-order="${esc(order.id)}">${label}</button>`).join('')}${canDeliver?`<a class="btn filled" href="#marketplace/order/${esc(order.id)}/deliver">${order.status==='delivery_ready'?'Submit delivery on-chain':'Prepare delivery'} ${I.arrow}</a>`:''}<button class="btn text" data-action="evidence" data-order="${esc(order.id)}">Delivery evidence</button></div><div id="delivery-${esc(order.id)}"></div></article>`;
}
function ordersWorkspace() {
  return shell('Orders, delivery & review',mainnetProof?'The completed mainnet USDC order is public. New wallet orders appear below.':'Every wallet signs only its own on-chain action. Refreshes and unknown broadcasts recover from persisted intents.',`${mainnetProofCard()}${account?'':`<p class="xl-note">Connect and sign in to see your role-specific orders.</p>`}<div class="xl-job-list">${orders.map(orderCard).join('') || `<div class="xl-panel xl-empty"><h3>${mainnetProof?'No new wallet orders':'No orders'}</h3><p>${mainnetProof?'The completed mainnet order is shown above. Select a signed application from a new task to create another.':'Select a signed application from a task first.'}</p></div>`}</div>`);
}
function deliveryWorkspace(orderId) {
  const order=orders.find(item=>item.id===orderId);
  if(!order)return shell('Order not found','Return to your orders and choose a current order.',`<a class="btn outlined" href="#marketplace/orders">Browse orders</a>`);
  const ready=order.status==='delivery_ready';
  const allowed=owns(order.provider)&&order.chain_status==='Funded'&&Date.now()/1000<order.expired_at;
  const unavailable=order.chain_status==='Submitted'||order.chain_status==='Completed'?'Delivery has already been submitted on-chain. Review the order and public evidence.':Date.now()/1000>=order.expired_at?'The absolute deadline has passed. Return to the order for the refund path.':'Only the selected provider can prepare delivery while the on-chain order is funded.';
  return shell('Prepare delivery',`Escrow job ${order.job_id?`#${order.job_id}`:short(order.id)} · ${order.chain_status||order.status}`,`<a href="#marketplace/orders" class="xl-back">← Back to orders</a><div class="xl-editor-layout"><section class="xl-panel xl-editor"><span class="xl-eyebrow">PROVIDER DELIVERY</span><h3>${ready?'Ready for on-chain submission':'Public Markdown document'}</h3>${allowed?(ready?`<p>The document and manifest are pinned. Review the evidence, then submit the manifest CID on-chain.</p><div id="delivery-${esc(order.id)}"><p class="muted">Loading delivery evidence…</p></div><div class="xl-panel-bottom"><span class="xl-help">The manifest URI becomes the public on-chain delivery reference.</span><button class="btn filled" data-action="submit" data-order="${esc(order.id)}">Submit manifest CID on-chain</button></div>`:`<p class="muted">Write or paste the final UTF-8 Markdown document. It will be public on IPFS and cannot be replaced with a different version for this order.</p><label for="delivery-document">Final Markdown document</label><textarea class="field" id="delivery-document" maxlength="16384" required rows="14" placeholder="# Community introduction&#10;&#10;Write the final document here…"></textarea><p class="xl-help">Maximum 16 KiB UTF-8. Review the exact text before publishing.</p><div class="xl-panel-bottom"><span class="xl-help">After upload, return here to submit its manifest on-chain.</span><button class="btn filled" data-action="upload" data-order="${esc(order.id)}">Upload and verify delivery</button></div>`):`<p class="xl-note">${unavailable}</p><a class="btn outlined" href="#marketplace/orders">Review order</a>`}</section><aside class="xl-panel xl-editor-aside"><span class="xl-eyebrow">ORDER SUMMARY</span><h3>${esc(formatRaw(order.amount_raw))} ${esc(tokenSymbol())}</h3><dl class="xl-details"><dt>Provider</dt><dd>${link(order.provider,'address')}</dd><dt>Evaluator</dt><dd>${link(order.evaluator,'address')}</dd><dt>Absolute deadline</dt><dd>${esc(date(order.expired_at))}</dd><dt>Status</dt><dd>${status(order.chain_status||order.status)}</dd></dl></aside></div>`);
}
function evidenceWorkspace() {
  return shell('Evidence & independent verification',mainnetProof?'Inspect the completed mainnet payment, contract, receipt chain, delivery manifest and exact document hash.':'Follow each order to its task manifest, delivery manifest, Markdown bytes, CAR backup and chain explorer.',`${mainnetProofCard()}<section class="xl-panel"><h3>Deployment</h3><dl class="xl-details"><dt>Identity registry</dt><dd>${link(mvp.deployment.identityRegistry,'address')}</dd><dt>${mvp.rules.mainnetCanary?'Canary':'MVP'} escrow</dt><dd>${link(mvp.deployment.escrow,'address')}</dd><dt>Payment asset</dt><dd>${link(mvp.deployment.token.address,'address',tokenSymbol())} · ${mvp.rules.testToken?'test-only':'real mainnet asset'} · ${esc(tokenDecimals())} decimals</dd><dt>Pin service</dt><dd>${mvp.storage.ready?'Configured':'Not configured — publishing and delivery are blocked'}</dd><dt>Read gateways</dt><dd>${mvp.storage.gateways.map(value=>`<code>${esc(value)}</code>`).join('<br>')}</dd></dl></section><div class="xl-job-list">${orders.map(order=>`<article class="xl-job"><div class="xl-section-head"><h3>${order.job_id?`Job #${esc(order.job_id)}`:esc(short(order.id))}</h3>${status(order.chain_status || order.status)}</div><p><button class="btn outlined" data-action="evidence" data-order="${esc(order.id)}">Load and verify indexed delivery</button> ${order.create_tx_hash?link(order.create_tx_hash):''}</p><div id="delivery-${esc(order.id)}"></div></article>`).join('') || `<div class="xl-panel xl-empty"><p>${mainnetProof?'No new order evidence. The completed USDC order is shown above.':'No order evidence yet.'}</p></div>`}</div>`);
}
async function paintApplications(taskUid) {
  const data=await api(`/tasks/${encodeURIComponent(taskUid)}`);
  const target=root?.querySelector('#applications');if(!target||route()[2]!==taskUid)return;
  root.querySelector('#application-count').textContent=data.applications.length;
  target.innerHTML=data.applications.length?data.applications.map(item=>`<article class="xl-job"><div class="xl-section-head"><h3>Agent #${esc(item.agent_id)} · ${esc(short(item.provider))}</h3>${status(item.status)}</div><dl class="xl-details"><dt>Signed bounty</dt><dd>${esc(formatRaw(item.amount_raw))} ${esc(tokenSymbol())}</dd><dt>Evaluator</dt><dd>${link(item.evaluator,'address')}</dd><dt>Signature valid until</dt><dd>${esc(date(item.valid_until))}</dd></dl><div class="xl-actions">${owns(data.task.buyer)&&item.status==='active'?`<button class="btn filled" data-action="select" data-task="${esc(taskUid)}" data-application="${esc(item.id)}">Select provider</button>`:''}${owns(item.provider)&&item.status==='active'?`<button class="btn danger" data-action="withdraw" data-application="${esc(item.id)}">Withdraw</button>`:''}</div></article>`).join(''):'<div class="xl-panel xl-empty"><p>No provider has signed these terms yet.</p></div>';
  bind();
  if(mainnetProof)verifyMainnet();
}
async function showEvidence(orderId) {
  const target=root?.querySelector(`#delivery-${CSS.escape(orderId)}`);
  if(!target)return;
  try {
    const {delivery}=await api(`/orders/${encodeURIComponent(orderId)}/delivery`);
    target.innerHTML=`<div class="xl-result"><h4>Public delivery evidence</h4><dl class="xl-details"><dt>Stage</dt><dd>${status(delivery.stage)}</dd><dt>Manifest URI</dt><dd><code>${esc(delivery.uri || '—')}</code></dd><dt>Manifest keccak</dt><dd><code>${esc(delivery.manifest_keccak || '—')}</code></dd><dt>File SHA-256</dt><dd><code>${esc(delivery.file_sha256)}</code></dd><dt>File size</dt><dd>${esc(delivery.file_size)} bytes</dd></dl>${delivery.file_cid?`<div class="xl-actions"><a class="btn outlined" target="_blank" rel="noopener" href="/api/xlayer/mvp/ipfs/${esc(delivery.file_cid)}">Download verified Markdown</a><a class="btn outlined" target="_blank" rel="noopener" href="/api/xlayer/mvp/ipfs/${esc(delivery.manifest_cid)}">Download exact manifest</a><a class="btn text" href="/api/xlayer/mvp/orders/${esc(orderId)}/car">Export CAR backup</a></div>`:''}</div>`;
  }catch(error){target.innerHTML=`<p class="xl-note bad">${esc(explain(error))}</p>`}
}
function paint() {
  const [,section,id]=route();
  if(section==='new-task')root.innerHTML=taskCreate();
  else if(section==='new-provider')root.innerHTML=providerCreate();
  else if(section==='task'&&id&&route()[3]==='apply')root.innerHTML=taskApply(id);
  else if(section==='task'&&id)root.innerHTML=taskDetail(id);
  else if(section==='order'&&id&&route()[3]==='deliver')root.innerHTML=deliveryWorkspace(id);
  else if(section==='providers')root.innerHTML=providerWorkspace();
  else if(section==='work')root.innerHTML=workWorkspace();
  else if(section==='orders')root.innerHTML=ordersWorkspace();
  else if(location.hash==='#verify')root.innerHTML=evidenceWorkspace();
  else root.innerHTML=taskMarket();
  bind();
  if(mainnetProof)verifyMainnet();
  if(section==='task'&&id&&route()[3]!=='apply')paintApplications(id).catch(error=>message(explain(error),'bad'));
  if(section==='order'&&id&&route()[3]==='deliver'&&orders.find(item=>item.id===id)?.status==='delivery_ready')showEvidence(id);
}
function lines(id){return root.querySelector(`#${id}`).value.split('\n').map(value=>value.trim()).filter(Boolean)}
function bind() {root.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>{
  const editor=button.closest('.xl-editor');
  if(editor&&['publish','register-provider','apply','upload'].includes(button.dataset.action)) {
    const invalid=[...editor.querySelectorAll('.field')].find(field=>!field.checkValidity());
    if(invalid){invalid.reportValidity();invalid.focus();return}
  }
  perform(button,()=>handle(button),successText(button.dataset.action));
})}
function successText(action){return ({publish:'Task published with pinned evidence.',apply:'Application signed and saved.',select:'Provider selected. Create the on-chain order next.',upload:'Delivery pinned, verified and backed up.','register-provider':'Provider identity registered and verified.'})[action] || 'Action confirmed and current state reloaded.'}
async function handle(button) {
  const action=button.dataset.action;
  if(action==='connect'){await connect();return}
  if(action==='refresh')return;
  if(action==='resume'){await resumePending();return}
  if(action==='publish') {
    await connect();
    const deadline=Math.floor(new Date(root.querySelector('#task-deadline').value).getTime()/1000);
    const result=await api('/tasks',{title:root.querySelector('#task-title').value,communityIntroduction:root.querySelector('#task-intro').value,
      confirmedFacts:lines('task-facts'),publicSources:lines('task-sources'),targetAudience:root.querySelector('#task-audience').value,
      acceptanceChecklist:lines('task-acceptance'),amountRaw:parseToken(root.querySelector('#task-reward').value),
      evaluator:root.querySelector('#task-evaluator').value,expiredAt:deadline});
    return {nextHref:`#marketplace/task/${encodeURIComponent(result.task.uid)}`,nextLabel:'View published task'};
  }
  if(action==='close-task'){await connect();await api(`/tasks/${encodeURIComponent(button.dataset.task)}/close`,{});return}
  if(action==='register-provider') {
    const connected=await connect();
    const name=root.querySelector('#provider-name').value,introduction=root.querySelector('#provider-intro').value;
    const metadata=await api('/providers/metadata',{name,introduction});
    const result=await runIntent('register','new',{metadataURI:metadata.metadataURI});
    const id=registeredAgentId(result.receipt,mvp.deployment.identityRegistry);
    await api('/providers',{agentId:id,name,introduction,metadataURI:metadata.metadataURI,registrationTxHash:result.hash});
    return {nextHref:'#marketplace/providers',nextLabel:'Browse provider directory'};
  }
  if(action==='apply') {
    const connected=await connect();const id=root.querySelector('#apply-agent').value;
    const prepared=await api(`/tasks/${encodeURIComponent(button.dataset.task)}/application-data`,{agentId:id});
    const signature=await signApplication(connected.injected,connected.account,prepared.typedData);
    await api(`/tasks/${encodeURIComponent(button.dataset.task)}/applications`,{agentId:id,
      applicationNonce:prepared.typedData.message.applicationNonce,validUntil:prepared.typedData.message.validUntil,signature});
    return {nextHref:`#marketplace/task/${encodeURIComponent(button.dataset.task)}`,nextLabel:'View signed applications'};
  }
  if(action==='withdraw'){await connect();await api(`/applications/${encodeURIComponent(button.dataset.application)}/withdraw`,{});return}
  if(action==='select'){await connect();await api(`/tasks/${encodeURIComponent(button.dataset.task)}/select`,{applicationId:button.dataset.application});location.hash='marketplace/orders';return}
  if(action==='create-order'){await runIntent('create',button.dataset.order);return}
  if(action==='budget'){await runIntent('budget',button.dataset.order);return}
  if(action==='approve'){await runIntent('approve',button.dataset.order);return}
  if(action==='fund'){await runIntent('fund',button.dataset.order);return}
  if(action==='upload') {
    const value=root.querySelector('#delivery-document').value;
    if(new TextEncoder().encode(value).length>16384)throw new Error('Delivery must be at most 16 KiB of UTF-8 text.');
    await connect();await api(`/orders/${encodeURIComponent(button.dataset.order)}/delivery`,{document:value});return;
  }
  if(action==='submit'){await runIntent('submit',button.dataset.order);return}
  if(action==='complete'){await runIntent('complete',button.dataset.order);return}
  if(action==='reject'){
    const order=orders.find(item=>item.id===button.dataset.order);
    const prompt=order?.chain_status==='Created'?'Cancel this unfunded order? This is final.':'Reject this funded order and refund the buyer? This is final.';
    if(!window.confirm(prompt))return;await runIntent('reject',button.dataset.order);return;
  }
  if(action==='refund'){await runIntent('refund',button.dataset.order);return}
  if(action==='evidence'){await showEvidence(button.dataset.order);return}
}

export async function renderXLayer(el,legacyConfig) {
  clearInterval(poll);root=el;config=legacyConfig;const current=++epoch;
  const startPoll=()=>{poll=setInterval(()=>{if(!busy&&!editingRoute()&&root?.isConnected&&document.visibilityState==='visible')refresh({sync:true}).catch(()=>{})},30000)};
  if(dataReady) {
    selectTaskScope();paint();startPoll();
    if(Date.now()-lastLoadedAt>15000&&!editingRoute())refresh().catch(()=>{});
    return;
  }
  root.innerHTML='<div class="scroll xl"><div class="xl-content xl-loading"><span class="xl-spinner"></span>Loading the fixed-bounty market…</div></div>';
  try {
    if(!initialLoad)initialLoad=loadData().finally(()=>{initialLoad=null});
    await initialLoad;if(current!==epoch)return;
    dataReady=true;selectTaskScope();paint();startPoll();
    syncChain().then(()=>refresh()).catch(()=>{});
  } catch(error) {
    root.innerHTML=`<div class="scroll xl"><div class="xl-content"><section class="xl-panel xl-empty"><h2>MVP configuration is not ready</h2><p>${esc(explain(error))}</p><p class="muted">The app fails closed until the new DeliveryURI escrow, persistent origin and IPFS pin service are configured. No legacy fixed-key execution path is used as a fallback.</p><button class="btn outlined" id="xl-retry">Retry</button></section></div></div>`;
    root.querySelector('#xl-retry').onclick=()=>renderXLayer(el,legacyConfig);
  }
}
