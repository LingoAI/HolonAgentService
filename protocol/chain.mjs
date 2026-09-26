import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { Contract, ContractFactory, HDNodeWallet, JsonRpcProvider, Wallet, Interface, ZeroAddress, ZeroHash, formatUnits, parseUnits, keccak256, toUtf8Bytes } from 'ethers';
import {visibleRead, deploymentRecords, verifyDeploymentRecord} from './deployment.mjs';
import {logsInRange, logScanStart} from './logs.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const NETWORKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/networks.json')));
export const STATES = ['Created', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];
export function networkConfig() {
  const name = process.env.HIRE_NETWORK || 'xlayer-testnet';
  if (!NETWORKS[name]) throw new Error(`Unsupported protocol network: ${name}`);
  const conf = {...NETWORKS[name], name};
  conf.rpcUrl = process.env.XLAYER_RPC_URL || conf.rpcUrl;
  if (name === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(conf.rpcUrl).hostname)) throw new Error('Local dev accounts require a loopback RPC');
  return conf;
}
export function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, `contracts/artifacts/${name}.json`)));
}
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2), {mode:0o600});
  fs.renameSync(temp, file);
}
export function manifestFile() {
  const name=process.env.MVP_DEPLOYMENT_MANIFEST || `${networkConfig().name}.json`;
  if(path.basename(name)!==name || !name.endsWith('.json'))throw new Error('Invalid deployment manifest name');
  return path.join(ROOT,'contracts/deployments',name);
}
export function manifest() {
  const conf = networkConfig();
  if (!fs.existsSync(manifestFile())) throw new Error(`No deployment for ${conf.name}; deploy the contracts first`);
  const d = JSON.parse(fs.readFileSync(manifestFile()));
  if (d.chainId !== conf.chainId || d.network !== conf.name) throw new Error('Deployment network mismatch');
  return d;
}
export async function provider() {
  const conf = networkConfig();
  const p = new JsonRpcProvider(conf.rpcUrl, undefined, {batchMaxCount:1, cacheTimeout:-1});
  p.pollingInterval = 250;
  const chainId = Number(await p.send('eth_chainId', []));
  if (chainId !== conf.chainId) { p.destroy(); throw new Error(`RPC chain mismatch: expected ${conf.chainId}, got ${chainId}`); }
  return p;
}
const ROLES = {deployer:0, client:1, provider:2, facilitator:3};
const KEY_ENVS = {deployer:'DEPLOYER_PRIVATE_KEY', client:'BUYER_PRIVATE_KEY', provider:'AGENT_PROVIDER_PRIVATE_KEY', facilitator:'FACILITATOR_PRIVATE_KEY'};
export function signer(role, p) {
  if (!(role in ROLES)) throw new Error('Unknown wallet role');
  if (networkConfig().name === 'local') {
    // Public Hardhat test mnemonic; NEVER used for a non-local network.
    return HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${ROLES[role]}`).connect(p);
  }
  const key = process.env[KEY_ENVS[role]];
  if (!key) throw new Error(`${KEY_ENVS[role]} is required`);
  return new Wallet(key, p);
}
export function chainContract(name, address, runner) { return new Contract(address, artifact(name).abi, runner); }
export function escrowArtifact(d) { return d.deploymentMode === 'mainnet-canary' ? 'MainnetCanaryEscrow' : 'TaskEscrow'; }
export async function confirmed(tx) {
  const receipt = await tx.wait(1, 120000);
  if (!receipt || receipt.status !== 1) throw new Error(`Transaction failed: ${tx.hash}`);
  return receipt;
}
export function deploymentDirectory(d) {
  return path.join(ROOT,'data/xlayer',d.network,d.escrow.toLowerCase(),d.deploymentId || 'legacy');
}
export async function checkedDeployment(p) {
  const d = manifest();
  for (const address of [d.identityRegistry, d.escrow, d.token.address]) {
    if (await p.getCode(address) === '0x') throw new Error('Deployment code missing; local chain may have restarted');
  }
  const escrow = chainContract(escrowArtifact(d),d.escrow,p);
  if ((await escrow.paymentToken()).toLowerCase() !== d.token.address.toLowerCase() || (await escrow.identityRegistry()).toLowerCase() !== d.identityRegistry.toLowerCase()) throw new Error('Deployment contract configuration mismatch');
  if (d.deploymentMode === 'mainnet-canary' &&
      ((await escrow.maxBudget()).toString() !== d.limits?.maxBudgetRaw ||
       (await escrow.maxTotalEscrowed()).toString() !== d.limits?.maxTotalEscrowRaw))
    throw new Error('Mainnet canary contract limits mismatch');
  if (Number(await chainContract('DemoUSD',d.token.address,p).decimals()) !== d.token.decimals) throw new Error('Payment token decimals mismatch');
  return d;
}
export async function deploy({resume = false} = {}) {
  const c = networkConfig();
  const p = await provider();
  try {
    if (fs.existsSync(manifestFile())) {
      const existing = manifest();
      if (await p.getCode(existing.escrow) !== '0x') throw new Error('Deployment already exists; use the existing manifest');
      if (c.name !== 'local') throw new Error('Existing deployment has no bytecode; investigate before redeploying');
    }
    const owner = signer('deployer', p), buyer = signer('client', p), seller = signer('provider', p);
    // Fail before spending gas when public configuration is incomplete.
    let tokenAddress = process.env.PAYMENT_TOKEN_ADDRESS;
    let tokenName = process.env.PAYMENT_TOKEN_NAME;
    let tokenVersion = process.env.PAYMENT_TOKEN_VERSION;
    if (!tokenAddress && !c.testnet) throw new Error('Mainnet requires an explicitly configured EIP-3009 payment token');
    if (tokenAddress) {
      if (!tokenName || !tokenVersion) throw new Error('Payment token EIP-712 name and version are required');
      if (await p.getCode(tokenAddress) === '0x') throw new Error('Payment token has no bytecode');
      const token = chainContract('DemoUSD',tokenAddress,p);
      await token.decimals(); await token.symbol();
    }
    const progressFile=manifestFile().replace('.json','.progress.json');
    const hasProgress = fs.existsSync(progressFile);
    if (resume && !hasProgress) throw new Error('No partial deployment to resume');
    if (!resume && c.name !== 'local' && hasProgress) throw new Error('Partial deployment recorded; run resume-deploy to verify and reuse its contracts');
    const steps = ['IdentityRegistryUpgradeable', 'ERC1967Proxy', ...(!tokenAddress ? ['DemoUSD'] : []), 'TaskEscrow'];
    const txs = resume ? deploymentRecords(JSON.parse(fs.readFileSync(progressFile)), c, steps) : [];
    const checkpoint = () => atomicJSON(progressFile,{network:c.name,chainId:c.chainId,transactions:txs});
    async function make(name, args) {
      const a = artifact(name);
      const factory = new ContractFactory(a.abi, a.bytecode, owner);
      const previous = txs.find(tx => tx.step === name);
      if (previous) {
        const expected = await factory.getDeployTransaction(...args);
        const receipt = await verifyDeploymentRecord(p, previous, owner.address, expected.data);
        if (previous.blockHash && previous.blockHash !== receipt.blockHash) previous.previousBlockHashes = [...(previous.previousBlockHashes || []), previous.blockHash];
        previous.blockNumber = receipt.blockNumber; previous.blockHash = receipt.blockHash; checkpoint();
        return new Contract(previous.address, a.abi, owner);
      }
      const instance = await factory.deploy(...args);
      const record={step:name,address:await instance.getAddress(),hash:instance.deploymentTransaction().hash};
      txs.push(record); checkpoint();
      const receipt = await confirmed(instance.deploymentTransaction());
      record.blockNumber=receipt.blockNumber; record.blockHash=receipt.blockHash;
      checkpoint();
      await visibleRead(() => p.getCode(record.address));
      return instance;
    }
    const implementation = await make('IdentityRegistryUpgradeable', []);
    const identity = await make('ERC1967Proxy', [await implementation.getAddress(), implementation.interface.encodeFunctionData('initialize')]);
    const registryAddress = await identity.getAddress();
    if (!tokenAddress) {
      if (!c.testnet) throw new Error('Mainnet requires an explicitly configured EIP-3009 payment token');
      tokenAddress = await (await make('DemoUSD', [buyer.address])).getAddress();
      tokenName = 'Demo USD'; tokenVersion = '1';
    }
    if (!tokenName || !tokenVersion) throw new Error('Payment token EIP-712 name and version are required');
    const token = chainContract('DemoUSD', tokenAddress, p);
    const decimals = Number(await visibleRead(() => token.decimals()));
    const symbol = await visibleRead(() => token.symbol());
    const escrow = await make('TaskEscrow', [tokenAddress, registryAddress]);
    const d = {deploymentId:randomUUID(), network:c.name, chainId:c.chainId, identityRegistry:registryAddress, identityImplementation:await implementation.getAddress(), escrow:await escrow.getAddress(), token:{address:tokenAddress, name:tokenName, version:tokenVersion, decimals, symbol, testToken:symbol === 'dUSD'}, deployer:owner.address, client:buyer.address, provider:seller.address, agents:[], transactions:txs, deployedAt:new Date().toISOString()};
    atomicJSON(manifestFile(), d);
    fs.unlinkSync(progressFile);
    return d;
  } finally { p.destroy(); }
}
export function serviceResult(input) {
  const text = String(input.text || '').trim();
  if (!text || text.length > 12000) throw new Error('text must contain 1–12000 characters');
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const stop = new Set(['the','and','a','an','to','of','in','on','is','for','with','that','it','as','be','are']);
  const frequency = new Map();
  for (const word of words) if (word.length > 2 && !stop.has(word)) frequency.set(word, (frequency.get(word) || 0) + 1);
  return {agent:'Text Analysis Agent', method:'deterministic text analysis', summary:text.split(/(?<=[.!?。！？])\s*/u).slice(0, 2).join(' ').slice(0, 600), wordCount:words.length, characters:[...text].length, keywords:[...frequency].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([word,count])=>({word,count}))};
}
export async function registerAgents() {
  const p = await provider();
  try {
    const d = await checkedDeployment(p);
    const base = process.env.HOLON_PUBLIC_URL || (d.network === 'local' ? 'http://127.0.0.1:8765' : '');
    if (!base) throw new Error('HOLON_PUBLIC_URL is required to register public service endpoints');
    for (const [role, name, slug] of [['client','Agent A · Service Buyer','buyer'],['provider','Text Analysis Agent','text-analysis']]) {
      if (d.agents.some(a=>a.slug === slug)) continue;
      const wallet = signer(role, p);
      const metadata = {type:'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name, description:role === 'provider' ? 'Extracts a summary, keyword frequencies and text statistics. Fixed deterministic skill; no external model required.' : 'Requests and pays for another agent’s text analysis service.', active:true, x402Support:role === 'provider', services:role === 'provider' ? [{name:'web',endpoint:`${base}/#marketplace`},{name:'x402',endpoint:`${base}/api/agent/research`}] : [{name:'web',endpoint:`${base}/#marketplace`}], supportedTrust:[]};
      const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`;
      const registry = chainContract('IdentityRegistryUpgradeable', d.identityRegistry, wallet);
      const receipt = await confirmed(await registry['register(string)'](uri));
      const event = receipt.logs.map(log=>{try{return registry.interface.parseLog(log)}catch{return null}}).find(e=>e?.name === 'Registered');
      if (!event) throw new Error('Missing Registered event');
      d.agents.push({id:event.args.agentId.toString(), agentId:event.args.agentId.toString(), erc8004AgentId:event.args.agentId.toString(), name, slug, role, owner:wallet.address, metadataURI:uri, serviceTypes:role === 'provider' ? ['x402','erc8183'] : [], serviceEndpoint:role === 'provider' ? '/api/agent/research' : null, txHash:receipt.hash});
      d.transactions.push({step:`register-${slug}`, hash:receipt.hash, blockNumber:receipt.blockNumber});
      atomicJSON(manifestFile(), d);
    }
    return d.agents;
  } finally {p.destroy()}
}
export function serializeJob(id, j, d) {
  return {id:String(id), client:j.client, provider:j.provider, evaluator:j.evaluator, budgetRaw:j.budget.toString(), reward:formatUnits(j.budget,d.token.decimals), expiredAt:Number(j.expiredAt), status:STATES[Number(j.status)], description:j.description, deliverable:j.deliverable, agentId:j.hasAgent ? j.agentId.toString() : null};
}
const CANARY_PROOF_STEPS = [
  ['create-agent-job',['JobCreated','AgentLinked']],
  ['set-budget',['BudgetSet']],
  ['fund-job',['JobFunded']],
  ['submit-delivery',['JobSubmitted','DeliveryURI']],
  ['complete-job',['PaymentReleased','JobCompleted']],
];
// The first public mainnet order was completed outside the web database. Verify
// every escrow receipt and use it to establish an initial event cursor. The
// public RPC limits eth_getLogs to 100 blocks; a full scan now exceeds the web
// request timeout. This shortcut is valid only while that order is the sole job.
export async function seedMainnetCanaryCache(p,d,escrow,blockNumber,first) {
  if (d.deploymentMode !== 'mainnet-canary' || d.chainId !== 196) return null;
  const proofFile=path.join(ROOT,'docs/evidence/mainnet-native-usdc-proof-2026-09-22.json');
  if (!fs.existsSync(proofFile)) return null;
  const proof=JSON.parse(fs.readFileSync(proofFile));
  if (proof.chainId !== d.chainId || proof.deploymentId !== d.deploymentId ||
      proof.deployment?.escrow?.toLowerCase() !== d.escrow.toLowerCase() ||
      proof.status !== 'Completed' || !/^\d+$/.test(String(proof.jobId)) ||
      Number(await escrow.jobCount({blockTag:blockNumber})) !== Number(proof.jobId)) return null;
  const recorded=new Map(proof.transactions.map(row=>[row.step,row]));
  const transactions=[];
  for (const [step,expected] of CANARY_PROOF_STEPS) {
    const row=recorded.get(step);
    if (!row || !/^0x[0-9a-f]{64}$/i.test(row.hash)) throw new Error(`Mainnet proof lacks ${step}`);
    const receipt=await p.getTransactionReceipt(row.hash);
    if (!receipt || receipt.status !== 1 || receipt.hash.toLowerCase() !== row.hash.toLowerCase() ||
        receipt.to?.toLowerCase() !== d.escrow.toLowerCase() || receipt.blockNumber !== row.blockNumber)
      throw new Error(`Mainnet ${step} receipt differs from the proof`);
    const names=new Set();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== d.escrow.toLowerCase()) continue;
      const event=escrow.interface.parseLog(log);
      if (!event?.args.jobId || event.args.jobId.toString() !== String(proof.jobId))
        throw new Error(`Mainnet ${step} event has the wrong job ID`);
      names.add(event.name);
      transactions.push({jobId:String(proof.jobId),step:event.name,hash:receipt.hash,
        logIndex:log.index,blockNumber:log.blockNumber,blockHash:log.blockHash});
    }
    if (expected.some(name=>!names.has(name))) throw new Error(`Mainnet ${step} is missing an escrow event`);
  }
  const anchorNumber=Math.max(first,blockNumber-100);
  const anchor=await p.getBlock(anchorNumber);
  if (!anchor?.hash) throw new Error('Mainnet event anchor is unavailable');
  return {toBlock:blockNumber,anchorNumber,anchorHash:anchor.hash,transactions};
}
export async function readState() {
  const p = await provider();
  try {
    const d = await checkedDeployment(p);
    const escrow = chainContract(escrowArtifact(d), d.escrow, p);
    const registry = chainContract('IdentityRegistryUpgradeable', d.identityRegistry, p);
    const count = Number(await escrow.jobCount());
    const jobs = [];
    for (let id = count; id > Math.max(0,count-100); id--) jobs.push(serializeJob(id, await escrow.getJob(id), d));
    const agents = [];
    for (const a of d.agents) agents.push({...a, owner:await registry.ownerOf(a.id), metadataURI:await registry.tokenURI(a.id)});
    const blockNumber=await p.getBlockNumber();
    const head=await p.getBlock(blockNumber);
    const first=d.transactions.find(t=>t.step==='MainnetCanaryEscrow' || t.step==='TaskEscrowMVP' || t.step==='TaskEscrow')?.blockNumber;
    if(!Number.isInteger(first))throw new Error('Escrow deployment block is missing from the manifest');
    const file=path.join(deploymentDirectory(d),'escrow-events.json');
    let cached;
    try {cached=JSON.parse(fs.readFileSync(file))} catch(error) {if(error.code!=='ENOENT' && !(error instanceof SyntaxError))throw error}
    if (!cached) cached=await seedMainnetCanaryCache(p,d,escrow,blockNumber,first);
    const from=await logScanStart(first,blockNumber,cached,n=>p.getBlock(n));
    const transactions=(cached?.transactions || []).filter(t=>t.blockNumber<from);
    const logs=await logsInRange((start,end)=>p.getLogs({address:d.escrow,fromBlock:start,toBlock:end}),from,blockNumber);
    for(const log of logs) {
      const e=escrow.interface.parseLog(log);
      if(e?.args.jobId!=null)transactions.push({jobId:e.args.jobId.toString(),step:e.name,hash:log.transactionHash,
        logIndex:log.index,blockNumber:log.blockNumber,blockHash:log.blockHash});
    }
    const anchorNumber=Math.max(first,blockNumber-100);
    const anchor=await p.getBlock(anchorNumber);
    if(anchor)atomicJSON(file,{toBlock:blockNumber,anchorNumber,anchorHash:anchor.hash,transactions});
    const legacyJobs=[];
    for(const legacy of d.legacyEscrows || []) {
      if(!legacy?.address || await p.getCode(legacy.address)==='0x')continue;
      const old=chainContract('TaskEscrow',legacy.address,p);
      const oldCount=Number(await old.jobCount());
      for(let id=oldCount;id>Math.max(0,oldCount-100);id--)legacyJobs.push({...serializeJob(id,await old.getJob(id),d),escrow:legacy.address,legacy:true});
    }
    return {deployment:d, agents, jobs, legacyJobs, jobCount:count, blockNumber,blockTimestamp:Number(head?.timestamp || 0),
      anchorNumber,anchorHash:anchor?.hash || null,transactions};
  } finally {p.destroy()}
}
export function transactionData(action, args, d) {
  const e = new Interface(artifact(escrowArtifact(d)).abi);
  const token = new Interface(artifact('DemoUSD').abi);
  const registry = new Interface(artifact('IdentityRegistryUpgradeable').abi);
  let data, to = d.escrow;
  switch (action) {
    case 'register': to=d.identityRegistry; data=registry.encodeFunctionData('register(string)',[args.metadataURI]); break;
    case 'create': data = e.encodeFunctionData('createAgentJob',[BigInt(args.agentId),args.evaluator,Number(args.expiredAt),args.description]); break;
    case 'budget': data = e.encodeFunctionData('setBudget',[BigInt(args.jobId),parseUnits(String(args.amount),d.token.decimals)]); break;
    case 'approve': to = d.token.address; data = token.encodeFunctionData('approve',[d.escrow,BigInt(args.budgetRaw)]); break;
    case 'fund': data = e.encodeFunctionData('fund',[BigInt(args.jobId),BigInt(args.budgetRaw)]); break;
    case 'submit': data = e.encodeFunctionData('submitWithURI',[BigInt(args.jobId),args.deliverable,args.uri]); break;
    case 'complete': data = e.encodeFunctionData('complete',[BigInt(args.jobId),args.reason || ZeroHash]); break;
    case 'reject': data = e.encodeFunctionData('reject',[BigInt(args.jobId),args.reason || ZeroHash]); break;
    case 'refund': data = e.encodeFunctionData('claimRefund',[BigInt(args.jobId)]); break;
    default: throw new Error('Unknown transaction action');
  }
  return {to, data, value:'0x0', chainId:`0x${d.chainId.toString(16)}`};
}
export async function registryOwner(agentId) {
  const p=await provider();
  try {
    const d=await checkedDeployment(p);
    const registry=chainContract('IdentityRegistryUpgradeable',d.identityRegistry,p);
    return {agentId:String(agentId),owner:await registry.ownerOf(BigInt(agentId)),metadataURI:await registry.tokenURI(BigInt(agentId))};
  } finally {p.destroy()}
}
export async function transactionReceipt(hash) {
  const p=await provider();
  try {
    const d=await checkedDeployment(p);
    const receipt=await p.getTransactionReceipt(hash);
    if(!receipt)return {hash,pending:true};
    const transaction=await p.getTransaction(hash);
    if(!transaction)throw new Error('Mined transaction details are unavailable');
    const interfaces=[
      {address:d.escrow.toLowerCase(),interface:new Interface(artifact(escrowArtifact(d)).abi)},
      {address:d.identityRegistry.toLowerCase(),interface:new Interface(artifact('IdentityRegistryUpgradeable').abi)},
      {address:d.token.address.toLowerCase(),interface:new Interface(artifact('DemoUSD').abi)},
    ];
    const events=[];
    for(const log of receipt.logs) {
      const item=interfaces.find(entry=>entry.address===log.address.toLowerCase());
      if(!item)continue;
      try {
        const parsed=item.interface.parseLog(log);
        const args={};
        parsed.fragment.inputs.forEach((input,index)=>{const value=parsed.args[index];args[input.name]=typeof value==='bigint'?value.toString():value});
        events.push({name:parsed.name,address:log.address,logIndex:log.index,args});
      } catch {}
    }
    return {hash,pending:false,status:Number(receipt.status),blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,events,
      from:receipt.from,to:receipt.to,data:transaction.data,value:transaction.value.toString(),nonce:transaction.nonce,
      logs:receipt.logs.map(log=>({address:log.address,topics:[...log.topics],data:log.data,index:log.index,transactionHash:log.transactionHash,blockNumber:log.blockNumber,blockHash:log.blockHash}))};
  } finally {p.destroy()}
}
export async function localAction(action, args) {
  if (networkConfig().name !== 'local') throw new Error('Local test actions are disabled on public networks');
  return clientAction(action,args);
}
export async function clientAction(action,args) {
  const p = await provider();
  try {
    const d = await checkedDeployment(p);
    const w = signer('client',p);
    const tx = transactionData(action,{...args,account:w.address,
      ...(action==='create' && !args.evaluator ? {evaluator:w.address} : {})},d);
    const receipt = await confirmed(await w.sendTransaction(tx));
    return {txHash:receipt.hash};
  } finally {p.destroy()}
}
export async function executeJob(id) {
  const p = await provider();
  try {
    const d = await checkedDeployment(p), w = signer('provider',p);
    const escrow = chainContract(escrowArtifact(d),d.escrow,w);
    const j = await escrow.getJob(BigInt(id));
    if (j.provider.toLowerCase() !== w.address.toLowerCase() || Number(j.status) !== 1) throw new Error('Job must be funded and assigned to this provider');
    const result = serviceResult({text:j.description});
    const doc = {jobId:String(id), chainId:d.chainId, escrow:d.escrow, provider:j.provider, result};
    const content = JSON.stringify(doc);
    const hash = keccak256(toUtf8Bytes(content));
    const file = path.join(deploymentDirectory(d),`job-${id}.json`);
    // Persist before broadcast; the document can always be recovered by its on-chain hash.
    atomicJSON(file,{content, hash, result});
    const receipt = await confirmed(await escrow.submit(BigInt(id),hash));
    return {txHash:receipt.hash, deliverable:hash, result};
  } finally {p.destroy()}
}
