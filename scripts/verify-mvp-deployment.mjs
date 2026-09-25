import assert from 'node:assert/strict';
import {keccak256} from 'ethers';
import {chainContract,manifest,provider,readState} from '../protocol/chain.mjs';

if(process.env.HIRE_NETWORK!=='xlayer-testnet')throw new Error('Verification is X Layer Testnet-only');
if(!process.env.MVP_DEPLOYMENT_MANIFEST)throw new Error('MVP_DEPLOYMENT_MANIFEST is required');
const d=manifest();
assert.equal(d.chainId,1952);
assert.equal(d.mvpVersion,1);
assert.equal(d.token.symbol,'dUSD');
assert.equal(d.token.decimals,6);
assert.equal(d.token.testToken,true);
assert.ok(d.legacyEscrows?.some(item=>item.address.toLowerCase()!==d.escrow.toLowerCase()));
const deployment=d.transactions.find(item=>item.step==='TaskEscrowMVP');
assert.ok(deployment && deployment.address.toLowerCase()===d.escrow.toLowerCase());
const rpc=await provider();
try {
  const code=await rpc.getCode(d.escrow);
  assert.notEqual(code,'0x');
  assert.equal(keccak256(code),deployment.bytecodeHash);
  const receipt=await rpc.getTransactionReceipt(deployment.hash);
  assert.equal(receipt?.status,1);
  assert.equal(receipt?.blockNumber,deployment.blockNumber);
  assert.equal(receipt?.contractAddress?.toLowerCase(),d.escrow.toLowerCase());
  const escrow=chainContract('TaskEscrow',d.escrow,rpc);
  const token=chainContract('DemoUSD',d.token.address,rpc);
  assert.equal((await escrow.paymentToken()).toLowerCase(),d.token.address.toLowerCase());
  assert.equal((await escrow.identityRegistry()).toLowerCase(),d.identityRegistry.toLowerCase());
  await escrow.jobCount();
  assert.ok(escrow.interface.getFunction('submitWithURI'));
  assert.ok(escrow.interface.getEvent('DeliveryURI'));
  const roleAddresses=[d.client,d.provider,d.deployer].map(value=>value.toLowerCase());
  assert.equal(new Set(roleAddresses).size,3,'demo buyer, provider and evaluator/deployer addresses must be distinct');
  const balances={buyer:(await token.balanceOf(d.client)).toString(),provider:(await token.balanceOf(d.provider)).toString(),
    evaluator:(await token.balanceOf(d.deployer)).toString(),escrow:(await token.balanceOf(d.escrow)).toString()};
  assert.ok(BigInt(balances.buyer)>0n,'buyer needs DemoUSD for the bounty');
  const state=await readState();
  assert.equal(state.deployment.escrow.toLowerCase(),d.escrow.toLowerCase());
  assert.ok(state.legacyJobs.every(job=>job.legacy===true));
  console.log(JSON.stringify({ok:true,network:d.network,chainId:d.chainId,escrow:d.escrow,
    token:d.token.address,identityRegistry:d.identityRegistry,transactionHash:deployment.hash,
    blockNumber:deployment.blockNumber,bytecodeHash:deployment.bytecodeHash,
    legacyEscrows:d.legacyEscrows.map(item=>item.address),demoRoles:{buyer:d.client,provider:d.provider,evaluator:d.deployer},
    balancesRaw:balances,readModel:{jobCount:state.jobCount,legacyJobCount:state.legacyJobs.length,
      indexedEvents:state.transactions.length,blockNumber:state.blockNumber,anchorNumber:state.anchorNumber}},null,2));
} finally {rpc.destroy()}
