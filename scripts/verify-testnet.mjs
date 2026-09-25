import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {keccak256, toUtf8Bytes, formatEther} from 'ethers';
import {ROOT, networkConfig, provider, checkedDeployment, chainContract, atomicJSON} from '../protocol/chain.mjs';

assert.equal(networkConfig().name, 'xlayer-testnet');
assert.equal(networkConfig().chainId, 1952);
const evidence = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/xlayer/xlayer-testnet.json')));
const p = await provider();
try {
  const d = await checkedDeployment(p);
  assert.equal(d.deploymentId, evidence.deploymentId);
  const registry = chainContract('IdentityRegistryUpgradeable', d.identityRegistry, p);
  const escrow = chainContract('TaskEscrow', d.escrow, p);
  for (const agent of d.agents) {
    assert.equal((await registry.ownerOf(agent.id)).toLowerCase(), agent.owner.toLowerCase());
    assert.equal(await registry.tokenURI(agent.id), agent.metadataURI);
  }
  assert.equal(Number((await escrow.getJob(evidence.demoB.jobId)).status), 3);
  assert.equal(Number((await escrow.getJob(evidence.refund.jobId)).status), 4);
  const transactions = [];
  let totalFee = 0n;
  for (const tx of [...d.transactions, ...evidence.transactions]) {
    const r = await p.getTransactionReceipt(tx.hash);
    assert.ok(r, `Missing receipt ${tx.hash}`);
    assert.equal(r.status, 1);
    assert.equal((await p.getBlock(r.blockNumber)).hash, r.blockHash, 'Receipt must be on the current canonical chain');
    totalFee += r.fee;
    transactions.push({step:tx.step, hash:tx.hash, blockNumber:r.blockNumber, blockHash:r.blockHash, status:r.status, feeOKB:formatEther(r.fee), explorer:`${networkConfig().explorer}/tx/${tx.hash}`});
  }
  const headers = process.env.HOLON_TOKEN ? {Authorization:`Bearer ${process.env.HOLON_TOKEN}`} : {};
  const result = await fetch(`${process.env.HOLON_PUBLIC_URL || evidence.serviceURL}/api/xlayer/jobs/${evidence.demoB.jobId}/result`, {headers});
  assert.equal(result.status, 200);
  const hash = keccak256(toUtf8Bytes(await result.text()));
  assert.equal(hash, evidence.demoB.deliverable);
  assert.equal(hash, (await escrow.getJob(evidence.demoB.jobId)).deliverable);
  const token = chainContract('DemoUSD', d.token.address, p);
  const report = {network:d.network, chainId:d.chainId, readOnly:true, verifiedAt:new Date().toISOString(), blockNumber:await p.getBlockNumber(),
    identitiesVerified:d.agents.map(a => ({id:a.id, owner:a.owner})), completedJob:evidence.demoB.jobId, refundedJob:evidence.refund.jobId,
    resultHashVerified:true, tokenBalancesRaw:{client:String(await token.balanceOf(d.client)), provider:String(await token.balanceOf(d.provider)), escrow:String(await token.balanceOf(d.escrow))},
    totalDeploymentAndDemoFeeOKB:formatEther(totalFee), transactions};
  atomicJSON(path.join(ROOT, 'evidence/xlayer/xlayer-testnet-verification.json'), report);
  console.log(JSON.stringify({ok:true, readOnly:true, chainId:1952, receiptsVerified:transactions.length, identitiesVerified:d.agents.length, resultHashVerified:true, completedJob:report.completedJob, refundedJob:report.refundedJob, tokenBalancesRaw:report.tokenBalancesRaw}, null, 2));
} catch(error) {console.error(error.shortMessage || error.message); process.exitCode=1}
finally {p.destroy()}
