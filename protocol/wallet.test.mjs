import test from 'node:test';
import assert from 'node:assert/strict';
import {id,keccak256,toUtf8Bytes,zeroPadValue,toBeHex} from 'ethers';
import {connectNetwork, paymentSignature, registeredAgentId, signApplication, signLogin, tokenBalance, verifyResult, waitForReceipt} from './wallet.mjs';
const network={chainId:1952,label:'X Layer Testnet',nativeCurrency:{name:'OKB',symbol:'OKB',decimals:18},rpcUrl:'https://testrpc.xlayer.tech/terigon',explorer:'https://www.okx.com/web3/explorer/xlayer-test'};
const account='0x1111111111111111111111111111111111111111';
test('wallet adds an unknown X Layer chain, switches, and confirms the actual network',async()=>{
  let chain='0x1',added=false;const calls=[];
  const wallet={request:async({method,params})=>{calls.push(method);if(method==='eth_requestAccounts')return[account];if(method==='eth_chainId')return chain;if(method==='wallet_addEthereumChain'){assert.equal(params[0].chainId,'0x7a0');added=true}if(method==='wallet_switchEthereumChain'){if(!added)throw{code:4902};chain=params[0].chainId}}};
  assert.equal((await connectNetwork(network,wallet)).account,account);
  assert.deepEqual(calls,['eth_requestAccounts','eth_chainId','wallet_switchEthereumChain','wallet_addEthereumChain','wallet_switchEthereumChain','eth_chainId']);
});
test('wallet rejection is preserved and a wallet that fails to switch is rejected',async()=>{
  await assert.rejects(connectNetwork(network,{request:async()=>{throw Object.assign(new Error('rejected'),{code:4001})}}),e=>e.code===4001);
  await assert.rejects(connectNetwork(network,{request:async({method})=>method==='eth_requestAccounts'?[account]:method==='eth_chainId'?'0x1':null}),/did not change/);
});
test('quote tampering is rejected before asking a wallet to sign',async()=>{
  const r={scheme:'exact',network:'eip155:1952',amount:'10000',asset:account,payTo:account,maxTimeoutSeconds:120,extra:{name:'Demo USD',version:'1',assetTransferMethod:'eip3009'}};
  await assert.rejects(paymentSignature({accepts:[{...r,amount:'10001'}]},r,network,{}),/quote changed/);
  await assert.rejects(paymentSignature({accepts:[{...r,extra:{...r.extra,version:'2'}}]},r,network,{}),/domain/);
});
test('mined failed transactions release the pending lock and report failure',async()=>{
  let cleared=false;
  await assert.rejects(waitForReceipt({request:async()=>({status:'0x0'})},'0xabc',{onMined:()=>{cleared=true}}),/Transaction failed/);
  assert.equal(cleared,true);
});
test('pending receipt timeout retains the pending lock for safe retries',async()=>{
  let cleared=false;
  await assert.rejects(waitForReceipt({request:async()=>null},'0xabc',{timeoutMs:5,pollMs:1,onMined:()=>{cleared=true}}),/still pending/);
  assert.equal(cleared,false);
});
test('result verification hashes the exact bytes, detecting modified content',()=>{
  const content='{"result":{"summary":"verified"}}',hash=keccak256(toUtf8Bytes(content));
  assert.equal(verifyResult(content,hash).result.summary,'verified');
  assert.throws(()=>verifyResult(content+' ',hash),/does not match/);
});
test('MVP wallet helpers sign exact SIWE and EIP-712 payloads',async()=>{
  const calls=[];const wallet={request:async input=>{calls.push(input);return '0xsigned'}};
  assert.equal(await signLogin(wallet,account,'exact message'),'0xsigned');
  const typed={domain:{name:'LingoAI DemoUSD Market',version:'1',chainId:1952,verifyingContract:account},
    types:{Application:[{name:'taskUid',type:'string'}]},primaryType:'Application',message:{taskUid:'task_1'}};
  assert.equal(await signApplication(wallet,account,typed),'0xsigned');
  const payload=JSON.parse(calls[1].params[1]);
  assert.equal(payload.message.taskUid,'task_1');
  assert.equal(payload.types.EIP712Domain[2].name,'chainId');
});
test('MVP wallet reads integer token balance and extracts the registered Agent ID',async()=>{
  const wallet={request:async({method,params})=>{assert.equal(method,'eth_call');assert.equal(params[0].to,account);return toBeHex(2_500_001n)}};
  assert.deepEqual(await tokenBalance(wallet,account,account,6),{raw:'2500001',formatted:'2.500001'});
  const registry='0x2222222222222222222222222222222222222222';
  const receipt={logs:[{address:registry,topics:[id('Registered(uint256,string,address)'),zeroPadValue(toBeHex(7),32)]}]};
  assert.equal(registeredAgentId(receipt,registry),'7');
});
