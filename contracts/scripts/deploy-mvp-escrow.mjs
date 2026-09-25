import fs from 'node:fs';
import path from 'node:path';
import {ContractFactory,keccak256,randomBytes} from 'ethers';
import {ROOT,artifact,atomicJSON,confirmed,networkConfig,provider,signer} from '../../protocol/chain.mjs';

const conf=networkConfig();
if(!['xlayer-testnet','local'].includes(conf.name))throw new Error('MVP escrow deployment is restricted to X Layer Testnet or local development');
const baseFile=path.join(ROOT,'contracts/deployments',`${conf.name}.json`);
const outputName=process.env.MVP_DEPLOYMENT_MANIFEST || `${conf.name}-mvp.json`;
if(path.basename(outputName)!==outputName || !outputName.endsWith('.json'))throw new Error('Invalid MVP_DEPLOYMENT_MANIFEST');
const outputFile=path.join(ROOT,'contracts/deployments',outputName);
if(!fs.existsSync(baseFile))throw new Error(`Base deployment is missing: ${baseFile}`);
if(fs.existsSync(outputFile))throw new Error(`MVP deployment already exists: ${outputFile}`);
const base=JSON.parse(fs.readFileSync(baseFile));
if(base.network!==conf.name || base.chainId!==conf.chainId)throw new Error('Base deployment network mismatch');
if(base.token?.symbol!=='dUSD' || base.token?.decimals!==6 || base.token?.testToken!==true)throw new Error('Base deployment is not the test-only DemoUSD asset');

const rpc=await provider();
try {
  for(const value of [base.identityRegistry,base.token.address,base.escrow])if(await rpc.getCode(value)==='0x')throw new Error(`Base contract has no bytecode: ${value}`);
  const owner=signer('deployer',rpc);
  const compiled=artifact('TaskEscrow');
  const factory=new ContractFactory(compiled.abi,compiled.bytecode,owner);
  const instance=await factory.deploy(base.token.address,base.identityRegistry);
  const receipt=await confirmed(instance.deploymentTransaction());
  const escrow=await instance.getAddress();
  const chainCode=await rpc.getCode(escrow);
  if(chainCode==='0x')throw new Error('MVP escrow bytecode is not visible after deployment');
  const record={...base,deploymentId:`mvp-${Buffer.from(randomBytes(16)).toString('hex')}`,mvpVersion:1,
    escrow,legacyEscrows:[...(base.legacyEscrows || []),{address:base.escrow,deploymentId:base.deploymentId || 'legacy',
      deployedAt:base.deployedAt || null,deploymentBlock:(base.transactions || []).find(item=>item.step==='TaskEscrow')?.blockNumber || null}],
    transactions:[{step:'TaskEscrowMVP',address:escrow,hash:receipt.hash,blockNumber:receipt.blockNumber,
      blockHash:receipt.blockHash,bytecodeHash:keccak256(chainCode)}],deployedAt:new Date().toISOString()};
  atomicJSON(outputFile,record);
  console.log(JSON.stringify({ok:true,network:conf.name,manifest:outputName,escrow,transactionHash:receipt.hash,blockNumber:receipt.blockNumber},null,2));
} finally {rpc.destroy()}
