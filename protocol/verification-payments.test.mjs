import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {VerificationPayments} from './verification-payments.mjs';
import {decodePaymentRequiredHeader,decodePaymentResponseHeader,encodePaymentSignatureHeader} from '@okxweb3/x402-core/http';

const input = {txHash:'0x'+'a'.repeat(64)};
function fixture(t,overrides={}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'holon-payment-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const calls = {verify:0,settle:0,work:0};
  const facilitator = {getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:'eip155:196'}],extensions:[],signers:{}}),
    verify:async()=>{calls.verify++;return {isValid:true};},
    settle:async()=>{calls.settle++;return {success:true,status:'success',network:'eip155:196',transaction:'0x'+'b'.repeat(64)};},...overrides};
  const verify = async()=>{calls.work++;return {ok:true,status:'PASS',verified:true};};
  const payments = new VerificationPayments({directory,facilitator,verify});
  return {payments,calls,directory,facilitator,verify};
}
async function signature(payments) {
  const challenge = await payments.call(input);
  assert.equal(challenge.status,402);
  const required = decodePaymentRequiredHeader(challenge.headers['PAYMENT-REQUIRED']);
  assert.equal(required.accepts[0].amount,'10000');
  assert.equal(required.accepts[0].asset.toLowerCase(),'0x779ded0c9e1022225f8e0630b35a9b54be713736');
  assert.equal(required.accepts[0].extra.name,'USD₮0');
  return {header:encodePaymentSignatureHeader({x402Version:2,accepted:required.accepts[0],
    payload:{authorization:{from:'0x'+'1'.repeat(40),nonce:'0x'+'2'.repeat(64)},signature:'0x1234'}}),required};
}
test('official SDK challenge, verify, work, settlement receipt and durable replay',async t=>{
  const f = fixture(t); const {header} = await signature(f.payments);
  const result = await f.payments.call(input,header);
  assert.equal(result.status,200);
  assert.equal(decodePaymentResponseHeader(result.headers['PAYMENT-RESPONSE']).success,true);
  const restarted = new VerificationPayments({directory:f.directory,facilitator:f.facilitator,verify:f.verify});
  assert.deepEqual(await restarted.call(input,header),result);
  assert.deepEqual(f.calls,{verify:1,settle:1,work:1});
  assert.equal((await restarted.call({txHash:'0x'+'c'.repeat(64)},header)).status,409);
});
test('invalid payment never runs the service or settles',async t=>{
  const f = fixture(t,{verify:async()=>({isValid:false})}); const {header} = await signature(f.payments);
  assert.equal((await f.payments.call(input,header)).status,402);
  assert.equal((await f.payments.call(input,'not-base64')).status,402);
  assert.equal(f.calls.work,0);assert.equal(f.calls.settle,0);
});
test('official facilitator can confirm a review exemption without an onchain transaction',async t=>{
  const f=fixture(t,{settle:async()=>({success:true,status:'success',network:'eip155:196',transaction:''})});
  const {header}=await signature(f.payments);
  const result=await f.payments.call(input,header);
  assert.equal(result.status,200);assert.equal(f.calls.verify,1);
  assert.equal(decodePaymentResponseHeader(result.headers['PAYMENT-RESPONSE']).transaction,'');
  assert.deepEqual(await f.payments.call(input,header),result);
});
test('pending, failed and wrong-network settlements do not release the result',async t=>{
  for(const settlement of [
    {success:true,status:'pending',network:'eip155:196'},
    {success:true,status:'timeout',network:'eip155:196'},
    {success:false,status:'failed',network:'eip155:196'},
    {success:true,status:'success',network:'eip155:1'},
  ]) {
    const f=fixture(t,{settle:async()=>({...settlement,transaction:'0x'+'b'.repeat(64)})});
    const {header}=await signature(f.payments);
    assert.equal((await f.payments.call(input,header)).body.code,'settlement_uncertain');
  }
});
test('parallel retries settle a single authorization once',async t=>{
  const f = fixture(t); const {header} = await signature(f.payments);
  const results = await Promise.all([f.payments.call(input,header),f.payments.call(input,header)]);
  assert.deepEqual(results.map(r=>r.status),[200,200]);assert.equal(f.calls.settle,1);
});
test('upstream failure incurs no charge',async t=>{
  const f = fixture(t); const {header} = await signature(f.payments);
  f.payments.verify = async()=>{throw new Error('RPC unavailable');};
  await assert.rejects(f.payments.call(input,header),/RPC unavailable/);
  assert.equal(f.calls.settle,0);assert.equal(fs.readdirSync(f.directory).length,0);
});
test('uncertain settlement remains durable and is never blindly retried',async t=>{
  let settles = 0;
  const f = fixture(t,{settle:async()=>{settles++;throw new Error('Connection lost after broadcast');}});
  const {header} = await signature(f.payments);
  const result = await f.payments.call(input,header);
  assert.equal(result.body.code,'settlement_uncertain');
  const restarted = new VerificationPayments({directory:f.directory,facilitator:f.facilitator,verify:f.verify});
  assert.equal((await restarted.call(input,header)).body.code,'settlement_uncertain');
  assert.equal(settles,1);
});
test('absent operator configuration fails closed without a payment challenge',async()=>{
  const payments = new VerificationPayments();
  const previous = process.env.OKX_X402_ENABLED;delete process.env.OKX_X402_ENABLED;
  try {const result=await payments.call(input);assert.equal(result.status,503);assert.equal(result.headers['PAYMENT-REQUIRED'],undefined);}
  finally {if(previous!==undefined)process.env.OKX_X402_ENABLED=previous;}
});
