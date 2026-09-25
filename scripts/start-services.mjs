import {spawn} from 'node:child_process';
import {ROOT} from '../protocol/chain.mjs';
const children=[];let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');setTimeout(()=>process.exit(code),500)}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
for(const [cmd,args] of [[process.execPath,['protocol/server.mjs']],[process.env.PYTHON_BIN || 'python',['-m','uvicorn','backend.main:app','--host',process.env.APP_HOST || '0.0.0.0','--port',process.env.PORT || '8765']]]) {
  const c=spawn(cmd,args,{cwd:ROOT,env:process.env,stdio:'inherit'});children.push(c);
  c.on('error',e=>{console.error(e.message);stop(1)});c.on('exit',code=>{if(!stopping)stop(code || 1)});
}
