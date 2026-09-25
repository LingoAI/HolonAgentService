import assert from 'node:assert/strict';
import {Contract,JsonRpcProvider,Wallet} from 'ethers';

const apiBase=(process.env.MVP_API_URL || 'http://127.0.0.1:8765').replace(/\/$/,'');
const configResponse=await fetch(`${apiBase}/api/xlayer/mvp/config`);
const configuration=await configResponse.json();
if(!configResponse.ok || !configuration.ok)throw new Error(`MVP API is not ready: ${JSON.stringify(configuration)}`);
const chainId=Number(configuration.network.chainId);
assert.ok([31337,1952].includes(chainId),'verification supports only local EVM or X Layer Testnet');
const local=chainId===31337;
const rpcUrl=process.env.XLAYER_RPC_URL || (local?'http://127.0.0.1:8545':configuration.network.rpcUrl);
const provider=new JsonRpcProvider(rpcUrl,chainId,{staticNetwork:true});
const keys=local ? {
  buyer:'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  provider:'0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  evaluator:'0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} : {buyer:process.env.BUYER_PRIVATE_KEY,provider:process.env.AGENT_PROVIDER_PRIVATE_KEY,
  evaluator:process.env.DEPLOYER_PRIVATE_KEY};
for(const [role,key] of Object.entries(keys))if(!/^0x[0-9a-fA-F]{64}$/.test(key || ''))throw new Error(`${role} test wallet key is missing`);
const wallets={
  buyer:new Wallet(keys.buyer,provider),provider:new Wallet(keys.provider,provider),evaluator:new Wallet(keys.evaluator,provider),
};

class Session {
  constructor(wallet){this.wallet=wallet;this.cookie=''}
  async request(method,path,body) {
    const response=await fetch(`${apiBase}${path}`,{method,headers:{Accept:'application/json',Origin:apiBase,
      ...(body?{'Content-Type':'application/json'}:{}),...(this.cookie?{Cookie:this.cookie}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const setCookie=response.headers.get('set-cookie');
    if(setCookie)this.cookie=setCookie.split(';',1)[0];
    const type=response.headers.get('content-type') || '';
    const value=type.includes('json')?await response.json():await response.arrayBuffer();
    if(!response.ok || (value && value.ok===false))throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  get(path){return this.request('GET',path)}
  post(path,body={}){return this.request('POST',path,body)}
  async login(){
    const challenge=await this.post('/api/xlayer/mvp/auth/challenge',{address:this.wallet.address});
    const signature=await this.wallet.signMessage(challenge.message);
    const result=await this.post('/api/xlayer/mvp/auth/verify',{nonce:challenge.nonce,signature});
    assert.equal(result.address,this.wallet.address.toLowerCase());
  }
}

const sessions=Object.fromEntries(Object.entries(wallets).map(([name,wallet])=>[name,new Session(wallet)]));
let sequence=0;
const idempotency=label=>`local:${label}:${Date.now()}:${++sequence}`;

async function walletAction(session,action,objectId,extra={}) {
  const prepared=await session.post('/api/xlayer/mvp/intents',{action,objectId,idempotencyKey:idempotency(action),...extra});
  // Query pending directly: JsonRpcProvider's short cache can otherwise reuse a
  // nonce when Hardhat automines several wallet-driven steps back-to-back.
  const nonce=Number(await provider.send('eth_getTransactionCount',[session.wallet.address,'pending']));
  const sent=await session.wallet.sendTransaction({...prepared.transaction,nonce});
  await session.post(`/api/xlayer/mvp/intents/${prepared.intent.id}/broadcast`,{txHash:sent.hash});
  await sent.wait();
  for(let attempt=0;attempt<20;attempt++) {
    const result=await session.post(`/api/xlayer/mvp/intents/${prepared.intent.id}/reconcile`);
    if(!result.pending) {
      assert.equal(result.ok,true,JSON.stringify(result));
      return result;
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`receipt did not become visible for ${action}`);
}

async function createOrder(label,expiredAt,amountRaw='1000000') {
  const task=(await sessions.buyer.post('/api/xlayer/mvp/tasks',{
    title:`${label}: write a public community FAQ`,
    communityIntroduction:'A public builder community testing fixed-bounty settlement on a local X Layer-compatible EVM.',
    confirmedFacts:['Settlement uses the test-only six-decimal dUSD token.','The deliverable is public Markdown.'],
    publicSources:['https://www.okx.com/learn','https://docs.ipfs.tech/concepts/content-addressing/'],
    targetAudience:'New community members and hackathon reviewers',
    acceptanceChecklist:['Include a concise introduction','Include at least five FAQ entries','Cite the supplied public sources'],
    amountRaw,evaluator:wallets.evaluator.address,expiredAt,
  })).task;
  const typed=(await sessions.provider.post(`/api/xlayer/mvp/tasks/${task.uid}/application-data`,{agentId})).typedData;
  const signature=await wallets.provider.signTypedData(typed.domain,typed.types,typed.message);
  const application=(await sessions.provider.post(`/api/xlayer/mvp/tasks/${task.uid}/applications`,{
    agentId,applicationNonce:typed.message.applicationNonce,validUntil:typed.message.validUntil,signature,
  })).application;
  let order=(await sessions.buyer.post(`/api/xlayer/mvp/tasks/${task.uid}/select`,{applicationId:application.id})).order;
  await walletAction(sessions.buyer,'create',order.id);
  order=(await sessions.buyer.get(`/api/xlayer/mvp/orders/${order.id}`)).order;
  assert.ok(order.job_id);
  return order;
}

async function fund(order) {
  await walletAction(sessions.buyer,'budget',order.id);
  await walletAction(sessions.buyer,'approve',order.id);
  await walletAction(sessions.buyer,'fund',order.id);
}

async function deliver(order,label) {
  const document=`# ${label}\n\nA practical public community introduction.\n\n## FAQ\n\n### What settles the bounty?\n\nThe test-only six-decimal dUSD token on the configured test network.\n\n### Is the document public?\n\nYes. The exact UTF-8 bytes are pinned to IPFS.\n\n### Who submits it?\n\nThe selected provider signs the submission.\n\n### Who accepts it?\n\nThe task's designated evaluator.\n\n### What happens at the deadline?\n\nFunded or submitted work can be refunded to the buyer if it has not completed.\n`;
  const delivery=(await sessions.provider.post(`/api/xlayer/mvp/orders/${order.id}/delivery`,{document})).delivery;
  assert.equal(delivery.stage,'ready');
  assert.match(delivery.uri,/^ipfs:\/\/b[a-z2-7]+$/);
  await walletAction(sessions.provider,'submit',order.id);
  return delivery;
}

assert.equal((await provider.getNetwork()).chainId,BigInt(chainId));
assert.equal(wallets.buyer.address.toLowerCase(),configuration.deployment.client.toLowerCase());
assert.equal(wallets.provider.address.toLowerCase(),configuration.deployment.provider.toLowerCase());
if(!local)assert.equal(wallets.evaluator.address.toLowerCase(),configuration.deployment.deployer.toLowerCase());
await Promise.all(Object.values(sessions).map(session=>session.login()));

const metadata=await sessions.provider.post('/api/xlayer/mvp/providers/metadata',{
  name:'Local FAQ Writer',introduction:'Team-controlled local verification provider for the public Community Introduction and FAQ template.',
});
const registration=await walletAction(sessions.provider,'register','',{metadataURI:metadata.metadataURI});
const registered=registration.receipt.events.find(event=>event.name==='Registered');
assert.ok(registered?.args.agentId!=null,'Agent registration event is missing');
const agentId=String(registered.args.agentId);
await sessions.provider.post('/api/xlayer/mvp/providers',{agentId,name:'Local FAQ Writer',
  introduction:'Team-controlled local verification provider for the public Community Introduction and FAQ template.',
  metadataURI:metadata.metadataURI,registrationTxHash:registration.receipt.hash});

const token=new Contract(configuration.deployment.token.address,['function balanceOf(address) view returns (uint256)'],provider);
const before={buyer:await token.balanceOf(wallets.buyer.address),provider:await token.balanceOf(wallets.provider.address)};
const base=Math.floor(Date.now()/1000);

const success=await createOrder('Successful settlement',base+7200);
await fund(success);
const successDelivery=await deliver(success,'Successful settlement delivery');
await walletAction(sessions.evaluator,'complete',success.id);

const rejected=await createOrder('Evaluator rejection',base+7200);
await fund(rejected);
await walletAction(sessions.evaluator,'reject',rejected.id);

let fundedExpiry=null,submittedExpiry=null;
if(local) {
  fundedExpiry=await createOrder('Funded expiry refund',base+3700);
  await fund(fundedExpiry);
  submittedExpiry=await createOrder('Submitted expiry refund',base+3700);
  await fund(submittedExpiry);
  await deliver(submittedExpiry,'Submitted expiry delivery');
  await provider.send('evm_setNextBlockTimestamp',[base+3701]);
  await provider.send('evm_mine',[]);
  await walletAction(sessions.buyer,'refund',fundedExpiry.id);
  await walletAction(sessions.buyer,'refund',submittedExpiry.id);
}

let after;
for(let attempt=0;attempt<30;attempt++) {
  // X Layer's public RPC may briefly serve balances from before an already
  // confirmed receipt. Wait for the three-account invariant; never rebroadcast.
  after={buyer:await token.balanceOf(wallets.buyer.address),provider:await token.balanceOf(wallets.provider.address),
    escrow:await token.balanceOf(configuration.deployment.escrow)};
  if(after.provider-before.provider===1_000_000n && before.buyer-after.buyer===1_000_000n && after.escrow===0n)break;
  await new Promise(resolve=>setTimeout(resolve,2000));
}
assert.equal(after.provider-before.provider,1_000_000n,'only the successful 1 dUSD bounty should reach the provider');
assert.equal(before.buyer-after.buyer,1_000_000n,'all rejected/expired bounties should return to the buyer');
assert.equal(after.escrow,0n,'escrow must not retain funds after all terminal outcomes');
const chain=await sessions.buyer.get('/api/xlayer/mvp/chain');
assert.ok(chain.events>0);

console.log(JSON.stringify({ok:true,network:configuration.network.name,chainId,agentId,
  orders:{success:success.id,rejected:rejected.id,fundedExpiry:fundedExpiry?.id || null,
  submittedExpiry:submittedExpiry?.id || null},delivery:{manifestCid:successDelivery.manifest_cid,
  fileCid:successDelivery.file_cid,carPath:successDelivery.car_path},balancesRaw:{before:{buyer:before.buyer.toString(),
  provider:before.provider.toString()},after:{buyer:after.buyer.toString(),provider:after.provider.toString(),
  escrow:after.escrow.toString()}},indexedEvents:chain.events},null,2));
provider.destroy();
