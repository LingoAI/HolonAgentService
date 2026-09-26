import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {OKXFacilitatorClient} from '@okxweb3/x402-core';
import {x402ResourceServer} from '@okxweb3/x402-core/server';
import {ExactEvmScheme} from '@okxweb3/x402-evm/exact/server';
import {decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader} from '@okxweb3/x402-core/http';
import {verificationInput} from './verification.mjs';
import {verifyAndExplain} from './verification-analysis.mjs';

const settings = JSON.parse(fs.readFileSync(new URL('../config/verification.json',import.meta.url)));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
const response = (status,body,headers={}) => ({status,body,headers});
const unavailable = () => response(503,{ok:false,error:'Official OKX payment service is not ready. No payment was requested.',code:'payment_not_ready'});
const waitBounded = async work => {
  let timer;
  try { return await Promise.race([work,new Promise((_,reject) => {timer=setTimeout(()=>reject(new Error('Facilitator timeout')),20000);})]); }
  finally {clearTimeout(timer);}
};

export function paymentConfiguration() {
  const configured = ['OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE'].every(key=>!!process.env[key]?.trim());
  return {configured,enabled:process.env.OKX_X402_ENABLED === '1',fee:settings.fee,currency:settings.currency,asset:settings.payment.asset,
    network:'eip155:196',payTo:settings.payment.payTo,facilitator:'OKX',protocol:'x402 v2'};
}

// One protocol process owns this journal on the persistent /app/data volume.
// Store no signatures or API credentials. Write before settlement, retain results
// for safe same-authorization replay, and never blindly repeat an uncertain settle.
export class VerificationPayments {
  constructor({facilitator,verify=verifyAndExplain,directory}={}) {
    this.facilitator = facilitator;
    this.verify = verify;
    this.directory = directory || process.env.OKX_X402_DATA_DIR || new URL('../data/verification-payments',import.meta.url).pathname;
    this.pending = new Map();
  }
  async initialize() {
    if (!this.facilitator && (!paymentConfiguration().configured || !paymentConfiguration().enabled)) return false;
    if (!this.initializing) this.initializing = (async () => {
      const client = this.facilitator || new OKXFacilitatorClient({apiKey:process.env.OKX_API_KEY,
        secretKey:process.env.OKX_SECRET_KEY,passphrase:process.env.OKX_PASSPHRASE,syncSettle:true});
      this.server = new x402ResourceServer(client).register('eip155:196',new ExactEvmScheme());
      await waitBounded(this.server.initialize());
      this.requirements = await this.server.buildPaymentRequirements({scheme:'exact',network:'eip155:196',
        payTo:settings.payment.payTo,maxTimeoutSeconds:300,
        price:{amount:settings.payment.amountRaw,asset:settings.payment.asset,extra:{name:'USD₮0',version:'1'}}});
      fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
      return true;
    })().catch(() => {this.initializing = null; return false;});
    return this.initializing;
  }
  async challenge(resourcePath,error) {
    const challenge = await this.server.createPaymentRequiredResponse(this.requirements,
      {url:settings.origin+resourcePath,description:settings.serviceName,mimeType:'application/json'},error);
    return response(402,challenge,{'PAYMENT-REQUIRED':encodePaymentRequiredHeader(challenge)});
  }
  async call(raw,signature,resourcePath='/verify') {
    const input = verificationInput.parse(raw); // Validate before requesting payment.
    if (!await this.initialize()) return unavailable();
    if (!signature) return this.challenge(resourcePath);
    let payload;
    try {
      if (typeof signature !== 'string' || signature.length > 16384) throw new Error();
      payload = decodePaymentSignatureHeader(signature);
      if (payload.x402Version !== 2 || !this.server.findMatchingRequirements(this.requirements,payload)) throw new Error();
      const auth = payload.payload?.authorization;
      if (!/^0x[0-9a-fA-F]{40}$/.test(auth?.from) || !/^0x[0-9a-fA-F]{64}$/.test(auth?.nonce) || typeof payload.payload.signature !== 'string') throw new Error();
      if (payload.resource?.url && payload.resource.url !== settings.origin+resourcePath) throw new Error();
    } catch {return this.challenge(resourcePath,'Invalid payment authorization or requirements');}
    const auth = payload.payload.authorization;
    const id = sha([settings.payment.asset.toLowerCase(),auth.from.toLowerCase(),auth.nonce.toLowerCase()].join(':'));
    const signatureHash = sha(canonical(payload.payload));
    const requestHash = sha(canonical({resourcePath,input}));
    const file = path.join(this.directory,id+'.json');
    const read = () => {try {return JSON.parse(fs.readFileSync(file,'utf8'));} catch(error) {if(error.code==='ENOENT') return null; throw error;}};
    const cached = () => {
      const record = read();
      if (!record) return null;
      if (record.signatureHash !== signatureHash || record.requestHash !== requestHash) return response(409,{ok:false,code:'payment_reuse',error:'This authorization is already bound to a different request.'});
      if (record.state === 'complete') return response(200,record.report,{'PAYMENT-RESPONSE':encodePaymentResponseHeader(record.settlement)});
      return response(503,{ok:false,code:'settlement_uncertain',paymentId:id,transaction:record.settlement?.transaction || null,
        error:'Settlement outcome is unresolved. Reuse this request after reconciliation; do not create another payment.'});
    };
    const prior = cached(); if (prior) return prior;
    if (this.pending.has(id)) {await this.pending.get(id);return cached() || response(409,{ok:false,error:'Retry the same authorization.'});}
    if (this.pending.size >= 8) return response(429,{ok:false,error:'Payment capacity reached; retry the same authorization.'});
    const run = async () => {
      let validity;
      try {validity = await waitBounded(this.server.verifyPayment(payload,this.requirements[0]));}
      catch {return unavailable();}
      if (!validity.isValid) return this.challenge(resourcePath,'Payment authorization was rejected');
      const report = await this.verify(input); // RPC/IPFS failures never trigger settlement.
      const record = {version:1,paymentId:id,signatureHash,requestHash,state:'settling',createdAt:new Date().toISOString(),report};
      const write = () => {
        const temporary = file+'.tmp';
        const fd = fs.openSync(temporary,'w',0o600);
        try {fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
        fs.renameSync(temporary,file);
        const dir = fs.openSync(this.directory,'r');try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
      };
      write();
      try {
        record.settlement = await waitBounded(this.server.settlePayment(payload,this.requirements[0]));
        // Trust the authenticated official facilitator's completed result.
        // Platform-managed review exemptions need not create an onchain tx.
        // Never grant an exemption based on a client-supplied wallet address.
        if (record.settlement.success === true && [undefined,'success'].includes(record.settlement.status) &&
            record.settlement.network === 'eip155:196') record.state = 'complete';
      } catch { /* Unknown outcome is durable; an operator can reconcile by payment ID. */ }
      write();
      return cached();
    };
    const work = run(); this.pending.set(id,work);
    try {return await work;} finally {this.pending.delete(id);}
  }
}
