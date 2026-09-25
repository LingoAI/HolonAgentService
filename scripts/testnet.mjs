import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../protocol/chain.mjs';
import {initializeTestnet,testnetPreflight,fundTestnetRoles} from '../protocol/testnet.mjs';

const command=process.argv[2];
try {
  if(command==='init') {
    if(process.env.HIRE_NETWORK && process.env.HIRE_NETWORK!=='xlayer-testnet')throw new Error('Unset HIRE_NETWORK or choose xlayer-testnet before initializing');
    console.log(JSON.stringify(initializeTestnet(),null,2));
  } else if(command==='preflight' || command==='fund') {
    if(fs.existsSync(path.join(ROOT,'.env')))process.loadEnvFile(path.join(ROOT,'.env'));
    const report=command==='fund' ? await fundTestnetRoles() : await testnetPreflight();
    console.log(JSON.stringify(report,null,2));
    if(command==='preflight' && !report.deploymentReady)process.exitCode=2;
  } else throw new Error('Commands: init, preflight, fund');
}catch(error){console.error(String(error.shortMessage || error.message).replaceAll(process.env.XLAYER_RPC_URL || "__unused_rpc__", "[configured RPC]"));process.exitCode=1}
