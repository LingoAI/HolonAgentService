import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Interface, Wallet} from 'ethers';

import {MAINNET_CANARY, initializeMainnetCanary, preflightMainnetCanary} from './mainnet-canary.mjs';
import {artifact,escrowArtifact,seedMainnetCanaryCache,transactionData} from './chain.mjs';
import {logScanStart} from './logs.mjs';

test('mainnet canary initialization creates dedicated secrets but returns public addresses only', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xlayer-mainnet-canary-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const wallets=Array.from({length:4},()=>Wallet.createRandom());let index=0;
  const result=initializeMainnetCanary({root,makeWallet:()=>wallets[index++]});
  const file=path.join(root,MAINNET_CANARY.envFile),contents=fs.readFileSync(file,'utf8');
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
  assert.equal(result.chainId,196);
  assert.equal(result.addresses.deployer,wallets[0].address);
  assert.equal(result.addresses.buyer,wallets[1].address);
  assert.equal(JSON.stringify(result).includes(wallets[0].privateKey),false);
  assert.match(contents,/MVP_MAINNET_CANARY=1/);
  assert.match(contents,/PAYMENT_TOKEN_ADDRESS=0xB6CEceAB302E2E4948951eE7843FC24E92933061/);
  assert.match(contents,/MVP_DEPLOYMENT_MANIFEST=xlayer-mainnet-native-usdc-canary.json/);
  assert.match(contents,/MAINNET_CANARY_MAX_BUDGET_RAW=1000000/);
  assert.throws(()=>initializeMainnetCanary({root}),/already exists/);
});

test('mainnet canary preflight fails closed before touching RPC when the explicit profile is absent', async()=>{
  let connected=false;
  const report=await preflightMainnetCanary({env:{},connect:async()=>{connected=true;throw new Error('must not connect')}});
  assert.equal(connected,false);
  assert.equal(report.deploymentReady,false);
  assert.match(report.blockers[0],/HIRE_NETWORK must be xlayer-mainnet/);
});

test('mainnet result seeds a verified event cursor without scanning 100,000 historical blocks', async()=>{
  const root=path.resolve(import.meta.dirname,'..');
  const d=JSON.parse(fs.readFileSync(path.join(root,'contracts/deployments/xlayer-mainnet-native-usdc-canary.json')));
  const proof=JSON.parse(fs.readFileSync(path.join(root,'docs/evidence/mainnet-native-usdc-proof-2026-09-22.json')));
  assert.equal(escrowArtifact(d),'MainnetCanaryEscrow');
  const tx=transactionData('fund',{jobId:proof.jobId,budgetRaw:proof.amountRaw},d);
  const canaryInterface=new Interface(artifact('MainnetCanaryEscrow').abi);
  assert.equal(canaryInterface.decodeFunctionData('fund',tx.data)[1],100000n);
  const eventNames={
    'create-agent-job':['JobCreated','AgentLinked'],
    'set-budget':['BudgetSet'],
    'fund-job':['JobFunded'],
    'submit-delivery':['JobSubmitted','DeliveryURI'],
    'complete-job':['PaymentReleased','JobCompleted'],
  };
  const rows=new Map(proof.transactions.map(row=>[row.hash,row]));
  const p={
    getTransactionReceipt:async hash=>{
      const row=rows.get(hash);
      return {status:1,hash,to:d.escrow,blockNumber:row.blockNumber,
        logs:eventNames[row.step].map((name,index)=>({eventName:name,address:d.escrow,
          index,blockNumber:row.blockNumber,blockHash:'0x'+'aa'.repeat(32)}))};
    },
    getBlock:async()=>({hash:'0x'+'bb'.repeat(32)}),
  };
  const escrow={jobCount:async()=>1n,interface:{parseLog:log=>({name:log.eventName,args:{jobId:1n}})}};
  const head=71394991;
  const seeded=await seedMainnetCanaryCache(p,d,escrow,head,71286957);
  assert.equal(seeded.transactions.length,8);
  assert.equal(seeded.toBlock,head);
  assert.equal(seeded.anchorNumber,head-100);
  assert.equal(await logScanStart(71286957,head,seeded,p.getBlock),head-99);
  escrow.jobCount=async()=>2n;
  assert.equal(await seedMainnetCanaryCache(p,d,escrow,head,71286957),null);
});
