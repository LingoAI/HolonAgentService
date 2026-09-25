import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isAddress, isHexString, keccak256, verifyMessage, verifyTypedData} from 'ethers';
import {ROOT, manifest, networkConfig, readState, localAction, executeJob, transactionData, registryOwner, transactionReceipt} from './chain.mjs';
import {Payments, requirements, buyerCall} from './payments.mjs';

const tokenFile=path.join(ROOT,'data/protocol-token');
fs.mkdirSync(path.dirname(tokenFile),{recursive:true});
try {fs.writeFileSync(tokenFile,crypto.randomBytes(32).toString('hex'),{flag:'wx',mode:0o600})} catch(e) {if(e.code!=='EEXIST')throw e}
const token=fs.readFileSync(tokenFile,'utf8').trim();
const payments=new Payments();
let queue=Promise.resolve();
function serial(work) {const p=queue.then(work);queue=p.catch(()=>{});return p}
function respond(res,status,body,headers={}) {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(body))}
function decimal(value,{positive=false}={}) {
  const text=String(value ?? '');
  if(!/^\d+$/.test(text) || (positive && BigInt(text)<=0n))throw new Error('Expected a positive base-10 integer');
  return text;
}
function jobId(value) {const text=decimal(value,{positive:true});if(text.length>20)throw new Error('Invalid job ID');return text}
function cidURI(value) {
  const text=String(value || '');
  if(text.length>200 || !/^ipfs:\/\/b[a-z2-7]+$/.test(text))throw new Error('Delivery URI must be a lowercase CIDv1 ipfs:// URI');
  return text;
}
function validatePrepare(input,d) {
  const action=input.action;
  if(action==='register') {
    const uri=String(input.metadataURI || '');
    if(Buffer.byteLength(uri)<1 || Buffer.byteLength(uri)>2048 || !/^(ipfs:\/\/b[a-z2-7]+|https:\/\/[^\s]+)$/.test(uri))throw new Error('Metadata URI must be a public HTTPS or CIDv1 IPFS URI');
  }
  if(action==='create') {
    if(!isAddress(input.evaluator))throw new Error('Valid evaluator address required');
    decimal(input.agentId);
    decimal(input.expiredAt,{positive:true});
    if(typeof input.description!=='string' || !input.description.trim() || Buffer.byteLength(input.description)>4096)throw new Error('Task description must be 1–4096 bytes');
  }
  if(['budget','approve','fund','submit','complete','reject','refund'].includes(action))jobId(input.jobId);
  if(action==='budget') {
    const amount=String(input.amount ?? '');
    if(!/^\d+(\.\d+)?$/.test(amount) || Number(amount)<=0 || (amount.split('.')[1]?.length || 0)>d.token.decimals)throw new Error(`Amount must use at most ${d.token.decimals} decimal places`);
  }
  if(['approve','fund'].includes(action))decimal(input.budgetRaw,{positive:true});
  if(action==='submit') {
    if(!isHexString(input.deliverable,32) || /^0x0{64}$/i.test(input.deliverable))throw new Error('Non-zero bytes32 deliverable required');
    cidURI(input.uri);
  }
  if(['complete','reject'].includes(action) && input.reason!=null && !isHexString(input.reason,32))throw new Error('Reason must be bytes32');
}
async function body(req) {
  let size=0; const parts=[];
  for await (const part of req) {size+=part.length;if(size>32768)throw new Error('Request exceeds 32 KiB');parts.push(part)}
  return JSON.parse(Buffer.concat(parts).toString() || '{}');
}
const server=http.createServer(async(req,res)=>{
  try {
    if(req.url==='/health')return respond(res,200,{ok:true,network:networkConfig().name});
    const got=Buffer.from(String(req.headers['x-protocol-token'] || ''));
    const want=Buffer.from(token);
    if(got.length!==want.length || !crypto.timingSafeEqual(got,want))return respond(res,401,{error:'Unauthorized protocol request'});
    const input=req.method==='POST' ? await body(req) : {};
    if(req.url==='/state' && req.method==='GET') {
      const s=await readState();
      // The facilitator key is optional for browsing / escrow; report availability separately.
      let x402Error=null;
      try {await payments.initialize()} catch(e) {x402Error=e.message}
      return respond(res,200,{ok:true,...s,paymentRequirements:requirements(s.deployment),payments:payments.history(),x402Available:!x402Error,x402Error});
    }
    if(req.url==='/prepare' && req.method==='POST') {
      if(!isAddress(input.account))throw new Error('Valid wallet account required');
      const allowed=['register','create','budget','approve','fund','submit','complete','reject','refund'];
      if(!allowed.includes(input.action))throw new Error('Unsupported wallet action');
      const d=manifest();
      validatePrepare(input,d);
      return respond(res,200,{ok:true,transaction:transactionData(input.action,input,d)});
    }
    if(req.url==='/verify-message' && req.method==='POST') {
      if(typeof input.message!=='string' || Buffer.byteLength(input.message)>8192 || !isHexString(input.signature,65))throw new Error('Invalid signed message');
      return respond(res,200,{ok:true,address:verifyMessage(input.message,input.signature)});
    }
    if(req.url==='/keccak' && req.method==='POST') {
      if(typeof input.bytesBase64!=='string')throw new Error('bytesBase64 is required');
      const value=Buffer.from(input.bytesBase64,'base64');
      if(value.length>8192 || value.toString('base64')!==input.bytesBase64)throw new Error('Invalid or oversized bytes');
      return respond(res,200,{ok:true,keccak256:keccak256(value)});
    }
    if(req.url==='/verify-typed-data' && req.method==='POST') {
      if(!input.domain || !input.types || !input.value || !isHexString(input.signature,65))throw new Error('Invalid typed-data signature');
      const d=manifest();
      if(Number(input.domain.chainId)!==d.chainId || String(input.domain.verifyingContract).toLowerCase()!==d.escrow.toLowerCase())throw new Error('Typed-data domain does not match this deployment');
      return respond(res,200,{ok:true,address:verifyTypedData(input.domain,input.types,input.value,input.signature)});
    }
    if(req.url==='/registry-owner' && req.method==='POST') {
      decimal(input.agentId);
      return respond(res,200,{ok:true,...await registryOwner(input.agentId)});
    }
    if(req.url==='/receipt' && req.method==='POST') {
      if(!isHexString(input.hash,32))throw new Error('Invalid transaction hash');
      return respond(res,200,{ok:true,...await transactionReceipt(input.hash)});
    }
    if(req.url==='/local-action' && req.method==='POST')return respond(res,200,{ok:true,...await serial(()=>localAction(input.action,input))});
    if(req.url==='/execute-job' && req.method==='POST') {
      if(networkConfig().name!=='local')throw new Error('Platform provider signing is disabled on public networks');
      if(!/^\d{1,20}$/.test(String(input.jobId)))throw new Error('Invalid job ID');
      return respond(res,200,{ok:true,...await serial(()=>executeJob(input.jobId))});
    }
    if(req.url==='/service' && req.method==='POST') {
      if(typeof input.text!=='string')throw new Error('text must be a string');
      const r=await serial(()=>payments.call(input.text,req.headers['payment-signature']));
      return respond(res,r.status,r.body,r.headers);
    }
    if(req.url==='/local-buyer' && req.method==='POST') {
      if(networkConfig().name!=='local')throw new Error('Local buyer is disabled on public networks');
      // Real HTTP buyer -> seller loop through the public FastAPI route.
      const r=await buyerCall(process.env.LOCAL_APP_URL || 'http://127.0.0.1:8765',input.text);
      return respond(res,r.httpStatus,r.body);
    }
    respond(res,404,{error:'Unknown protocol endpoint'});
  } catch(e) {respond(res,400,{ok:false,error:String(e.shortMessage || e.message).slice(0,250)})}
});
server.requestTimeout=130000;
server.listen(Number(process.env.PROTOCOL_PORT || 9402),'127.0.0.1',()=>console.log(`Protocol service ready (${networkConfig().name})`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
