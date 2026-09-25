import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {ROOT, atomicJSON} from '../protocol/chain.mjs';

const origin=new URL(process.argv[2] || '');
if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash)
  throw new Error('Provide a bare HTTPS origin, for example https://holonagentservice.lingoai.io');
const manifestName='xlayer-mainnet-native-usdc-canary.json';
const deployment=JSON.parse(fs.readFileSync(path.join(ROOT,'contracts/deployments',manifestName)));
if(deployment.chainId!==196 || deployment.network!=='xlayer-mainnet' || deployment.deploymentMode!=='mainnet-canary' ||
   deployment.escrowArtifact!=='MainnetCanaryEscrow' || deployment.limits?.maxBudgetRaw!=='1000000' ||
   deployment.limits?.maxTotalEscrowRaw!=='5000000')
  throw new Error('The verified capped X Layer mainnet canary manifest is required');

const inputs=['Dockerfile','.dockerignore','README.md',
  'package.json','package-lock.json','requirements.txt','requirements.lock','backend','frontend','config',
  'contracts/src','contracts/scripts/compile.mjs',`contracts/deployments/${manifestName}`,'protocol',
  'scripts/start-services.mjs','scripts/mvp-backup.py','scripts/restore-mvp-ipfs.py','deploy',
  'evidence/xlayer/mainnet-native-usdc-proof-2026-09-22.json'];
const files=[];
function collect(relative) {
  if(relative.startsWith('frontend/js/views/market') || /^frontend\/js\/views\/_(market|hire|quote|jobState)\.js$/.test(relative))return;
  const file=path.join(ROOT,relative),stat=fs.lstatSync(file),name=path.basename(file);
  if(stat.isSymbolicLink())throw new Error(`Release input cannot be a symlink: ${relative}`);
  if(['__pycache__','node_modules','.DS_Store','artifacts','cache','tests'].includes(name) ||
      name.endsWith('.pyc') || name.endsWith('.test.mjs') || name.startsWith('.env'))return;
  if(stat.isDirectory())for(const child of fs.readdirSync(file).sort())collect(path.join(relative,child));
  else if(stat.isFile())files.push(relative);
}
for(const input of inputs)collect(input);
const digest=crypto.createHash('sha256');
for(const file of files.sort())digest.update(file+'\0').update(fs.readFileSync(path.join(ROOT,file)));
const sourceHash=digest.digest('hex');
const revision=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
const tag=`mainnet-canary-${revision}-${sourceHash.slice(0,12)}`;
const destination=path.join(ROOT,'data/releases',tag),app=path.join(destination,'app');
if(fs.existsSync(destination))throw new Error(`Release already exists: ${destination}`);
fs.mkdirSync(app,{recursive:true,mode:0o700});
for(const relative of files) {
  const target=path.join(app,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(path.join(ROOT,relative),target);
}

const values={HIRE_NETWORK:'xlayer-mainnet',XLAYER_RPC_URL:process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech',
  MVP_MAINNET_CANARY:'1',HOLON_PUBLIC_URL:origin.origin,MVP_PUBLIC_ORIGIN:origin.origin,
  MVP_DEPLOYMENT_MANIFEST:manifestName,MVP_DATA_DIR:'/app/data/mvp-mainnet-canary',
  MVP_RETENTION_UNTIL:process.env.MVP_RETENTION_UNTIL || '2026-10-31',
  MVP_IPFS_GATEWAYS:process.env.MVP_IPFS_GATEWAYS || 'https://ipfs.io/ipfs/,https://dweb.link/ipfs/',
  PAYMENT_TOKEN_ADDRESS:deployment.token.address,PAYMENT_TOKEN_NAME:deployment.token.name,
  PAYMENT_TOKEN_VERSION:deployment.token.version,MARKETPLACE_DOMAIN:origin.host,HOLON_TAG:tag,
  HOLON_INDEX_ON_BOOT:'0',APP_HOST:'0.0.0.0',PORT:'8765',PROTOCOL_PORT:'9402',HOLON_READONLY:'0',
  ANONYMIZED_TELEMETRY:'False'};
const env=Object.entries(values).map(([key,value])=>{
  if(/[\r\n'\0]/.test(value))throw new Error(`Unsupported characters in ${key}`);
  return `${key}='${value}'`;
}).join('\n')+'\n';
fs.writeFileSync(path.join(destination,'runtime.env'),env,{mode:0o600,flag:'wx'});
const tarEnv={...process.env,COPYFILE_DISABLE:'1'};
execFileSync('tar',['-czf',path.join(destination,'application.tar.gz'),'-C',app,'.'],{env:tarEnv});
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(destination,file))).digest('hex');
const record={schemaVersion:1,tag,revision,sourceHash,createdAt:new Date().toISOString(),origin:origin.origin,
  chainId:196,deploymentMode:'mainnet-canary',escrow:deployment.escrow,manifest:manifestName,
  limits:deployment.limits,containsPrivateKeys:false,files:files.length,applicationSha256:sha('application.tar.gz')};
atomicJSON(path.join(destination,'release.json'),record);
console.log(JSON.stringify({ok:true,directory:destination,...record},null,2));
