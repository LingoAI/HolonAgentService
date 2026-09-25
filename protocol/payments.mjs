import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createPublicClient, createWalletClient, http, defineChain} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {x402Facilitator} from '@x402/core/facilitator';
import {x402Client} from '@x402/core/client';
import {ExactEvmScheme as FacilitatorScheme} from '@x402/evm/exact/facilitator';
import {ExactEvmScheme as ClientScheme} from '@x402/evm/exact/client';
import {toFacilitatorEvmSigner} from '@x402/evm';
import {decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentSignatureHeader, encodePaymentResponseHeader} from '@x402/core/http';
import {parseUnits, Interface} from 'ethers';
import {ROOT, networkConfig, manifest, provider, signer, checkedDeployment, artifact, atomicJSON, serviceResult, deploymentDirectory} from './chain.mjs';
import {logsInRange} from './logs.mjs';

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export function requirements(d) {
  const amount=parseUnits(process.env.X402_PRICE || '0.01',d.token.decimals);
  if(amount<=0n)throw new Error('X402_PRICE must be positive');
  return {scheme:'exact', network:`eip155:${d.chainId}`, amount:amount.toString(), asset:d.token.address, payTo:d.provider, maxTimeoutSeconds:120, extra:{name:d.token.name, version:d.token.version, assetTransferMethod:'eip3009'}};
}
export function assertRequirements(actual, expected) {
  for (const key of ['scheme','network','amount','asset','payTo','maxTimeoutSeconds']) {
    if (String(actual?.[key]).toLowerCase() !== String(expected[key]).toLowerCase()) throw new Error(`Payment requirement mismatch: ${key}`);
  }
  for (const key of ['name','version','assetTransferMethod']) if (actual?.extra?.[key] !== expected.extra[key]) throw new Error(`Payment domain mismatch: ${key}`);
}
export function paymentRequired(d, text) {
  const base = process.env.HOLON_PUBLIC_URL || 'http://127.0.0.1:8765';
  return {x402Version:2, error:'Payment required', resource:{url:`${base}/api/agent/research?request=${digest(text)}`,description:'Text analysis by the ERC-8004 registered provider',mimeType:'application/json'}, accepts:[requirements(d)]};
}
export class Payments {
  constructor() { this.facilitator=null; this.current=null; }
  async initialize() {
    if (this.facilitator) return;
    const p = await provider();
    let wallet;
    try {
      this.d = await checkedDeployment(p);
      // Browsing history does not require the settlement signing key.
      this.file=path.join(deploymentDirectory(this.d),'payments.json');
      this.journal=fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file)) : {};
      wallet = signer('facilitator',p);
    } finally {p.destroy()}
    const conf = networkConfig();
    this.providerAgent=this.d.agents.find(a=>a.role==='provider');
    if(!this.providerAgent)throw new Error('Register the provider Agent identity before enabling payments');
    const chain=defineChain({id:conf.chainId,name:conf.label,nativeCurrency:conf.nativeCurrency,rpcUrls:{default:{http:[conf.rpcUrl]}}});
    const account=privateKeyToAccount(wallet.privateKey);
    const publicClient=createPublicClient({chain,transport:http(conf.rpcUrl,{timeout:15000,retryCount:1}),pollingInterval:500});
    const walletClient=createWalletClient({account,chain,transport:http(conf.rpcUrl,{timeout:15000,retryCount:0})});
    this.publicClient=publicClient;
    const combined={address:account.address, readContract:args=>publicClient.readContract(args), verifyTypedData:args=>publicClient.verifyTypedData(args), getCode:args=>publicClient.getCode(args), sendTransaction:args=>walletClient.sendTransaction(args), waitForTransactionReceipt:args=>publicClient.waitForTransactionReceipt({...args,timeout:90000}), writeContract:async args=>{
      const hash=await walletClient.writeContract(args);
      // Persist broadcast before waiting. A restart must never charge this nonce twice.
      if (this.current) {this.journal[this.current].txHash=hash; this.save()}
      return hash;
    }};
    this.facilitator=new x402Facilitator().register(`eip155:${conf.chainId}`,new FacilitatorScheme(toFacilitatorEvmSigner(combined)));
  }
  save(){atomicJSON(this.file,this.journal)}
  async call(text, signature) {
    serviceResult({text}); // validate before offering or settling payment
    await this.initialize();
    const owner=await this.publicClient.readContract({address:this.d.identityRegistry,abi:artifact('IdentityRegistryUpgradeable').abi,functionName:'ownerOf',args:[BigInt(this.providerAgent.id)]});
    if(owner.toLowerCase()!==this.d.provider.toLowerCase())throw new Error('Provider identity owner changed; update the service deployment before accepting payments');
    const required=paymentRequired(this.d,text);
    const challenge=()=>({status:402,body:required,headers:{'PAYMENT-REQUIRED':encodePaymentRequiredHeader(required)}});
    if (!signature) return challenge();
    if (signature.length > 16384) throw new Error('Payment signature too large');
    let payload;
    try {payload=decodePaymentSignatureHeader(signature)} catch {throw new Error('Invalid PAYMENT-SIGNATURE header')}
    if (payload.x402Version !== 2) throw new Error('x402 v2 required');
    const expected=required.accepts[0];
    assertRequirements(payload.accepted,expected);
    if (payload.resource?.url !== required.resource.url) throw new Error('Payment resource does not match this request');
    const auth=payload.payload?.authorization;
    if (!auth || !/^0x[0-9a-f]{64}$/i.test(auth.nonce) || !/^0x[0-9a-f]{40}$/i.test(auth.from) || typeof payload.payload?.signature !== 'string') throw new Error('EIP-3009 authorization required');
    const key=digest(`${expected.network}:${expected.asset.toLowerCase()}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`);
    const requestHash=digest(text), signatureHash=digest(payload.payload.signature);
    const entry=this.journal[key];
    if (entry && (entry.requestHash !== requestHash || entry.signatureHash !== signatureHash)) throw new Error('Payment nonce was already bound to another request');
    if (entry?.response) return entry.response;
    if (entry && !entry.txHash && entry.blockNumber != null) {
      // Recover a broadcast whose RPC response was lost. Nonce use is on-chain evidence.
      const latest=Number(await this.publicClient.getBlockNumber({cacheTime:0}));
      const logs=await logsInRange((from,to)=>this.publicClient.getLogs({address:expected.asset,event:artifact('DemoUSD').abi.find(e=>e.type==='event' && e.name==='AuthorizationUsed'),args:{authorizer:auth.from,nonce:auth.nonce},fromBlock:BigInt(from),toBlock:BigInt(to)}),entry.blockNumber,latest);
      if(logs.length){entry.txHash=logs[0].transactionHash;this.save()}
    }
    if (entry?.txHash) {
      const receipt=await this.publicClient.waitForTransactionReceipt({hash:entry.txHash,timeout:90000});
      if (receipt.status !== 'success') {entry.failed=true;this.save();return {status:402,body:{error:'Settlement transaction reverted',txHash:entry.txHash}};}
      const token=new Interface(artifact('DemoUSD').abi);
      const events=receipt.logs.filter(l=>l.address.toLowerCase()===expected.asset.toLowerCase()).map(l=>{try{return token.parseLog(l)}catch{return null}});
      const used=events.some(e=>e?.name==='AuthorizationUsed' && e.args.authorizer.toLowerCase()===auth.from.toLowerCase() && e.args.nonce.toLowerCase()===auth.nonce.toLowerCase());
      const paid=events.some(e=>e?.name==='Transfer' && e.args.from.toLowerCase()===auth.from.toLowerCase() && e.args.to.toLowerCase()===expected.payTo.toLowerCase() && e.args.value===BigInt(expected.amount));
      if (!used || !paid) throw new Error('Settlement receipt does not match the authorization');
      return this.finish(key,text,{success:true,network:expected.network,payer:auth.from,transaction:entry.txHash});
    }
    const verified=await this.facilitator.verify(payload,expected);
    if (!verified.isValid) return {status:402,body:{...required,error:verified.invalidReason || 'Payment verification failed'},headers:{'PAYMENT-REQUIRED':encodePaymentRequiredHeader(required)}};
    this.journal[key]={requestHash,signatureHash,payer:auth.from,amount:expected.amount,createdAt:new Date().toISOString(),blockNumber:Number(await this.publicClient.getBlockNumber())}; this.save();
    this.current=key;
    try {
      const settled=await this.facilitator.settle(payload,expected);
      if (!settled.success) {
        const txHash=this.journal[key].txHash || settled.transaction;
        return {status:txHash ? 202 : 402,body:{error:settled.errorReason || 'Settlement failed',txHash:txHash || null,retrySamePayment:!!txHash}};
      }
      return this.finish(key,text,settled);
    } catch(error) {
      if(this.journal[key].txHash)return {status:202,body:{error:'Settlement broadcast; retry the same payment',txHash:this.journal[key].txHash,retrySamePayment:true}};
      throw error;
    } finally {this.current=null}
  }
  finish(key,text,settled) {
    const response={status:200,body:{ok:true,network:this.d.network,payment:{status:'settled',txHash:settled.transaction,payer:settled.payer,amount:this.journal[key].amount,token:this.d.token.symbol},agentId:this.d.agents.find(a=>a.role==='provider')?.id,result:serviceResult({text})},headers:{'PAYMENT-RESPONSE':encodePaymentResponseHeader(settled)}};
    this.journal[key]={...this.journal[key],txHash:settled.transaction,response}; this.save();
    return response;
  }
  history() {return Object.values(this.journal || {}).map(e=>({txHash:e.txHash,payer:e.payer,amount:e.amount,createdAt:e.createdAt,status:e.response ? 'settled':e.failed ? 'failed':'pending'})).reverse()}
}
export async function buyerCall(base,text,fetcher=fetch,{onSignature}={}) {
  const d=manifest(), expected=requirements(d);
  const url=`${base}/api/agent/research`;
  const send=headers=>fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',...(process.env.HOLON_TOKEN?{Authorization:`Bearer ${process.env.HOLON_TOKEN}`} : {}),...headers},body:JSON.stringify({text})});
  const first=await send({});
  const required=await first.json();
  if (first.status!==402) throw new Error(required.error || 'Seller did not return HTTP 402');
  assertRequirements(required.accepts?.[0],expected);
  const p=await provider();
  let wallet;
  try {wallet=signer('client',p)} finally {p.destroy()}
  const client=new x402Client().register(expected.network,new ClientScheme(privateKeyToAccount(wallet.privateKey)))
    .setSpendControls({allowedAssets:[{network:expected.network,asset:expected.asset,maxAmountPerPayment:expected.amount}]});
  const payload=await client.createPaymentPayload(required);
  const signature=encodePaymentSignatureHeader(payload);
  if (onSignature) await onSignature(signature);
  const paid=await send({'PAYMENT-SIGNATURE':signature});
  return {httpStatus:paid.status,body:await paid.json(),signature};
}
