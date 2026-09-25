import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Payments} from '../protocol/payments.mjs';
import {networkConfig, provider, chainContract} from '../protocol/chain.mjs';

// Explicit testnet acceptance helper, executed in the running container with a
// previously settled test authorization on stdin. Never broadcasts a payment.
assert.equal(networkConfig().chainId, 1952);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.match(input.txHash, /^0x[0-9a-f]{64}$/i);
assert.equal(typeof input.text, 'string');
assert.equal(typeof input.signature, 'string');
const recovery = new Payments();
await recovery.initialize();
const originalFile = recovery.file;
const originalBytes = fs.readFileSync(originalFile);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xlayer-recovery-'));
const p = await provider();
try {
  const token = chainContract('DemoUSD', recovery.d.token.address, p);
  const balances = async () => Promise.all([recovery.d.client, recovery.d.provider, recovery.d.escrow].map(a => token.balanceOf(a)));
  const before = await balances();
  recovery.journal = structuredClone(recovery.journal);
  const entry = Object.values(recovery.journal).find(e => e.txHash === input.txHash);
  assert.ok(entry?.response, 'Only an already settled test payment can be checked');
  delete entry.response;
  delete entry.txHash;
  recovery.file = path.join(temporary, 'payments.json');
  recovery.save();
  recovery.facilitator = {
    verify:async () => {throw new Error('Recovery must find the original chain receipt; new settlement is forbidden')},
    settle:async () => {throw new Error('New settlement is forbidden in this recovery check')},
  };
  const result = await recovery.call(input.text, input.signature);
  assert.equal(result.status, 200);
  assert.equal(result.body.payment.txHash, input.txHash);
  assert.deepEqual(await balances(), before, 'Recovery must not move tokens');
  assert.deepEqual(fs.readFileSync(originalFile), originalBytes, 'The live journal must remain unchanged');
  console.log(JSON.stringify({ok:true, chainId:1952, txHash:input.txHash, recoveredFromChainLogs:true, liveJournalUnchanged:true, balancesUnchanged:true, newSettlementDisabled:true, verifiedAt:new Date().toISOString()}, null, 2));
} finally {
  p.destroy();
  fs.rmSync(temporary, {recursive:true, force:true});
}
