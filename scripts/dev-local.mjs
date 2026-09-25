import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {build} from 'esbuild';
import {ROOT,deploy,registerAgents} from '../protocol/chain.mjs';
process.env.HIRE_NETWORK='local';
process.env.XLAYER_RPC_URL='http://127.0.0.1:8545';
process.env.PROTOCOL_PORT='9402';
process.env.HOLON_INDEX_ON_BOOT='0';
process.env.ANONYMIZED_TELEMETRY='False';
process.env.HOLON_PUBLIC_URL='http://127.0.0.1:8765';
const children=[];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');setTimeout(()=>process.exit(code),500)}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>stop());
async function free(port){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(new Error(`Port ${port} is in use; stop the existing local stack first.`)));s.listen(port,'127.0.0.1',()=>s.close(resolve))})}
function run(cmd,args,log){
  const fd=fs.openSync(path.join(ROOT,'data',log),'a');
  const c=spawn(cmd,args,{cwd:ROOT,env:process.env,stdio:['ignore',fd,fd]});fs.closeSync(fd);children.push(c);
  c.on('error',e=>{console.error(e.message);stop(1)});c.on('exit',code=>{if(!stopping){console.error(`${cmd} stopped (${code}); see data/${log}`);stop(1)}});return c;
}
async function wait(url,options){for(let i=0;i<60;i++){try{const r=await fetch(url,options);if(r.ok)return}catch{}await new Promise(r=>setTimeout(r,500))}throw new Error(`Service did not start: ${url}`)}
async function command(args){await new Promise((resolve,reject)=>{const c=spawn(process.execPath,args,{cwd:ROOT,env:process.env,stdio:'inherit'});c.on('exit',code=>code===0?resolve():reject(new Error(`Command failed: ${args.join(' ')}`)));c.on('error',reject)})}
try{
  for(const port of [8545,8765,9402])await free(port);
  fs.mkdirSync(path.join(ROOT,'data'),{recursive:true});
  if(!fs.existsSync(path.join(ROOT,'.venv/bin/python')))throw new Error('Run scripts/setup-local.sh first.');
  await command(['contracts/scripts/compile.mjs']);
  await build({entryPoints:[path.join(ROOT,'protocol/wallet.mjs')],bundle:true,format:'esm',target:'es2022',outfile:path.join(ROOT,'frontend/vendor/x402-wallet.js')});
  run(process.execPath,['node_modules/hardhat/internal/cli/cli.js','node','--hostname','127.0.0.1'],'chain.log');
  await wait('http://127.0.0.1:8545',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'});
  await deploy();await registerAgents();
  run(process.execPath,['protocol/server.mjs'],'protocol.log');await wait('http://127.0.0.1:9402/health');
  run(path.join(ROOT,'.venv/bin/python'),['-m','uvicorn','backend.main:app','--host','127.0.0.1','--port','8765'],'app.log');
  await wait('http://127.0.0.1:8765/health');
  console.log('Local marketplace ready: http://127.0.0.1:8765/#marketplace\nRun npm run demo:local in another terminal. Ctrl-C stops all three services.');
}catch(e){console.error(e.message);stop(1)}
