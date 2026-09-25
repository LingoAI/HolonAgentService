import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Wallet} from 'ethers';
import {ROOT, atomicJSON, deploymentDirectory} from '../protocol/chain.mjs';
import {inspectServiceURL} from '../protocol/testnet.mjs';

const origin=inspectServiceURL(process.argv[2]);
if(!origin.configured)throw new Error('Provide a service origin, for example http://43.98.161.223');
const d=JSON.parse(fs.readFileSync(path.join(ROOT,'contracts/deployments/xlayer-testnet.json')));
if(d.chainId!==1952 || d.network!=='xlayer-testnet')throw new Error('Release packaging is limited to the verified testnet deployment');
const keys=['AGENT_PROVIDER_PRIVATE_KEY','FACILITATOR_PRIVATE_KEY'];
for(const key of keys)if(!process.env[key])throw new Error(`${key} must be configured locally`);
if(new Wallet(process.env.AGENT_PROVIDER_PRIVATE_KEY).address.toLowerCase()!==d.provider.toLowerCase())throw new Error('Provider key does not match the deployed identity');

// Explicit application inputs: no root .env, data, SSH keys or private config.
const inputs=['Dockerfile','.dockerignore','package.json','package-lock.json','requirements.txt','requirements.lock',
  'backend','frontend','config','contracts/src','contracts/scripts','contracts/deployments/xlayer-testnet.json','protocol','scripts','deploy'];
const files=[];
function collect(relative) {
  const file=path.join(ROOT,relative), stat=fs.lstatSync(file), name=path.basename(file);
  if(stat.isSymbolicLink())throw new Error(`Release input cannot be a symlink: ${relative}`);
  if(['__pycache__','node_modules','.DS_Store','artifacts','cache'].includes(name) || name.endsWith('.pyc') || (name.startsWith('.env') && name!=='.env.example'))return;
  if(stat.isDirectory()){for(const child of fs.readdirSync(file).sort())collect(path.join(relative,child))}
  else if(stat.isFile())files.push(relative);
}
for(const input of inputs)collect(input);
const digest=crypto.createHash('sha256');
for(const file of files.sort())digest.update(file+'\0').update(fs.readFileSync(path.join(ROOT,file)));
const sourceHash=digest.digest('hex'), revision=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
const tag=`${revision}-${sourceHash.slice(0,12)}`;
const destination=path.join(ROOT,'data/releases',tag), app=path.join(destination,'app');
if(fs.existsSync(destination))throw new Error(`Release already exists: ${destination}`);
fs.mkdirSync(app,{recursive:true,mode:0o700});
for(const relative of files) {
  const target=path.join(app,relative); fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(path.join(ROOT,relative),target);
}
const values={HIRE_NETWORK:'xlayer-testnet', XLAYER_RPC_URL:process.env.XLAYER_RPC_URL || 'https://testrpc.xlayer.tech/terigon',
  HOLON_PUBLIC_URL:origin.origin, MARKETPLACE_DOMAIN:new URL(origin.origin).protocol==='https:'?new URL(origin.origin).host:origin.origin,
  HOLON_TAG:tag, HOLON_INDEX_ON_BOOT:'0', APP_HOST:'0.0.0.0', PORT:'8765', PROTOCOL_PORT:'9402',
  X402_PRICE:process.env.X402_PRICE || '0.01', HOLON_READONLY:'0', ANONYMIZED_TELEMETRY:'False',
  ...Object.fromEntries(keys.map(key=>[key,process.env[key]]))};
const env=Object.entries(values).map(([key,value])=>{
  if(/[\r\n'\0]/.test(value))throw new Error(`Unsupported characters in ${key}`);
  return `${key}='${value}'`;
}).join('\n')+'\n';
fs.writeFileSync(path.join(destination,'runtime.env'),env,{mode:0o600,flag:'wx'});
const tarEnv={...process.env,COPYFILE_DISABLE:'1'};
execFileSync('tar',['-czf',path.join(destination,'application.tar.gz'),'-C',app,'.'],{env:tarEnv});
const state=deploymentDirectory(d);
if(!fs.existsSync(state))throw new Error('Existing payment journal and job results are required for migration');
const stateRelative=path.relative(path.join(ROOT,'data'),state);
execFileSync('tar',['-czf',path.join(destination,'testnet-state.tar.gz'),'-C',path.join(ROOT,'data'),stateRelative],{env:tarEnv});
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(destination,file))).digest('hex');
const record={tag,revision,sourceHash,createdAt:new Date().toISOString(),serviceURL:origin.origin,chainId:1952,deploymentId:d.deploymentId,
  applicationSha256:sha('application.tar.gz'),stateSha256:sha('testnet-state.tar.gz'),runtimeKeyRoles:['provider','facilitator'],
  stateSnapshotNote:'Stop the old testnet signer service and refresh this snapshot immediately before migration.',files};
atomicJSON(path.join(destination,'release.json'),record);
console.log(JSON.stringify({tag,directory:destination,serviceURL:origin.origin,files:files.length,sourceHash,runtimeKeyRoles:record.runtimeKeyRoles},null,2));
