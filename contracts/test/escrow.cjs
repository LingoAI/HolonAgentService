const assert = require('node:assert/strict');
const fs = require('node:fs');
const hre = require('hardhat');
const {BrowserProvider, ContractFactory, Contract, ZeroAddress, ZeroHash, keccak256, toUtf8Bytes, Wallet, Signature} = require('ethers');
const artifact = name => JSON.parse(fs.readFileSync(`contracts/artifacts/${name}.json`));
describe('ERC-8004 identity and ERC-8183 escrow', function () {
  let p, client, provider, attacker, token, identity, escrow, expiry;
  const amount = 1_000_000n;
  async function make(name,args) {
    const a = artifact(name), c = await new ContractFactory(a.abi,a.bytecode,client).deploy(...args);
    await c.waitForDeployment(); return c;
  }
  async function create(fund=true) {
    await (await escrow.createAgentJob(0,await client.getAddress(),expiry,'Analyze marketplace adoption.')).wait();
    const id = await escrow.jobCount();
    await (await escrow.setBudget(id,amount)).wait();
    if (fund) {
      await (await token.approve(await escrow.getAddress(),amount)).wait();
      await (await escrow.fund(id,amount)).wait();
    }
    return id;
  }
  beforeEach(async function () {
    await hre.network.provider.send('hardhat_reset');
    p = new BrowserProvider(hre.network.provider);
    p.pollingInterval=10;
    [client,provider,attacker] = await Promise.all([0,1,2].map(i=>p.getSigner(i)));
    token = await make('DemoUSD',[await client.getAddress()]);
    const impl = await make('IdentityRegistryUpgradeable',[]);
    const proxy = await make('ERC1967Proxy',[await impl.getAddress(),impl.interface.encodeFunctionData('initialize')]);
    identity = new Contract(await proxy.getAddress(),artifact('IdentityRegistryUpgradeable').abi,provider);
    await (await identity['register(string)']('data:application/json;base64,e30=')).wait();
    escrow = await make('TaskEscrow',[await token.getAddress(),await identity.getAddress()]);
    expiry=Number((await p.getBlock('latest')).timestamp)+3600;
  });
  it('registers identity #0, keeps ownership, rejects proxy reinitialization and unauthorized URI changes',async()=>{
    assert.equal(await identity.ownerOf(0),await provider.getAddress());
    assert.equal(await identity.getAgentWallet(0),await provider.getAddress());
    await assert.rejects(identity.initialize());
    await assert.rejects(identity.connect(attacker).setAgentURI(0,'evil'));
    await (await identity.setAgentURI(0,'data:application/json;base64,eyJuYW1lIjoiQSJ9')).wait();
  });
  it('escrows exactly the budget, links provider identity, and pays only on evaluator completion',async()=>{
    const id=await create(); const hash=keccak256(toUtf8Bytes('result'));
    assert.equal(await token.balanceOf(await escrow.getAddress()),amount);
    assert.equal((await escrow.getJob(id)).agentId,0n);
    await assert.rejects(escrow.complete(id,ZeroHash));
    await assert.rejects(escrow.connect(attacker).submit(id,hash));
    await (await escrow.connect(provider).submit(id,hash)).wait();
    await assert.rejects(escrow.connect(provider).complete(id,ZeroHash));
    await (await escrow.complete(id,hash)).wait();
    assert.equal(await token.balanceOf(await provider.getAddress()),amount);
    assert.equal(await token.balanceOf(await escrow.getAddress()),0n);
    assert.equal((await escrow.getJob(id)).status,3n);
    await assert.rejects(escrow.complete(id,hash));
    await assert.rejects(escrow.claimRefund(id));
  });
  it('allows assigning a provider once, rejects missing provider and stale budget',async()=>{
    await (await escrow.createJob(ZeroAddress,await client.getAddress(),expiry,'task')).wait();
    await (await escrow.setBudget(1,amount)).wait();
    await assert.rejects(escrow.fund(1,amount));
    await assert.rejects(escrow.connect(attacker).setAgentProvider(1,0));
    await (await escrow.setAgentProvider(1,0)).wait();
    await assert.rejects(escrow.setAgentProvider(1,0));
    await (await token.approve(await escrow.getAddress(),amount*2n)).wait();
    await (await escrow.connect(provider).setBudget(1,amount*2n)).wait();
    await assert.rejects(escrow.fund(1,amount));
    assert.equal(await token.balanceOf(await escrow.getAddress()),0n);
  });
  it('refunds rejected funded jobs and does not let an outsider reject',async()=>{
    const before=await token.balanceOf(await client.getAddress());
    const id=await create();
    await assert.rejects(escrow.connect(attacker).reject(id,ZeroHash));
    await (await escrow.reject(id,ZeroHash)).wait();
    assert.equal(await token.balanceOf(await client.getAddress()),before);
    await assert.rejects(escrow.connect(provider).submit(id,ZeroHash));
  });
  it('permissionless expiry refunds the client after submission; no double payout',async()=>{
    const id=await create();
    await (await escrow.connect(provider).submit(id,ZeroHash)).wait();
    await assert.rejects(escrow.claimRefund(id));
    await hre.network.provider.send('evm_setNextBlockTimestamp',[expiry]);
    await hre.network.provider.send('evm_mine');
    await assert.rejects(escrow.complete(id,ZeroHash));
    await (await escrow.connect(attacker).claimRefund(id)).wait();
    assert.equal((await escrow.getJob(id)).status,5n);
    assert.equal(await token.balanceOf(await escrow.getAddress()),0n);
  });
  it('submits a CIDv1 manifest URI, emits both events and preserves legacy submit',async()=>{
    let id=await create();
    const hash=keccak256(toUtf8Bytes('{"schemaVersion":1}'));
    const uri='ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3ptevgfmokd7g5w4fnh2kq';
    const receipt=await (await escrow.connect(provider).submitWithURI(id,hash,uri)).wait();
    const events=receipt.logs.map(log=>{try{return escrow.interface.parseLog(log)}catch{return null}}).filter(Boolean);
    assert.equal(events.some(e=>e.name==='JobSubmitted' && e.args.deliverable===hash),true);
    assert.equal(events.some(e=>e.name==='DeliveryURI' && e.args.uri===uri),true);
    assert.equal((await escrow.getJob(id)).status,2n);

    id=await create();
    await (await escrow.connect(provider).submit(id,ZeroHash)).wait();
    assert.equal((await escrow.getJob(id)).deliverable,ZeroHash);
  });
  it('rejects empty digests and malformed or oversized delivery URIs',async()=>{
    const hash=keccak256(toUtf8Bytes('manifest'));
    let id=await create();
    await assert.rejects(escrow.connect(provider).submitWithURI(id,ZeroHash,'ipfs://bafytest'));
    await assert.rejects(escrow.connect(provider).submitWithURI(id,hash,''));
    await assert.rejects(escrow.connect(provider).submitWithURI(id,hash,'https://example.com/file'));
    await assert.rejects(escrow.connect(provider).submitWithURI(id,hash,'ipfs://QmUppercase'));
    await assert.rejects(escrow.connect(provider).submitWithURI(id,hash,`ipfs://b${'a'.repeat(200)}`));
    await assert.rejects(escrow.connect(attacker).submitWithURI(id,hash,'ipfs://bafytest'));
  });
  it('rejects unknown jobs, zero evaluator, expired jobs and nonexistent agent identities',async()=>{
    await assert.rejects(escrow.getJob(0));
    await assert.rejects(escrow.createAgentJob(999,await client.getAddress(),expiry,'task'));
    await assert.rejects(escrow.createJob(ZeroAddress,ZeroAddress,expiry,'task'));
    await assert.rejects(escrow.createJob(ZeroAddress,await client.getAddress(),1,'task'));
    const id=await create(false);
    await hre.network.provider.send('evm_setNextBlockTimestamp',[expiry]);
    await hre.network.provider.send('evm_mine');
    await assert.rejects(escrow.fund(id,amount));
  });
  it('EIP-3009 verifies chain/domain/amount and consumes the nonce exactly once',async()=>{
    const w=Wallet.createRandom().connect(p);
    await (await token.transfer(w.address,amount)).wait();
    const domain={name:'Demo USD',version:'1',chainId:31337,verifyingContract:await token.getAddress()};
    const types={TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]};
    const message={from:w.address,to:await provider.getAddress(),value:amount,validAfter:0,validBefore:expiry,nonce:keccak256(toUtf8Bytes('payment'))};
    const sig=Signature.from(await w.signTypedData(domain,types,message));
    const call=value=>token.transferWithAuthorization(message.from,message.to,value,0,expiry,message.nonce,sig.v,sig.r,sig.s);
    await assert.rejects(call(amount+1n));
    await (await call(amount)).wait();
    assert.equal(await token.authorizationState(w.address,message.nonce),true);
    await assert.rejects(call(amount));
    assert.equal(await token.balanceOf(message.to),amount);
  });
});

describe('X Layer mainnet canary escrow limits', function () {
  let p, client, provider, token, identity, escrow, expiry;
  const oneUsdc = 1_000_000n;
  const aggregate = 2_000_000n;
  const artifactOf = name => JSON.parse(fs.readFileSync(`contracts/artifacts/${name}.json`));
  async function make(name,args,signer=client) {
    const a=artifactOf(name), instance=await new ContractFactory(a.abi,a.bytecode,signer).deploy(...args);
    await instance.waitForDeployment();return instance;
  }
  async function openAndFund(amount=oneUsdc) {
    await (await escrow.createAgentJob(0,await client.getAddress(),expiry,'Capped mainnet canary task.')).wait();
    const id=await escrow.jobCount();
    await (await escrow.setBudget(id,amount)).wait();
    await (await token.approve(await escrow.getAddress(),amount)).wait();
    await (await escrow.fund(id,amount)).wait();
    return id;
  }
  beforeEach(async function () {
    await hre.network.provider.send('hardhat_reset');
    p=new BrowserProvider(hre.network.provider);p.pollingInterval=10;
    [client,provider]=await Promise.all([0,1].map(index=>p.getSigner(index)));
    token=await make('DemoUSD',[await client.getAddress()]);
    const implementation=await make('IdentityRegistryUpgradeable',[]);
    const proxy=await make('ERC1967Proxy',[await implementation.getAddress(),implementation.interface.encodeFunctionData('initialize')]);
    identity=new Contract(await proxy.getAddress(),artifactOf('IdentityRegistryUpgradeable').abi,provider);
    await (await identity['register(string)']('ipfs://bafycanary')).wait();
    escrow=await make('MainnetCanaryEscrow',[await token.getAddress(),await identity.getAddress(),oneUsdc,aggregate]);
    expiry=Number((await p.getBlock('latest')).timestamp)+3600;
  });
  it('enforces immutable per-job and aggregate limits even when callers bypass the app',async()=>{
    assert.equal(await escrow.maxBudget(),oneUsdc);
    assert.equal(await escrow.maxTotalEscrowed(),aggregate);
    await (await escrow.createAgentJob(0,await client.getAddress(),expiry,'Too large.')).wait();
    await assert.rejects(escrow.setBudget(1,oneUsdc+1n));
    const first=await openAndFund();
    const second=await openAndFund();
    assert.equal(await escrow.totalEscrowed(),aggregate);
    await (await escrow.createAgentJob(0,await client.getAddress(),expiry,'Aggregate cap.')).wait();
    await (await escrow.setBudget(4,oneUsdc)).wait();
    await (await token.approve(await escrow.getAddress(),oneUsdc)).wait();
    await assert.rejects(escrow.fund(4,oneUsdc));
    await (await escrow.connect(provider).submit(first,ZeroHash)).wait();
    await (await escrow.complete(first,ZeroHash)).wait();
    assert.equal(await escrow.totalEscrowed(),oneUsdc);
    await (await escrow.createAgentJob(0,await client.getAddress(),expiry,'Capacity released.')).wait();
    await (await escrow.setBudget(5,oneUsdc)).wait();
    await (await token.approve(await escrow.getAddress(),oneUsdc)).wait();
    await (await escrow.fund(5,oneUsdc)).wait();
    assert.equal(await escrow.totalEscrowed(),aggregate);
    await (await escrow.reject(second,ZeroHash)).wait();
    assert.equal(await escrow.totalEscrowed(),oneUsdc);
  });
});
