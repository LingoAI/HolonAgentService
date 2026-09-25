import assert from 'node:assert/strict';
import {keccak256,toUtf8Bytes} from 'ethers';
import {buyerCall,Payments} from '../protocol/payments.mjs';
import {provider,chainContract,manifest,atomicJSON,ROOT} from '../protocol/chain.mjs';
import path from 'node:path';

process.env.HIRE_NETWORK='local';
const base=process.env.LOCAL_APP_URL || 'http://127.0.0.1:8765';
async function api(route,body) {
  const r=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();assert.equal(r.ok,true,JSON.stringify(d));return d;
}
const conf=await api('/api/xlayer/config');assert.equal(conf.network.name,'local','Demo runner is local-only');
const d=manifest(), p=await provider();
try {
  const token=chainContract('DemoUSD',d.token.address,p);
  const before=await token.balanceOf(d.provider);
  const escrowBefore=await token.balanceOf(d.escrow);
  const text='Agent A requests a paid text analysis. Agent B settles and returns verifiable results.';
  const a=await buyerCall(base,text);assert.equal(a.httpStatus,200,JSON.stringify(a.body));
  assert.equal((await token.balanceOf(d.provider))-before,10000n);
  const replay=await fetch(base+'/api/agent/research',{method:'POST',headers:{'Content-Type':'application/json','PAYMENT-SIGNATURE':a.signature},body:JSON.stringify({text})});
  assert.equal(replay.status,200);assert.equal((await replay.json()).payment.txHash,a.body.payment.txHash);
  assert.equal((await token.balanceOf(d.provider))-before,10000n,'Replay must not charge twice');
  // Simulate a service restart after settlement but before receiving the broadcast hash.
  const interrupted=new Payments();await interrupted.initialize();
  const entry=Object.values(interrupted.journal).find(e=>e.txHash===a.body.payment.txHash);
  assert.ok(entry);delete entry.response;delete entry.txHash;interrupted.save();
  const restarted=new Payments();
  const recovered=await restarted.call(text,a.signature);
  assert.equal(recovered.status,200);assert.equal(recovered.body.payment.txHash,a.body.payment.txHash);
  assert.equal((await token.balanceOf(d.provider))-before,10000n,'Restart recovery must not charge twice');
  const forged=JSON.parse(Buffer.from(a.signature,'base64').toString());forged.accepted.amount='1';
  const denied=await fetch(base+'/api/agent/research',{method:'POST',headers:{'Content-Type':'application/json','PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(forged)).toString('base64')},body:JSON.stringify({text})});
  assert.equal(denied.status,400);
  const desc=`Task escrow integration ${Date.now()}: analyze this agent economy.`;
  const write=(action,args={})=>api('/api/xlayer/local-action',{action,...args});
  const create=await write('create',{agentId:d.agents.find(a=>a.role==='provider').id,description:desc,expiredAt:Math.floor(Date.now()/1000)+3600});
  let state=await api('/api/xlayer/state');
  const id=state.jobs.find(j=>j.description===desc).id;
  await write('budget',{jobId:id,amount:'1'});
  await write('approve',{budgetRaw:'1000000'});
  const fund=await write('fund',{jobId:id,budgetRaw:'1000000'});
  const submitted=await api('/api/xlayer/execute-job',{jobId:id});
  const raw=await (await fetch(base+`/api/xlayer/jobs/${id}/result`)).text();
  assert.equal(keccak256(toUtf8Bytes(raw)),submitted.deliverable);
  const complete=await write('complete',{jobId:id});
  state=await api('/api/xlayer/state');
  assert.equal(state.jobs.find(j=>j.id===id).status,'Completed');
  assert.equal((await token.balanceOf(d.provider))-before,1_010_000n);
  assert.equal(await token.balanceOf(d.escrow),escrowBefore);
  const evidence={network:'local',chainId:31337,verifiedAt:new Date().toISOString(),demoA:{txHash:a.body.payment.txHash,amount:'0.01 dUSD',replayChargedAgain:false,restartRecovered:true,result:a.body.result},demoB:{jobId:id,create:create.txHash,fund:fund.txHash,submit:submitted.txHash,complete:complete.txHash,deliverable:submitted.deliverable,status:'Completed',providerBalanceDelta:'1.01 dUSD'}};
  atomicJSON(path.join(ROOT,'data/local-demo-evidence.json'),evidence);
  console.log(JSON.stringify(evidence,null,2));
}finally{p.destroy()}
