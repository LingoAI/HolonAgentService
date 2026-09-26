import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {analysisSchema,analysisPrompt,validateAnalysis} from './analysis-contract.mjs';

const authSource='/run/codex-auth/auth.json';
const runtimeDirectory=process.env.CODEX_HOME;
const secret=process.env.VERIFICATION_AI_TOKEN;
if (!runtimeDirectory || !secret || secret.length<32) throw new Error('Private analysis configuration required');
fs.mkdirSync(runtimeDirectory,{recursive:true,mode:0o700});
const schemaFile='/tmp/holon-analysis-schema.json';
fs.writeFileSync(schemaFile,JSON.stringify(analysisSchema),{mode:0o600});
let active=false;
const respond=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
const disabled=['shell_tool','apps','plugins','browser_use','browser_use_external','computer_use','multi_agent',
  'code_mode','code_mode_host','goals','hooks','image_generation','in_app_browser','workspace_dependencies','view_image','sleep_tool','memories'];
async function infer(evidence) {
  // Only the existing AI login is mounted. Wallet state and payment API keys
  // are never mounted or passed to this container or model process.
  fs.copyFileSync(authSource,path.join(runtimeDirectory,'auth.json'));
  fs.chmodSync(path.join(runtimeDirectory,'auth.json'),0o600);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'holon-analysis-'));
  const output=path.join(directory,'result.json');
  const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only',
    '-C',directory,'--output-schema',schemaFile,'--output-last-message',output,'--json',
    '-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','model_reasoning_effort="low"',
    ...disabled.flatMap(feature=>['--disable',feature]),...(process.env.VERIFICATION_AI_MODEL?['--model',process.env.VERIFICATION_AI_MODEL]:[]),'-'];
  try {
    await new Promise((resolve,reject)=>{
      const child=spawn('codex',args,{stdio:['pipe','pipe','pipe'],detached:true,
        env:{PATH:process.env.PATH,CODEX_HOME:runtimeDirectory,LANG:'C.UTF-8'}});
      let bytes=0,events='';
      const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
      const timer=setTimeout(()=>{kill();reject(new Error('AI timeout'));},30000);
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144)kill();else events+=chunk.toString();});
      child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144)kill();});
      child.on('error',()=>{clearTimeout(timer);reject(new Error('AI process unavailable'));});
      child.on('close',code=>{clearTimeout(timer);
        // Refuse a result if a model attempted tool work despite disabled tools.
        const attemptedTool=events.split('\n').some(line=>{try{const e=JSON.parse(line);
          const disabledHostNotice=e.item?.type==='error' && e.item.message?.startsWith('Code Mode is unavailable because code-mode host is disabled.');
          return e.item && !['agent_message','reasoning'].includes(e.item.type) && !disabledHostNotice;
        }catch{return false;}});
        if(code===0 && !attemptedTool)resolve();else reject(new Error('AI inference failed'));});
      child.stdin.end(analysisPrompt(evidence));
    });
    if(fs.statSync(output).size>32768)throw new Error('Oversized AI output');
    return validateAnalysis(JSON.parse(fs.readFileSync(output,'utf8')),evidence);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
http.createServer(async(req,res)=>{
  if(req.url==='/health' && req.method==='GET')return respond(res,fs.existsSync(authSource)?200:503,{ok:fs.existsSync(authSource)});
  const got=Buffer.from(String(req.headers['x-analysis-token'] || '')),want=Buffer.from(secret);
  if(got.length!==want.length || !crypto.timingSafeEqual(got,want))return respond(res,401,{error:'Unauthorized'});
  if(req.url!=='/analyze' || req.method!=='POST')return respond(res,404,{error:'Not found'});
  if(active)return respond(res,429,{error:'Analysis busy'});
  try {
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>65536)return respond(res,413,{error:'Evidence too large'});chunks.push(chunk);}
    const evidence=JSON.parse(Buffer.concat(chunks).toString());
    if(!['PASS','WARNING','FAIL'].includes(evidence.status) || !Array.isArray(evidence.checks))return respond(res,400,{error:'Invalid evidence'});
    // Another request may have acquired the slot while this body was streaming.
    if(active)return respond(res,429,{error:'Analysis busy'});
    active=true;
    try {return respond(res,200,{analysis:await infer(evidence),model:process.env.VERIFICATION_AI_MODEL || 'runtime-default'});}
    finally {active=false;}
  } catch (error) {
    const known=['AI timeout','AI process unavailable','AI inference failed','Oversized AI output',
      'Invalid AI analysis','AI analysis references unknown evidence','AI omitted a failed check'];
    console.error('Analysis failed:',known.includes(error.message)?error.message:'Invalid input or runtime unavailable');
    respond(res,503,{error:'Analysis unavailable'});
  }
}).listen(9471,'0.0.0.0',()=>console.log('Private evidence analysis service ready'));
