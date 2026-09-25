import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {chainContract,manifest,provider as makeProvider} from '../protocol/chain.mjs';

assert.equal(process.env.HIRE_NETWORK,'xlayer-testnet');
assert.equal(process.env.MVP_DEPLOYMENT_MANIFEST,'xlayer-testnet-mvp.json');
const rpc=await makeProvider();
const d=manifest();
const buyer=new Wallet(process.env.BUYER_PRIVATE_KEY,rpc);
const seller=new Wallet(process.env.AGENT_PROVIDER_PRIVATE_KEY,rpc);
const evaluator=new Wallet(process.env.DEPLOYER_PRIVATE_KEY,rpc);
assert.equal(buyer.address.toLowerCase(),d.client.toLowerCase());
assert.equal(seller.address.toLowerCase(),d.provider.toLowerCase());
assert.equal(evaluator.address.toLowerCase(),d.deployer.toLowerCase());
const registry=chainContract('IdentityRegistryUpgradeable',d.identityRegistry,rpc);
const agentId=2n;
assert.equal((await registry.ownerOf(agentId)).toLowerCase(),seller.address.toLowerCase());
const escrow=chainContract('TaskEscrow',d.escrow,rpc);
const token=chainContract('DemoUSD',d.token.address,rpc);
const amount=1_000_000n;
const before={buyer:await token.balanceOf(buyer.address),provider:await token.balanceOf(seller.address)};

async function nonce(wallet){return Number(await rpc.send('eth_getTransactionCount',[wallet.address,'pending']))}
async function send(wallet,transaction) {
  const response=await wallet.sendTransaction({...transaction,nonce:await nonce(wallet)});
  const receipt=await response.wait();
  assert.equal(receipt.status,1,`transaction failed: ${response.hash}`);
  return receipt;
}
async function call(wallet,contract,name,args) {
  const transaction=await contract.connect(wallet)[name].populateTransaction(...args);
  return send(wallet,transaction);
}
function createdId(receipt) {
  for(const log of receipt.logs)try{const parsed=escrow.interface.parseLog(log);if(parsed?.name==='JobCreated')return parsed.args.jobId}catch{}
  throw new Error('JobCreated event is missing');
}

const head=await rpc.getBlock('latest');
const expiredAt=Number(head.timestamp)+150;
const fundedId=createdId(await call(buyer,escrow,'createAgentJob',[agentId,evaluator.address,expiredAt,
  'MVP expiry verification: a funded order must refund its buyer after the real X Layer block deadline.']));
const submittedId=createdId(await call(buyer,escrow,'createAgentJob',[agentId,evaluator.address,expiredAt,
  'MVP expiry verification: a submitted but unreviewed order must still refund its buyer after the real X Layer block deadline.']));
for(const id of [fundedId,submittedId])await call(buyer,escrow,'setBudget',[id,amount]);
await call(buyer,token,'approve',[d.escrow,amount*2n]);
for(const id of [fundedId,submittedId])await call(buyer,escrow,'fund',[id,amount]);
const deliverable='0x8b5d66da188013d0e6c9b0e20ed65b39a31cb42ac1be2c2ab1dab619b0f367ce';
const uri='ipfs://bafkreievrmw2mk5zugdc7gj6itxeupfdlifmy5rciz2erumzyv25zxaesi';
const submittedReceipt=await call(seller,escrow,'submitWithURI',[submittedId,deliverable,uri]);
assert.ok(submittedReceipt.logs.some(log=>{try{return escrow.interface.parseLog(log)?.name==='DeliveryURI'}catch{return false}}));

while(true) {
  const current=await rpc.getBlock('latest');
  if(Number(current.timestamp)>=expiredAt)break;
  await new Promise(resolve=>setTimeout(resolve,Math.min(10,expiredAt-Number(current.timestamp))*1000));
}
// Anyone may trigger expiry; use two non-buyer roles to prove the caller does
// not receive the refund and cannot redirect it away from the original buyer.
const fundedRefund=await call(evaluator,escrow,'claimRefund',[fundedId]);
const submittedRefund=await call(seller,escrow,'claimRefund',[submittedId]);
let funded,submitted;
for(let attempt=0;attempt<30;attempt++) {
  funded=await escrow.getJob(fundedId);submitted=await escrow.getJob(submittedId);
  if(Number(funded.status)===5 && Number(submitted.status)===5)break;
  await new Promise(resolve=>setTimeout(resolve,2000));
}
assert.equal(Number(funded.status),5);
assert.equal(Number(submitted.status),5);

let after;
for(let attempt=0;attempt<30;attempt++) {
  after={buyer:await token.balanceOf(buyer.address),provider:await token.balanceOf(seller.address),escrow:await token.balanceOf(d.escrow)};
  if(after.buyer===before.buyer && after.provider===before.provider && after.escrow===0n)break;
  await new Promise(resolve=>setTimeout(resolve,2000));
}
assert.deepEqual(after,{buyer:before.buyer,provider:before.provider,escrow:0n});
console.log(JSON.stringify({ok:true,network:d.network,chainId:d.chainId,expiredAt,
  funded:{jobId:fundedId.toString(),status:'Expired',refundTxHash:fundedRefund.hash},
  submitted:{jobId:submittedId.toString(),status:'Expired',deliveryTxHash:submittedReceipt.hash,
    refundTxHash:submittedRefund.hash,deliverable,uri},balancesRaw:{before:{buyer:before.buyer.toString(),
    provider:before.provider.toString()},after:{buyer:after.buyer.toString(),provider:after.provider.toString(),
    escrow:after.escrow.toString()}},refundCallers:{funded:evaluator.address,submitted:seller.address}},null,2));
rpc.destroy();
