import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseEther} from 'ethers';
import {ROOT} from './chain.mjs';
import {TESTNET_ROLES,initializeTestnet,inspectServiceURL,testnetPreflight,fundTestnetRoles} from './testnet.mjs';
const addresses=Object.fromEntries(TESTNET_ROLES.map((r,i)=>[r.role,`0x${String(i+1).padStart(40,'0')}`]));
function env(){return Object.fromEntries(TESTNET_ROLES.map(r=>[r.key,'test-only-value']))}
function temporary(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'okx-testnet-'));fs.copyFileSync(path.join(ROOT,'.env.example'),path.join(root,'.env.example'));return root}
function rpc({chainId=1952,balance=parseEther('1')}={}){
  return {send:async()=>chainId,getBlockNumber:async()=>42,getFeeData:async()=>({gasPrice:40_000_000n}),getBalance:async()=>balance,destroy:()=>{}};
}
function account(role){return {address:addresses[role]}}
function isolatedPreflight(t,options){const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return testnetPreflight({root,...options})}
function profile(t,value='xlayer-testnet') {const previous=process.env.HIRE_NETWORK;process.env.HIRE_NETWORK=value;t.after(()=>{if(previous===undefined)delete process.env.HIRE_NETWORK;else process.env.HIRE_NETWORK=previous})}

test('testnet initialization keeps secrets out of output, uses 0600, and refuses to replace accounts',t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let count=0;const result=initializeTestnet({root,makeWallet:()=>({privateKey:`private-test-secret-${++count}`,address:addresses[TESTNET_ROLES[count-1].role]})});
  assert.equal(result.accounts.length,4);assert.equal(JSON.stringify(result).includes('private-test-secret'),false);
  const file=path.join(root,'.env'),before=fs.readFileSync(file,'utf8');
  assert.equal(fs.statSync(file).mode & 0o777,0o600);assert.match(before,/PORT=8767/);
  assert.throws(()=>initializeTestnet({root}),/already exists/);assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('service origin validation distinguishes local integration and public HTTPS without leaking credential URLs',()=>{
  assert.equal(inspectServiceURL('').configured,false);
  assert.equal(inspectServiceURL('http://127.0.0.1:8767').public,false);
  assert.equal(inspectServiceURL('https://demo.example.com').public,true);
  for(const url of ['https://user:secret@example.com','https://example.com/path','https://example.com/?token=secret','javascript:secret']) {
    const r=inspectServiceURL(url);assert.equal(r.configured,false);assert.equal(JSON.stringify(r).includes('secret'),false);
  }
});
test('preflight on a wrong chain reads no balances or signers and cannot send a transaction',async t=>{
  profile(t);const p=rpc({chainId:196});p.getBalance=()=>assert.fail('must not query balance on wrong chain');
  const r=await isolatedPreflight(t,{connect:async()=>p,accountFor:()=>assert.fail('must not access signer'),env:env()});
  assert.equal(r.deploymentReady,false);assert.match(r.blockers.join(' '),/chain mismatch/);
});
test('preflight reports public addresses and funding gaps without exposing keys',async t=>{
  profile(t);const r=await isolatedPreflight(t,{connect:async()=>rpc({balance:0n}),accountFor:account,env:env()});
  assert.equal(r.deploymentReady,false);assert.equal(r.accounts.length,4);assert.equal(r.accounts[0].suggestedOKB,'0.00064');
  assert.equal(JSON.stringify(r).includes('test-only-value'),false);
});
test('preflight separates funded deployment readiness from public service configuration',async t=>{
  profile(t);const r=await isolatedPreflight(t,{connect:async()=>rpc(),accountFor:account,env:env()});
  assert.equal(r.deploymentReady,true);assert.equal(r.publicConfigurationReady,false);
});
test('preflight redacts provider errors that could contain an authenticated RPC URL',async t=>{
  profile(t);const r=await isolatedPreflight(t,{connect:async()=>{throw new Error('https://rpc.example/private-secret')},env:env()});
  assert.equal(JSON.stringify(r).includes('private-secret'),false);assert.equal(r.deploymentReady,false);
});
test('testnet funding refuses a mainnet RPC before accessing signing accounts',async t=>{
  profile(t);await assert.rejects(fundTestnetRoles({connect:async()=>rpc({chainId:196}),accountFor:()=>assert.fail('no signer')}),/different chain/);
});
test('testnet funding tops up only deficits, keeps deployment reserve, and is repeatable',async t=>{
  profile(t);const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const p=rpc(),balances=new Map([[addresses.deployer,parseEther('0.01')],[addresses.client,parseEther('0.0002')],[addresses.provider,parseEther('0.001')],[addresses.facilitator,0n]]);
  p.getBalance=async address=>balances.get(address);const sent=[];
  const accountFor=role=>({...account(role),sendTransaction:async tx=>{
    assert.equal(role,'deployer');sent.push(tx);balances.set(tx.to,balances.get(tx.to)+tx.value);
    balances.set(addresses.deployer,balances.get(addresses.deployer)-tx.value);
    return {hash:`0x${String(sent.length).padStart(64,'0')}`,wait:async()=>({status:1,blockNumber:42})};
  }});
  const r=await fundTestnetRoles({connect:async()=>p,accountFor,root});
  assert.deepEqual(r.transfers.map(t=>t.role),['client','facilitator']);assert.equal(r.transfers[0].amountOKB,'0.0008');
  assert.equal((await fundTestnetRoles({connect:async()=>p,accountFor,root})).transfers.length,0);
});
test('insufficient test OKB prevents any funding transaction',async t=>{
  profile(t);const p=rpc({balance:0n});
  const accountFor=role=>({...account(role),sendTransaction:()=>assert.fail('must not send')});
  await assert.rejects(fundTestnetRoles({connect:async()=>p,accountFor}),/Deployer needs at least/);
});
