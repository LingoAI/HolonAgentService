import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleRead, deploymentRecords, verifyDeploymentRecord} from './deployment.mjs';

test('deployment reads tolerate temporary empty RPC results, including ABI decode errors', async () => {
  let calls = 0;
  const result = await visibleRead(async () => {
    calls++;
    if (calls === 1) return '0x';
    if (calls === 2) throw Object.assign(new Error('empty result'), {code:'BAD_DATA', value:'0x'});
    return 6n;
  }, {delayMs:0});
  assert.equal(result, 6n); assert.equal(calls, 3);
});
test('deployment read retries are bounded and do not hide contract reverts', async () => {
  let calls = 0;
  await assert.rejects(visibleRead(async () => {calls++; return null}, {attempts:3, delayMs:0}), /not yet visible/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(visibleRead(async () => {calls++; throw Object.assign(new Error('reverted'), {code:'CALL_EXCEPTION'})}, {delayMs:0}), /reverted/);
  assert.equal(calls, 1);
});
const owner = '0x' + '1'.repeat(40), address = '0x' + '2'.repeat(40), hash = '0x' + '3'.repeat(64);
const record = {step:'Identity', address, hash, blockHash:'0xblock'};
const transaction = {from:owner, to:null, data:'0x1234'};
const receipt = {hash, status:1, contractAddress:address, blockNumber:42, blockHash:'0xblock'};
const rpc = (tx = transaction, result = receipt) => ({getTransaction:async () => tx, getTransactionReceipt:async () => result, getCode:async () => '0x1234', getBlock:async () => ({hash:result.blockHash})});
test('resume accepts only an ordered prefix of deployment steps on the selected chain', () => {
  const network = {name:'xlayer-testnet', chainId:1952};
  const progress = {network:network.name, chainId:1952, transactions:[record]};
  assert.deepEqual(deploymentRecords(progress, network, ['Identity','Proxy']), [record]);
  for (const changed of [{chainId:196}, {transactions:[record,record]}, {transactions:[{...record,step:'Proxy'}]}, {transactions:[]}]) {
    assert.throws(() => deploymentRecords({...progress,...changed}, network, ['Identity','Proxy']));
  }
});
test('resume verifies sender, constructor bytes, receipt, address, and block before reusing a contract', async () => {
  assert.equal(await verifyDeploymentRecord(rpc(), record, owner, '0x1234'), receipt);
  for (const changed of [{from:address}, {to:address}, {data:'0x5678'}]) {
    await assert.rejects(verifyDeploymentRecord(rpc({...transaction,...changed}), record, owner, '0x1234'), /transaction mismatch/);
  }
  for (const changed of [{status:0}, {contractAddress:owner}, {hash:'0xother'}]) {
    await assert.rejects(verifyDeploymentRecord(rpc(transaction,{...receipt,...changed}), record, owner, '0x1234'), /receipt mismatch/);
  }
  const canonical = {...receipt, blockHash:'0xcanonical'};
  assert.equal(await verifyDeploymentRecord(rpc(transaction,canonical), record, owner, '0x1234'), canonical);
});
