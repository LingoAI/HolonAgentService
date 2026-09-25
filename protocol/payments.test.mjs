import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRequirements,requirements} from './payments.mjs';
import {networkConfig,serviceResult,transactionData} from './chain.mjs';
const d={chainId:1952,provider:'0x3333333333333333333333333333333333333333',escrow:'0x2222222222222222222222222222222222222222',token:{address:'0x1111111111111111111111111111111111111111',name:'Demo USD',version:'1',decimals:6}};
test('exact price uses atomic integer units and rejects mutated chain/token/recipient/amount',()=>{
  const r=requirements(d);
  assert.equal(r.amount,'10000');assert.equal(r.network,'eip155:1952');
  for(const key of ['scheme','network','amount','asset','payTo','maxTimeoutSeconds'])assert.throws(()=>assertRequirements({...r,[key]:'wrong'},r));
  assert.throws(()=>assertRequirements({...r,extra:{...r.extra,version:'9'}},r));
});
test('unknown networks and remote RPCs cannot select public local-dev keys',()=>{
  const previous=process.env.HIRE_NETWORK, rpc=process.env.XLAYER_RPC_URL;
  try {
    process.env.HIRE_NETWORK='xlayer_typo';assert.throws(networkConfig);
    process.env.HIRE_NETWORK='local';process.env.XLAYER_RPC_URL='https://example.org';assert.throws(networkConfig);
  }finally {if(previous===undefined)delete process.env.HIRE_NETWORK;else process.env.HIRE_NETWORK=previous;if(rpc===undefined)delete process.env.XLAYER_RPC_URL;else process.env.XLAYER_RPC_URL=rpc}
});
test('task service rejects empty or oversized input and analyzes Unicode without a model',()=>{
  assert.throws(()=>serviceResult({text:''}));assert.throws(()=>serviceResult({text:'x'.repeat(12001)}));
  const r=serviceResult({text:'Agents pay agents. 人工智能服务。'});
  assert.equal(r.keywords[0].word,'agents');assert.equal(r.keywords[0].count,2);
});
