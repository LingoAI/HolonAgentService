import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {keccak256, toUtf8Bytes} from 'ethers';
import {ROOT, networkConfig, provider, checkedDeployment, chainContract, atomicJSON} from '../protocol/chain.mjs';

assert.equal(networkConfig().chainId, 1952);
const evidence = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/evidence/xlayer-testnet.json')));
const base = process.env.HOLON_PUBLIC_URL || evidence.serviceURL;
assert.equal(base, evidence.serviceURL, 'Use the service URL of the completed acceptance run');
const checks = [];
async function request(route, body, extra={}) {
  const r = await fetch(base+route, {method:body===undefined?'GET':'POST', headers:{'Content-Type':'application/json',...extra}, ...(body===undefined?{}:{body:JSON.stringify(body)}), signal:AbortSignal.timeout(130000)});
  const raw = await r.text();
  checks.push({route, method:body===undefined?'GET':'POST', status:r.status});
  return {status:r.status, raw, json:()=>JSON.parse(raw)};
}
async function api(route) {const r=await request(route);assert.equal(r.status,200);return r.json()}
const p = await provider();
try {
  const d = await checkedDeployment(p);
  const health = await api('/health'), config = await api('/api/xlayer/config'), state = await api('/api/xlayer/state');
  assert.equal(config.network.chainId,1952);
  assert.equal(config.readonly,false);
  assert.equal(config.deployment.deploymentId,d.deploymentId);
  assert.equal(state.x402Available,true);
  assert.equal(state.jobs.find(j=>j.id===evidence.demoB.jobId).status,'Completed');
  assert.equal(state.jobs.find(j=>j.id===evidence.refund.jobId).status,'Rejected');
  const endpoints=[];
  for (const agent of state.agents) {
    const metadata=JSON.parse(Buffer.from(agent.metadataURI.split(',')[1],'base64').toString());
    assert.ok(metadata.services.every(s=>s.endpoint.startsWith(base+'/')));
    endpoints.push({id:agent.id,services:metadata.services});
  }
  const escrow=chainContract('TaskEscrow',d.escrow,p);
  const resultChecks=[];
  for (const job of state.jobs.filter(j=>j.status==='Completed')) {
    const result=await request(`/api/xlayer/jobs/${job.id}/result`);
    assert.equal(result.status,200);
    const hash=keccak256(toUtf8Bytes(result.raw));
    assert.equal(hash,(await escrow.getJob(job.id)).deliverable);
    resultChecks.push({jobId:job.id,hash,verified:true});
  }
  const quote=await request('/api/agent/research',{text:'Public deployment availability check'});
  assert.equal(quote.status,402);
  assert.ok(quote.json().resource.url.startsWith(base+'/api/agent/research?'));
  assert.equal((await request('/api/xlayer/local-action',{action:'create'})).status,403);
  for (const route of ['/.env','/data/protocol-token']) assert.equal((await request(route)).status,404);
  let replay=null;
  if (process.argv.includes('--replay')) {
    const journal=JSON.parse(fs.readFileSync(path.join(ROOT,'data/testnet-demo-progress.json')));
    assert.equal(journal.completed,true);
    assert.equal(journal.runId,evidence.runId);
    assert.equal(journal.payment.payment.txHash,evidence.demoA.txHash);
    assert.equal((await p.getTransactionReceipt(evidence.demoA.txHash)).status,1);
    const token=chainContract('DemoUSD',d.token.address,p);
    const balances=async()=>Promise.all([d.client,d.provider,d.escrow].map(a=>token.balanceOf(a)));
    const before=await balances();
    const result=await request('/api/agent/research',{text:`X Layer testnet agent commerce acceptance ${journal.runId}. Agent A pays Agent B for text analysis.`},{'PAYMENT-SIGNATURE':journal.signature});
    assert.equal(result.status,200);
    assert.equal(result.json().payment.txHash,evidence.demoA.txHash);
    assert.deepEqual(await balances(),before);
    replay={txHash:evidence.demoA.txHash,httpStatus:200,balancesUnchanged:true};
  }
  const report={verifiedAt:new Date().toISOString(),url:base,revision:health.revision,mode:'active-testnet',chainId:1952,checks,endpoints,
    jobs:state.jobs.map(j=>({id:j.id,status:j.status})),settledPayments:state.payments.filter(p=>p.status==='settled').length,
    resultChecks,x402Available:state.x402Available,localSigningDisabled:true,sensitivePathsNotExposed:true,replay};
  atomicJSON(path.join(ROOT,'docs/evidence/public-service-verification.json'),report);
  console.log(JSON.stringify(report,null,2));
} finally {p.destroy()}
