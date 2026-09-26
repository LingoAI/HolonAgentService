import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {keccak256, toUtf8Bytes, parseUnits, formatUnits, Transaction} from 'ethers';
import {buyerCall, requirements, Payments} from '../protocol/payments.mjs';
import {ROOT, networkConfig, provider, signer, checkedDeployment, chainContract, atomicJSON, transactionData} from '../protocol/chain.mjs';
import {visibleRead} from '../protocol/deployment.mjs';
import {logsInRange} from '../protocol/logs.mjs';

// Dedicated test accounts only. Signed authorizations/raw transactions stay in
// ignored data/, so a retry resumes the same payment and transaction hashes.
assert.equal(networkConfig().name, 'xlayer-testnet');
assert.equal(networkConfig().chainId, 1952);
const base = process.env.HOLON_PUBLIC_URL;
assert.ok(base, 'Set HOLON_PUBLIC_URL to the running testnet service');
// Remote acceptance cannot read the server's private payment journal. Recovery
// is covered separately on that host; keep the HTTP/chain assertions here.
const remote = process.argv.includes('--remote');
const headers = {'Content-Type':'application/json', ...(process.env.HOLON_TOKEN ? {Authorization:`Bearer ${process.env.HOLON_TOKEN}`} : {})};
async function request(route, body, extra = {}) {
  const response = await fetch(base + route, {method:body === undefined ? 'GET' : 'POST', headers:{...headers,...extra}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  return {status:response.status, body:await response.json()};
}
async function api(route, body) {
  const response = await request(route, body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
const p = await provider();
try {
  const d = await checkedDeployment(p), buyer = signer('client', p);
  const config = await api('/api/xlayer/config');
  assert.equal(config.network.chainId, 1952);
  assert.equal(config.deployment.escrow.toLowerCase(), d.escrow.toLowerCase());
  assert.equal(buyer.address.toLowerCase(), d.client.toLowerCase());
  const file = path.join(ROOT, 'data/testnet-demo-progress.json');
  const evidenceFile = path.join(ROOT, 'docs/evidence/xlayer-testnet.json');
  let journal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
  if (journal) assert.equal(journal.deploymentId, d.deploymentId, 'Use a separate journal for a different deployment');
  if (process.argv.includes('--new-run')) {
    assert.ok(!journal || journal.completed, 'Finish the current run before starting another');
    if (journal) atomicJSON(path.join(ROOT, `data/testnet-demo-${journal.runId}.json`), journal);
    journal = null;
  }
  if (journal?.completed) {
    console.log('This testnet run already passed. No new payment or job was created. Use --new-run for another run.');
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(evidenceFile)), null, 2));
  } else {
    const token = chainContract('DemoUSD', d.token.address, p), escrow = chainContract('TaskEscrow', d.escrow, p);
    const balance = address => token.balanceOf(address);
    if (!journal) {
      journal = {deploymentId:d.deploymentId, runId:randomUUID(), startedAt:new Date().toISOString(), expiry:Math.floor(Date.now()/1000)+7200, steps:{}, before:{client:String(await balance(d.client)), provider:String(await balance(d.provider)), escrow:String(await balance(d.escrow))}};
    }
    const save = () => atomicJSON(file, journal); save();
    const price = BigInt(requirements(d).amount), budget = parseUnits('1', d.token.decimals);
    async function receipt(hash) {
      const r = await p.getTransactionReceipt(hash) || await p.waitForTransaction(hash, 1, 120000);
      assert.ok(r, `Pending transaction ${hash}; rerun the same command`);
      assert.equal(r.status, 1, `Transaction reverted: ${hash}`);
      return r;
    }
    async function write(step, action, args) {
      const data = transactionData(action, {...args, account:buyer.address}, d);
      let entry = journal.steps[step];
      if (!entry) {
        const used = Object.values(journal.steps).filter(e => e.raw).map(e => Transaction.from(e.raw).nonce + 1);
        const nonce = Math.max(await p.getTransactionCount(buyer.address, 'pending'), ...used);
        const populated = await buyer.populateTransaction({...data, nonce, gasLimit:800000n});
        const raw = await buyer.signTransaction(populated);
        entry = journal.steps[step] = {raw, hash:keccak256(raw)}; save();
      }
      const parsed = Transaction.from(entry.raw);
      assert.equal(parsed.from.toLowerCase(), buyer.address.toLowerCase());
      assert.equal(parsed.chainId, 1952n);
      assert.equal(parsed.to.toLowerCase(), data.to.toLowerCase());
      assert.equal(parsed.data, data.data);
      assert.equal(parsed.value, 0n);
      assert.equal(keccak256(entry.raw), entry.hash);
      if (!await p.getTransactionReceipt(entry.hash) && !await p.getTransaction(entry.hash)) {
        try {await p.broadcastTransaction(entry.raw)} catch (error) {
          if (!await p.getTransaction(entry.hash)) throw error;
        }
      }
      const r = await receipt(entry.hash);
      entry.blockNumber = r.blockNumber; save();
      console.log(`${step}: ${r.hash}`);
      return r;
    }
    function event(r, name) {
      return r.logs.filter(l => l.address.toLowerCase() === d.escrow.toLowerCase()).map(l => {try {return escrow.interface.parseLog(l)} catch {return null}}).find(e => e?.name === name);
    }
    const text = `X Layer testnet agent commerce acceptance ${journal.runId}. Agent A pays Agent B for text analysis.`;
    if (!journal.payment) {
      let paid;
      if (!journal.signature) {
        const response = await buyerCall(base, text, fetch, {onSignature:signature => {journal.signature = signature; save()}});
        paid = {status:response.httpStatus, body:response.body};
      } else paid = await request('/api/agent/research', {text}, {'PAYMENT-SIGNATURE':journal.signature});
      for (let attempt = 0; paid.status === 202 && attempt < 6; attempt++) {
        await delay(3000);
        paid = await request('/api/agent/research', {text}, {'PAYMENT-SIGNATURE':journal.signature});
      }
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      journal.payment = paid.body; save();
    }
    const paymentReceipt = await receipt(journal.payment.payment.txHash);
    // RPC replicas can report the pre-payment balance just after a receipt.
    // Wait for the known settled delta; an interrupted run may already include
    // the completed task payout, which must remain part of this baseline.
    const completedPayout = journal.steps['complete-pay'];
    if (completedPayout) await receipt(completedPayout.hash);
    const paidProviderBalance = BigInt(journal.before.provider) + price + (completedPayout ? budget : 0n);
    const replayBefore = await visibleRead(() => balance(d.provider), {accept:value => value === paidProviderBalance});
    const replay = await apiWithSignature(journal.signature);
    assert.equal(replay.payment.txHash, paymentReceipt.hash);
    assert.equal(await visibleRead(() => balance(d.provider), {accept:value => value === replayBefore}), replayBefore, 'Replaying a signature must not charge again');
    // Exercise lost-response recovery against real chain logs in a separate
    // journal; leave the running service's settled journal intact.
    if (!remote) {
    const recovery = new Payments(); await recovery.initialize();
    recovery.file = path.join(ROOT, 'data/testnet-payment-recovery.json');
    const interrupted = Object.values(recovery.journal).find(e => e.txHash === paymentReceipt.hash);
    assert.ok(interrupted); delete interrupted.response; delete interrupted.txHash; recovery.save();
    const recovered = await recovery.call(text, journal.signature);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.payment.txHash, paymentReceipt.hash);
    assert.equal(await visibleRead(() => balance(d.provider), {accept:value => value === replayBefore}), replayBefore, 'Lost-response recovery must not charge again');
    }
    const forged = JSON.parse(Buffer.from(journal.signature, 'base64').toString());
    forged.accepted.amount = '1';
    const denied = await request('/api/agent/research', {text}, {'PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(forged)).toString('base64')});
    assert.equal(denied.status, 400);
    const disabled = await request('/api/xlayer/local-action', {action:'create'});
    assert.equal(disabled.status, 403, 'Public chains must disable local test signing');
    console.log(`x402 payment/replay/tamper checks passed: ${paymentReceipt.hash}`);
    async function apiWithSignature(signature) {
      const r = await request('/api/agent/research', {text}, {'PAYMENT-SIGNATURE':signature});
      assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
    }
    const agentId = d.agents.find(a => a.role === 'provider').id;
    async function fundedJob(prefix) {
      const created = await write(`${prefix}-create`, 'create', {agentId, expiredAt:journal.expiry, description:`${prefix} acceptance ${journal.runId}: analyze the agent service economy.`});
      const id = event(created, 'JobCreated').args.jobId.toString();
      await write(`${prefix}-budget`, 'budget', {jobId:id, amount:'1'});
      await write(`${prefix}-approve`, 'approve', {budgetRaw:budget.toString()});
      await write(`${prefix}-fund`, 'fund', {jobId:id, budgetRaw:budget.toString()});
      return id;
    }
    const id = await fundedJob('complete');
    if (!journal.submission) {
      const job = await visibleRead(() => escrow.getJob(id), {accept:j => Number(j.status) >= 1});
      if (Number(job.status) === 1) {
        journal.submission = await api('/api/xlayer/execute-job', {jobId:id});
      } else {
        const logs = await logsInRange((from,to) => escrow.queryFilter(escrow.filters.JobSubmitted(BigInt(id)), from, to), journal.steps['complete-create'].blockNumber, await p.getBlockNumber());
        assert.equal(logs.length, 1, 'Recover the original submission before continuing');
        journal.submission = {txHash:logs[0].transactionHash, deliverable:job.deliverable};
      }
      save();
    }
    await receipt(journal.submission.txHash);
    const rawResponse = await fetch(`${base}/api/xlayer/jobs/${id}/result`, {headers});
    assert.equal(rawResponse.status, 200);
    const raw = await rawResponse.text();
    assert.equal(keccak256(toUtf8Bytes(raw)), journal.submission.deliverable);
    await visibleRead(() => escrow.getJob(id), {accept:j => j.deliverable === journal.submission.deliverable});
    await write('complete-pay', 'complete', {jobId:id});
    await visibleRead(() => escrow.getJob(id), {accept:j => Number(j.status) === 3});
    const refundId = await fundedJob('refund');
    const refunded = await write('refund-reject', 'reject', {jobId:refundId});
    assert.equal(event(refunded, 'Refunded').args.amount, budget);
    await visibleRead(() => escrow.getJob(refundId), {accept:j => Number(j.status) === 4});
    const expectedProvider = BigInt(journal.before.provider) + price + budget;
    await visibleRead(() => balance(d.provider), {accept:value => value === expectedProvider});
    const expectedClient = BigInt(journal.before.client) - price - budget;
    assert.equal(await visibleRead(() => balance(d.client), {accept:value => value === expectedClient}), expectedClient);
    const expectedEscrow = BigInt(journal.before.escrow);
    assert.equal(await visibleRead(() => balance(d.escrow), {accept:value => value === expectedEscrow}), expectedEscrow);
    const txs = [{step:'x402-payment',hash:paymentReceipt.hash}, ...Object.entries(journal.steps).map(([step,e]) => ({step,hash:e.hash})), {step:'complete-submit',hash:journal.submission.txHash}];
    for (const tx of txs) {
      const r = await receipt(tx.hash); tx.blockNumber = r.blockNumber; tx.status = r.status;
      tx.explorer = `${networkConfig().explorer}/tx/${tx.hash}`;
    }
    const state = await api('/api/xlayer/state');
    assert.equal(state.jobs.find(j => j.id === id).status, 'Completed');
    assert.equal(state.jobs.find(j => j.id === refundId).status, 'Rejected');
    const evidence = {network:d.network, chainId:d.chainId, deploymentId:d.deploymentId, runId:journal.runId, verifiedAt:new Date().toISOString(), serviceURL:base,
      contracts:{identityRegistry:d.identityRegistry, token:d.token.address, escrow:d.escrow},
      demoA:{txHash:paymentReceipt.hash, amount:`${formatUnits(price,d.token.decimals)} ${d.token.symbol}`, replayChargedAgain:false, lostResponseRecovered:remote ? null : true, recoveryCheck:remote ? 'Separate server journal check required' : 'Verified using isolated local journal', forgedAmountStatus:denied.status, result:journal.payment.result},
      demoB:{jobId:id, status:'Completed', budget:`1 ${d.token.symbol}`, deliverable:journal.submission.deliverable, resultHashVerified:true},
      refund:{jobId:refundId, status:'Rejected', refunded:`1 ${d.token.symbol}`, txHash:refunded.hash},
      balances:{providerDelta:`${formatUnits(price+budget,d.token.decimals)} ${d.token.symbol}`, buyerDelta:`-${formatUnits(price+budget,d.token.decimals)} ${d.token.symbol}`, escrowReturnedToBaseline:true},
      localSigningHTTPStatus:disabled.status, signingMode:'Dedicated test accounts through CLI; browser extension signing is a separate acceptance step', transactions:txs};
    atomicJSON(evidenceFile, evidence); journal.completed = true; save();
    console.log(JSON.stringify(evidence, null, 2));
  }
} catch (error) {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
} finally {p.destroy()}
