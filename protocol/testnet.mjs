import fs from 'node:fs';
import path from 'node:path';
import {Wallet, formatEther, parseEther} from 'ethers';
import {ROOT, networkConfig, provider, signer, artifact, confirmed, atomicJSON} from './chain.mjs';

export const TESTNET_ROLES = [
  {role:'deployer', key:'DEPLOYER_PRIVATE_KEY', purpose:'Deploy identity, demo token and escrow', gasBudget:8_000_000n},
  {role:'client', key:'BUYER_PRIVATE_KEY', purpose:'Register buyer, fund tasks and accept results', gasBudget:1_500_000n},
  {role:'provider', key:'AGENT_PROVIDER_PRIVATE_KEY', purpose:'Register provider and submit task results', gasBudget:1_000_000n},
  {role:'facilitator', key:'FACILITATOR_PRIVATE_KEY', purpose:'Settle x402 payments', gasBudget:500_000n},
];

// Only returns public addresses. Never overwrite an existing environment file.
export function initializeTestnet({root=ROOT, makeWallet=()=>Wallet.createRandom()}={}) {
  const file=path.join(root,'.env');
  if(fs.existsSync(file))throw new Error('.env already exists; existing accounts were preserved. Use preflight:testnet.');
  let content=fs.readFileSync(path.join(root,'.env.example'),'utf8');
  const accounts=[];
  for(const entry of TESTNET_ROLES) {
    const wallet=makeWallet();
    const field=new RegExp(`^${entry.key}=.*$`,'m');
    if(!field.test(content))throw new Error(`Template is missing ${entry.key}`);
    content=content.replace(field,`${entry.key}=${wallet.privateKey}`);
    accounts.push({role:entry.role,address:wallet.address,purpose:entry.purpose});
  }
  // A separate loopback service can coexist with the local-chain demo.
  content=content.replace(/^HIRE_NETWORK=.*$/m,'HIRE_NETWORK=xlayer-testnet').replace(/^PROTOCOL_PORT=.*$/m,'PROTOCOL_PORT=9403').replace(/^PORT=.*$/m,'PORT=8767');
  content+='\n# Testnet service listens locally until a hosting destination is configured.\nAPP_HOST=127.0.0.1\n';
  fs.writeFileSync(file,content,{flag:'wx',mode:0o600});
  return {network:'xlayer-testnet',chainId:1952,accounts,envFile:file};
}

export function inspectServiceURL(value) {
  if(!value)return {configured:false,public:false,issue:'HOLON_PUBLIC_URL is missing; needed before registering public service endpoints'};
  try {
    const url=new URL(value);
    const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(url.username || url.password || url.search || url.hash || !['http:','https:'].includes(url.protocol))throw new Error('invalid');
    if(url.pathname!=='/' && url.pathname!=='')throw new Error('invalid');
    return {configured:true,public:url.protocol==='https:' && !loopback,origin:url.origin,
      issue:loopback?'Local service URL: suitable for local testnet integration only':url.protocol!=='https:'?'Public service URL must use HTTPS':null};
  } catch {
    return {configured:false,public:false,issue:'HOLON_PUBLIC_URL must be an HTTP(S) origin without credentials, path, query or fragment'};
  }
}

export async function testnetPreflight({connect=provider,accountFor=signer,env=process.env,root=ROOT}={}) {
  const config=networkConfig();
  if(config.name!=='xlayer-testnet' || config.chainId!==1952)throw new Error('This command only supports X Layer testnet 1952');
  const report={network:config.name,chainId:config.chainId,readOnly:true,checkedAt:new Date().toISOString(),
    rpc:{reachable:false},accounts:[],contracts:{compiled:false},service:inspectServiceURL(env.HOLON_PUBLIC_URL),
    blockers:[],deploymentReady:false,publicConfigurationReady:false};
  try {
    for(const name of ['IdentityRegistryUpgradeable','ERC1967Proxy','DemoUSD','TaskEscrow'])artifact(name);
    report.contracts.compiled=true;
  }catch{report.blockers.push('Run npm run compile to generate contract artifacts')}
  report.contracts.deploymentRecorded=fs.existsSync(path.join(root,'contracts/deployments/xlayer-testnet.json'));
  if(fs.existsSync(path.join(root,'contracts/deployments/xlayer-testnet.progress.json')))report.blockers.push('An incomplete deployment is recorded; recover it before deploying again');
  if(env.PAYMENT_TOKEN_ADDRESS) {
    report.token={mode:'custom',compatibilityVerified:false};
    if(!env.PAYMENT_TOKEN_NAME || !env.PAYMENT_TOKEN_VERSION)report.blockers.push('Custom payment token requires EIP-712 name and version');
  } else report.token={mode:'deploy-demo-dUSD',decimals:6};
  let p;
  try {
    p=await connect();
    const chainId=Number(await p.send('eth_chainId',[]));
    if(chainId!==1952){report.blockers.push(`RPC chain mismatch: expected 1952, received ${chainId}`);return report}
    const [block,fees]=await Promise.all([p.getBlockNumber(),p.getFeeData()]);
    const price=fees.maxFeePerGas || fees.gasPrice;
    report.rpc={reachable:true,chainId,block,feePriceWei:price?.toString() || null};
    if(!price || price<=0n)report.blockers.push('RPC did not return a usable gas price');
    for(const entry of TESTNET_ROLES) {
      let wallet;
      if(!env[entry.key]){report.accounts.push({role:entry.role,status:'missing'});report.blockers.push(`${entry.key} is missing`);continue}
      try {wallet=accountFor(entry.role,p)}catch{report.accounts.push({role:entry.role,status:'invalid'});report.blockers.push(`${entry.key} is invalid`);continue}
      const balance=await p.getBalance(wallet.address);
      const suggested=price ? price*entry.gasBudget*2n : null;
      const funded=balance>0n && suggested!==null && balance>=suggested;
      report.accounts.push({role:entry.role,address:wallet.address,balanceOKB:formatEther(balance),
        suggestedOKB:suggested===null?null:formatEther(suggested),status:funded?'funded':'needs-test-OKB'});
      if(!funded)report.blockers.push(`${entry.role} needs test OKB for the planned transactions`);
    }
    const addresses=report.accounts.filter(a=>a.address).map(a=>a.address.toLowerCase());
    if(new Set(addresses).size!==addresses.length)report.blockers.push('Use separate accounts for deployer, buyer, provider and facilitator');
    report.deploymentReady=report.blockers.length===0;
    report.publicConfigurationReady=report.deploymentReady && report.service.public;
    report.fundingNote='Suggested balances use fixed transaction gas budgets and twice the current fee price. They are planning estimates, not guaranteed transaction fees.';
  }catch{
    // RPC errors can contain authenticated URLs; do not print provider error bodies.
    report.blockers.push('RPC check failed; check XLAYER_RPC_URL and network connectivity');
  }finally{p?.destroy()}
  return report;
}

// Explicit CLI action: top up the three dedicated test roles from the deployer.
export async function fundTestnetRoles({connect=provider,accountFor=signer,targetOKB='0.001',root=ROOT}={}) {
  if(networkConfig().name!=='xlayer-testnet')throw new Error('Funding helper is limited to X Layer testnet');
  const target=parseEther(targetOKB);
  if(target<=0n || target>parseEther('0.01'))throw new Error('Target must be greater than zero and at most 0.01 test OKB per role');
  const p=await connect();
  try {
    if(Number(await p.send('eth_chainId',[]))!==1952)throw new Error('Refusing to fund accounts on a different chain');
    const sender=accountFor('deployer',p),plans=[];
    const seen=new Set([sender.address.toLowerCase()]);
    for(const entry of TESTNET_ROLES.slice(1)) {
      const account=accountFor(entry.role,p);
      if(seen.has(account.address.toLowerCase()))throw new Error('Dedicated test accounts must be different');
      seen.add(account.address.toLowerCase());
      const balance=await p.getBalance(account.address);
      plans.push({role:entry.role,address:account.address,value:balance<target?target-balance:0n});
    }
    const feeData=await p.getFeeData();
    const price=feeData.maxFeePerGas || feeData.gasPrice;
    if(!price || price<=0n)throw new Error('Cannot determine gas price');
    const transfers=plans.filter(p=>p.value>0n);
    // Reserve deployment gas plus generous headroom for native transfers.
    const reserve=price*(8_000_000n+100_000n*BigInt(transfers.length))*2n;
    const total=transfers.reduce((n,p)=>n+p.value,0n);
    if(await p.getBalance(sender.address)<total+reserve)throw new Error(`Deployer needs at least ${formatEther(total+reserve)} test OKB for funding and deployment reserve`);
    const report={network:'xlayer-testnet',chainId:1952,targetOKB,from:sender.address,transfers:[]};
    for(const plan of transfers) {
      const tx=await sender.sendTransaction({to:plan.address,value:plan.value});
      const record={role:plan.role,to:plan.address,amountOKB:formatEther(plan.value),txHash:tx.hash,status:'pending'};
      report.transfers.push(record);atomicJSON(path.join(root,'data/testnet-funding.json'),report);
      const receipt=await confirmed(tx);record.status='confirmed';record.blockNumber=receipt.blockNumber;
      atomicJSON(path.join(root,'data/testnet-funding.json'),report);
    }
    return report;
  }finally{p.destroy()}
}
