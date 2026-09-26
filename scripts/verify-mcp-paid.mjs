#!/usr/bin/env node
// Read-only preview by default. --execute makes one explicitly authorized
// 0.01 USDT mainnet payment from the project's existing test buyer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Contract, Interface, JsonRpcProvider, Wallet, formatUnits} from 'ethers';
import {privateKeyToAccount} from 'viem/accounts';
import {x402Client} from '@okxweb3/x402-core/client';
import {ExactEvmScheme} from '@okxweb3/x402-evm/exact/client';
import {decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader} from '@okxweb3/x402-core/http';

const execute = process.argv[2] === '--execute';
assert.ok(process.argv.length === 2 || (execute && process.argv.length === 3), 'Use no arguments or --execute');
const settings = JSON.parse(fs.readFileSync(new URL('../config/verification.json', import.meta.url)));
const buyer = '0x0321ef63b7C10d1E33a7eB1a7b5f431121211eAb';
const endpoint = 'https://holonagentservice.lingoai.io/mcp';
assert.equal(settings.origin + settings.mcpPath, endpoint);
assert.equal(settings.payment.amountRaw, '10000');
assert.equal(settings.fee, '0.01');
assert.equal(settings.payment.asset.toLowerCase(), '0x779ded0c9e1022225f8e0630b35a9b54be713736');
assert.equal(settings.payment.payTo.toLowerCase(), '0x3f46cdd4de647b7b5c29e17d8ddb86174bde6702');
const request = {jsonrpc:'2.0', id:1, method:'tools/call', params:{name:settings.tool, arguments:{txHash:settings.exampleTransactionHash}}};
const directory = new URL('../data/mcp-paid-selftest/', import.meta.url);
const stateFile = new URL('authorization.json', directory);
const evidenceFile = new URL('result.json', directory);
const provider = new JsonRpcProvider('https://rpc.xlayer.tech', 196, {staticNetwork:true, cacheTimeout:-1});
const token = new Contract(settings.payment.asset, ['function balanceOf(address) view returns(uint256)'], provider);
const events = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
function save(file, value) {
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const tmp = new URL(file.href + '.tmp');
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd);}
  finally {fs.closeSync(fd);}
  fs.renameSync(tmp, file);
}
async function invoke(signature) {
  const response = await fetch(endpoint, {method:'POST', redirect:'error', signal:AbortSignal.timeout(60000),
    headers:{'Content-Type':'application/json', Accept:'application/json, text/event-stream',
      ...(signature ? {'PAYMENT-SIGNATURE':signature} : {})}, body:JSON.stringify(request)});
  return {response, body:await response.json()};
}
try {
  if (fs.existsSync(evidenceFile)) {
    const evidence = JSON.parse(fs.readFileSync(evidenceFile));
    if (evidence.ok) {console.log(JSON.stringify({...evidence, alreadyCompleted:true}, null, 2)); process.exitCode = 0;}
    else throw new Error('An earlier test needs reconciliation; do not create another payment');
  } else {
    const unsigned = await invoke();
    assert.equal(unsigned.response.status, 402, 'Endpoint must be payment-ready');
    const challenge = decodePaymentRequiredHeader(unsigned.response.headers.get('payment-required'));
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.resource.url, endpoint);
    assert.equal(challenge.accepts.length, 1);
    const required = challenge.accepts[0];
    assert.equal(required.network, 'eip155:196');
    assert.equal(required.scheme, 'exact');
    assert.equal(required.amount, '10000');
    assert.equal(required.asset.toLowerCase(), settings.payment.asset.toLowerCase());
    assert.equal(required.payTo.toLowerCase(), settings.payment.payTo.toLowerCase());
    const balance = await token.balanceOf(buyer);
    if (!execute) {
      console.log(JSON.stringify({preview:true, endpoint, buyer, payTo:required.payTo, fee:'0.01', currency:'USDT',
        balance:formatUnits(balance,6), sufficientBalance:balance >= 10000n, signed:false, fundsSent:false}, null, 2));
    } else {
      let state;
      if (fs.existsSync(stateFile)) {
        state = JSON.parse(fs.readFileSync(stateFile));
        assert.equal(state.endpoint, endpoint);
        assert.deepEqual(state.request, request);
      } else {
        assert.ok(balance >= 10000n, 'Test buyer needs 0.01 USDT; this script never funds or swaps');
        const key = process.env.BUYER_PRIVATE_KEY;
        assert.equal(new Wallet(key).address, buyer, 'Unexpected test buyer key');
        const client = new x402Client().register('eip155:196', new ExactEvmScheme(privateKeyToAccount(key)));
        const payload = await client.createPaymentPayload(challenge);
        state = {endpoint, request, signature:encodePaymentSignatureHeader(payload), createdAt:new Date().toISOString()};
        save(stateFile, state); // Persist before submission; retries reuse the same authorization.
      }
      const paid = await invoke(state.signature);
      assert.equal(paid.response.status, 200, `Paid response ${paid.response.status}; ${paid.body.code || 'reconcile existing authorization'}`);
      assert.ok(!paid.body.error && !paid.body.result?.isError, 'MCP call must return a successful tool result');
      const report = paid.body.result.structuredContent;
      assert.ok(report && ['PASS','WARNING','FAIL'].includes(report.status), 'Structured verification report required');
      const settlement = decodePaymentResponseHeader(paid.response.headers.get('payment-response'));
      assert.equal(settlement.success, true);
      assert.equal(settlement.network, 'eip155:196');
      assert.match(settlement.transaction, /^0x[0-9a-fA-F]{64}$/);
      state.transaction = settlement.transaction;
      save(stateFile, state);
      const receipt = await provider.waitForTransaction(settlement.transaction, 1, 60000);
      assert.equal(receipt.status, 1);
      const transfers = receipt.logs.filter(log => log.address.toLowerCase() === required.asset.toLowerCase())
        .map(log => {try {return events.parseLog(log);} catch {return null;}}).filter(Boolean);
      assert.ok(transfers.some(log => log.args.from.toLowerCase() === buyer.toLowerCase() &&
        log.args.to.toLowerCase() === required.payTo.toLowerCase() && log.args.value === 10000n), 'Exact buyer-to-ASP transfer required');
      const afterFirst = await token.balanceOf(buyer);
      const replay = await invoke(state.signature);
      assert.equal(replay.response.status, 200);
      assert.deepEqual(replay.body, paid.body, 'Retry must return the cached result');
      assert.equal(decodePaymentResponseHeader(replay.response.headers.get('payment-response')).transaction, settlement.transaction);
      assert.equal(await token.balanceOf(buyer), afterFirst, 'Retry must not charge again');
      const evidence = {ok:true, checkedAt:new Date().toISOString(), endpoint, buyer, payTo:required.payTo,
        fee:'0.01', currency:'USDT', paymentReady:true, paidCallVerified:true, reportStatus:report.status,
        transaction:settlement.transaction, blockNumber:receipt.blockNumber, replayVerified:true,
        checks:['public MCP tools/call','official x402 settlement','exact onchain USDT Transfer','structured report','retry without duplicate charge']};
      save(evidenceFile, evidence);
      // Completed runs never sign again; retain the authorization privately for reconciliation only.
      console.log(JSON.stringify(evidence, null, 2));
    }
  }
} finally {provider.destroy();}
