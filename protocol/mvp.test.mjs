import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {artifact,transactionData} from './chain.mjs';

const d={chainId:1952,identityRegistry:'0x3333333333333333333333333333333333333333',
  escrow:'0x2222222222222222222222222222222222222222',
  token:{address:'0x1111111111111111111111111111111111111111',name:'Demo USD',version:'1',decimals:6}};

test('MVP prepares user registration and freezes evaluator on createAgentJob',()=>{
  const registry=new Interface(artifact('IdentityRegistryUpgradeable').abi);
  const reg=transactionData('register',{metadataURI:'ipfs://bafyprofile'},d);
  assert.equal(reg.to,d.identityRegistry);
  assert.deepEqual([...registry.decodeFunctionData('register(string)',reg.data)],['ipfs://bafyprofile']);

  const escrow=new Interface(artifact('TaskEscrow').abi);
  const evaluator='0x4444444444444444444444444444444444444444';
  const create=transactionData('create',{agentId:'7',evaluator,expiredAt:2_000_000_000,description:'frozen'},d);
  const decoded=escrow.decodeFunctionData('createAgentJob',create.data);
  assert.equal(decoded[0],7n);assert.equal(decoded[1].toLowerCase(),evaluator);assert.equal(decoded[2],2_000_000_000n);
});

test('MVP submission calldata binds exact manifest digest and CID URI',()=>{
  const escrow=new Interface(artifact('TaskEscrow').abi);
  const digest='0x'+'ab'.repeat(32), uri='ipfs://b'+'a'.repeat(58);
  const tx=transactionData('submit',{jobId:'42',deliverable:digest,uri},d);
  const decoded=escrow.decodeFunctionData('submitWithURI',tx.data);
  assert.equal(decoded[0],42n);assert.equal(decoded[1],digest);assert.equal(decoded[2],uri);
});

test('six-decimal budgets and exact expectedBudget remain integer calldata',()=>{
  const escrow=new Interface(artifact('TaskEscrow').abi);
  const budget=transactionData('budget',{jobId:'42',amount:'2.500001'},d);
  assert.equal(escrow.decodeFunctionData('setBudget',budget.data)[1],2_500_001n);
  assert.throws(()=>transactionData('budget',{jobId:'42',amount:'2.0000001'},d));
  const fund=transactionData('fund',{jobId:'42',budgetRaw:'2500001'},d);
  assert.equal(escrow.decodeFunctionData('fund',fund.data)[1],2_500_001n);
});
