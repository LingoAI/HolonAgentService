import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {Interface, keccak256} from 'ethers';
import {CID} from 'multiformats/cid';
import {sha256} from 'multiformats/hashes/sha2';
import {verifyDelivery, verificationInput, VerificationUnavailable} from './verification.mjs';

const settings = JSON.parse(fs.readFileSync(new URL('../config/verification.json',import.meta.url)));
const abi = new Interface(JSON.parse(fs.readFileSync(new URL('../contracts/artifacts/MainnetCanaryEscrow.json',import.meta.url))).abi);
const tokenABI = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const tx = '0x'+'a'.repeat(64), blockHash = '0x'+'b'.repeat(64);
const sender = '0x'+'1'.repeat(40), recipient = '0x'+'2'.repeat(40), token = '0x'+'3'.repeat(40);
const payment = {token, sender, recipient, amountRaw:'100000'};
const transfer = {...tokenABI.encodeEventLog(tokenABI.getEvent('Transfer'),[sender,recipient,100000]), address:token, logIndex:'0x0'};
const receipt = {transactionHash:tx,status:'0x1',from:sender,to:settings.escrow,blockNumber:'0x64',blockHash,logs:[transfer]};
function reader(current = receipt, job) {
  return async (method) => {
    if (method === 'eth_chainId') return '0xc4';
    if (method === 'eth_blockNumber') return '0x66';
    if (method === 'eth_getTransactionReceipt') return current;
    if (method === 'eth_getBlockByNumber') return {hash:blockHash};
    if (method === 'eth_call' && job) return abi.encodeFunctionResult('getJob',[job]);
    throw new Error('Unexpected RPC: '+method);
  };
}
test('receipt verification reports exact transfer evidence and observed confirmations', async () => {
  const report = await verifyDelivery({transactionHash:tx,expectedPayment:payment},{rpc:reader()});
  assert.equal(report.verified,true);
  assert.equal(report.transaction.confirmations,3);
  assert.equal(report.transfers[0].amountRaw,'100000');
});
test('missing, reverted, wrong hash and noncanonical receipts never pass verification', async () => {
  const absent = await verifyDelivery({transactionHash:tx},{rpc:reader(null)});
  assert.equal(absent.verificationStatus,'not_found');
  for (const change of [{status:'0x0'}, {transactionHash:'0x'+'c'.repeat(64)}, {blockHash:'0x'+'d'.repeat(64)}]) {
    const result = await verifyDelivery({transactionHash:tx},{rpc:reader({...receipt,...change})});
    assert.equal(result.verified,false);
  }
});
test('wrong token, recipient, sender or amount cannot satisfy expected payment', async () => {
  for (const change of [{token:sender},{sender:recipient},{recipient:sender},{amountRaw:'99999'}]) {
    const result = await verifyDelivery({transactionHash:tx,expectedPayment:{...payment,...change}},{rpc:reader()});
    assert.equal(result.verificationStatus,'mismatch');
  }
});
test('NFT Transfer events are not interpreted as ERC-20 payments', async () => {
  const nft = {...transfer,topics:[...transfer.topics,'0x'+'0'.repeat(64)],data:'0x'};
  const result = await verifyDelivery({transactionHash:tx,expectedPayment:payment},{rpc:reader({...receipt,logs:[nft]})});
  assert.equal(result.verified,false); assert.equal(result.transfers.length,0);
});
test('job lookup requires this transaction to contain an event for the configured escrow and job', async () => {
  const result = await verifyDelivery({transactionHash:tx,jobId:'99'},{rpc:reader()});
  assert.equal(result.verified,false); assert.equal(result.job,undefined);
});
async function deliveryFixture() {
  const document = Buffer.from('# Delivery\nVerified bytes.\n');
  const fileCid = CID.createV1(0x55,await sha256.digest(document)).toString();
  const manifest = Buffer.from(JSON.stringify({chainId:196,escrow:settings.escrow,jobId:'1',provider:recipient,
    amountRaw:'100000',token:settings.escrowToken,
    fileCid,fileSize:document.length,fileSha256:crypto.createHash('sha256').update(document).digest('hex')}));
  const manifestCid = CID.createV1(0x55,await sha256.digest(manifest)).toString();
  const digest = keccak256(manifest);
  const event = {...abi.encodeEventLog(abi.getEvent('DeliveryURI'),[1,digest,'ipfs://'+manifestCid]),address:settings.escrow};
  const job = [sender,recipient,sender,100000,2000000000,3,'Order',digest,0,true];
  return {document, manifest, manifestCid, fileCid, digest, rpc:reader({...receipt,logs:[event]},job),
    readCID:async cid => cid === manifestCid ? manifest : document};
}
test('verifies exact manifest/document bytes and their binding to an escrow job', async () => {
  const f = await deliveryFixture();
  const result = await verifyDelivery({transactionHash:tx,jobId:'1',manifestCid:f.manifestCid,expectedDigest:f.digest},f);
  assert.equal(result.verified,true); assert.equal(result.job.status,'Completed');
  assert.equal(result.delivery.fileSize,f.document.length);
});
test('gateway tampering and a wrong expected digest produce a mismatch', async () => {
  const f = await deliveryFixture();
  const corrupt = await verifyDelivery({transactionHash:tx,manifestCid:f.manifestCid},
    {...f, readCID:async () => Buffer.from('untrusted gateway response')});
  assert.equal(corrupt.verified,false); assert.equal(corrupt.delivery.fileCid,undefined);
  const wrong = await verifyDelivery({transactionHash:tx,manifestCid:f.manifestCid,expectedDigest:'0x'+'0'.repeat(64)},f);
  assert.equal(wrong.verified,false);
  const document = await verifyDelivery({transactionHash:tx,manifestCid:f.manifestCid},
    {...f,readCID:async cid => cid === f.manifestCid ? f.manifest : Buffer.from('changed')});
  assert.equal(document.verified,false);
});
test('input validation rejects arbitrary URLs, extra fields and incomplete expectations before any RPC', () => {
  for (const fields of [{manifestCid:'http://127.0.0.1/secret'}, {rpcUrl:'http://evil'}, {jobId:'-1'},
    {expectedPayment:{token}}, {expectedPayer:sender}, {expectedDigest:tx}, {jobId:(2n**256n).toString()}]) {
    assert.equal(verificationInput.safeParse({transactionHash:tx,...fields}).success,false);
  }
});
test('wrong RPC chain fails closed', async () => {
  await assert.rejects(verifyDelivery({transactionHash:tx},{rpc:async () => '0x1'}),VerificationUnavailable);
});
test('document API aliases compare contract and decimal token amount', async () => {
  const tokenInterface = new Interface(['function decimals() view returns (uint8)']);
  const rpc = async (method,params) => method === 'eth_call' ? tokenInterface.encodeFunctionResult('decimals',[6]) : reader()(method,params);
  const result = await verifyDelivery({txHash:tx,contractAddress:settings.escrow,tokenAddress:token,
    expectedPayer:sender,expectedPayee:recipient,expectedAmount:'0.10'},{rpc});
  assert.equal(result.status,'PASS');
  assert.equal(result.userExpectations.expectedPayment.amountRaw,'100000');
  assert.match(result.markdown,/Onchain facts/);
  const mismatch = await verifyDelivery({txHash:tx,contractAddress:recipient},{rpc});
  assert.equal(mismatch.status,'FAIL');
});
test('allowance is queried for explicit token/owner/spender at two concrete block tags', async () => {
  const tokenInterface = new Interface(['function allowance(address,address) view returns (uint256)']);
  const calls = [];
  const rpc = async (method,params) => {
    if (method !== 'eth_call') return reader()(method,params);
    calls.push(params);
    return tokenInterface.encodeFunctionResult('allowance',[params[1] === '0x64' ? 5 : 0]);
  };
  const result = await verifyDelivery({txHash:tx,allowance:{token,owner:sender,spender:recipient}},{rpc});
  assert.deepEqual(calls.map(c=>c[1]),['0x64','0x66']);
  assert.equal(result.allowance.transactionBlock.amountRaw,'5');
  assert.equal(result.allowance.snapshot.amountRaw,'0');
  assert.equal(result.allowance.snapshot.blockNumber,102);
});
test('unavailable allowance is unknown and WARNING, never a fabricated zero', async () => {
  const result = await verifyDelivery({txHash:tx,allowance:{token,owner:sender,spender:recipient}},{rpc:reader()});
  assert.equal(result.status,'WARNING');
  assert.equal(result.allowance.snapshot.amountRaw,null);
});
test('CID-only integrity is flagged as unbound to the transaction', async () => {
  const f = await deliveryFixture();
  const result = await verifyDelivery({txHash:tx,manifestCid:f.manifestCid},f);
  assert.equal(result.status,'WARNING');
  assert.equal(result.deliveryProof.anchor,null);
});
