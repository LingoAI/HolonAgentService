#!/usr/bin/env node

// Read-only checks against the *running* OKX A2A container. Run this before
// submitting the ASP for review; an installer check on the build machine does
// not prove the unprivileged runtime can see the Skill.

import {spawnSync} from 'node:child_process';

const host=process.env.OKX_A2A_SSH_HOST || 'lingoai-x-x-layer';
const container=process.env.OKX_A2A_CONTAINER || 'holon-okx-a2a-a2a-1';
const agentId='13847';
const serviceId='899f4f56-6041-48ea-8329-926c7ad0fac0';
const args=process.argv.slice(2);
const jobArg=args.find((arg)=>arg.startsWith('--job-id='));
const jobId=jobArg?.slice('--job-id='.length);
if (args.some((arg)=>arg!=='--ai-smoke' && arg!==jobArg)) {
  console.error('Usage: node scripts/verify-okx-asp-preflight.mjs [--ai-smoke] [--job-id=0x...]');
  process.exit(2);
}
if (!/^[a-zA-Z0-9._-]+$/.test(host) || !/^[a-zA-Z0-9._-]+$/.test(container) ||
    (jobId && !/^0x[0-9a-fA-F]{64}$/.test(jobId))) {
  console.error('Invalid SSH host, container, or job ID');
  process.exit(2);
}

const quote=(value)=>`'${String(value).replaceAll("'", "'\\''")}'`;
function remote(args,timeout=30000) {
  const command=['sudo','-n','/usr/local/bin/docker',...args].map(quote).join(' ');
  let result;
  for (let attempt=0;attempt<3;attempt++) {
    result=spawnSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8',host,command],{
      encoding:'utf8',timeout,maxBuffer:2_000_000,
    });
    if (result.status===0 || result.status!==255 || result.error) break;
  }
  if (result.error || result.status!==0) {
    throw new Error(result.error?.message || result.stderr.trim() || `SSH exit ${result.status}`);
  }
  return result.stdout.trim();
}
const exec=(...args)=>remote(['exec',container,...args]);
const json=(...args)=>JSON.parse(exec(...args));
const checks=[];
function check(name,fn) {
  try {
    const detail=fn();
    checks.push({name,pass:true,detail});
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    checks.push({name,pass:false,detail:error.message});
    console.error(`FAIL ${name} — ${error.message}`);
  }
}
function assert(condition,message) {
  if (!condition) throw new Error(message);
}
function atLeast(version,minimum) {
  const parts=version.replaceAll('"','').split('.').map(Number);
  const floor=minimum.split('.').map(Number);
  for (let i=0;i<3;i++) {
    if (parts[i]!==floor[i]) return parts[i]>floor[i];
  }
  return true;
}

check('running container',()=>{
  const state=remote(['inspect','--format','{{.State.Running}}',container]);
  assert(state==='true',`state=${state}`);
  return container;
});
check('Onchain OS CLI',()=>{
  const version=exec('onchainos','--version');
  assert(/^onchainos \d+\.\d+\.\d+$/.test(version),version);
  assert(atLeast(version.split(' ')[1],'4.6.2'),`CLI is older than 4.6.2: ${version}`);
  return version;
});
check('runtime OKX Skill and ASP instructions',()=>{
  const value=exec('sh','-c',
    'test -f /data/codex/skills/okx-ai/SKILL.md && test -f /data/a2a/workspace/AGENTS.md && ' +
    "sed -n 's/^  version: //p' /data/codex/skills/okx-ai/SKILL.md | head -1");
  assert(/^"?\d+\.\d+\.\d+"?$/.test(value),`Skill metadata=${value}`);
  assert(atLeast(value,'4.6.3'),`okx-ai Skill is older than 4.6.3: ${value}`);
  return `okx-ai ${value}`;
});
check('A2A daemon and AI provider',()=>{
  const output=exec('okx-a2a','doctor','--non-interactive');
  assert(/Summary: \d+ pass, 0 warn, 0 fail/.test(output),'doctor did not pass cleanly');
  assert(/A2A daemon: running/.test(output),'daemon is not running');
  return output.match(/Summary: [^\n]+/)?.[0];
});
check('official gate',()=>{
  const result=json('onchainos','agent','gate-check','--role','asp');
  assert(result.ok===true && result.data?.ready===true,'gate ready is not true');
  assert(String(result.data.identity?.agentId)===agentId,'unexpected ASP identity');
  return `ready=true agent=${agentId}`;
});
check('registered Agent online',()=>{
  const result=json('onchainos','agent','get-my-agents','--role','asp','--agent-ids',agentId);
  const agent=result.data?.list?.flatMap((account)=>account.agentList||[])
    .find((item)=>String(item.agentId)===agentId);
  assert(agent?.onlineStatus===1,'Agent is not online');
  return `agent=${agentId}, ${agent.approvalLabel || agent.statusLabel}`;
});
check('registered A2A service',()=>{
  const result=json('onchainos','agent','service-list','--agent-id',agentId);
  const service=result.data?.flatMap((page)=>page.list||[])
    .find((item)=>item.serviceId===serviceId);
  assert(service?.serviceType==='A2A','service missing or type changed');
  return `${service.serviceName} (${serviceId})`;
});

if (args.includes('--ai-smoke')) {
  check('Codex executes the official read-only task query',()=>{
    const prompt='Read AGENTS.md and /data/codex/skills/okx-ai/SKILL.md. ' +
      'Run onchainos agent active-tasks --role asp exactly once. ' +
      'Do not modify files or task state. Reply ASP_PREFLIGHT_OK only when the command succeeds.';
    const output=remote(['exec',container,'codex','exec','--json','--ephemeral',
      '--skip-git-repo-check','-C','/data/a2a/workspace',
      '--sandbox','danger-full-access','-c','approval_policy="never"',prompt],120000);
    const events=output.split('\n').filter(Boolean).map((line)=>JSON.parse(line));
    const items=events.filter((event)=>event.type==='item.completed').map((event)=>event.item);
    const query=items.find((item)=>item?.type==='command_execution' &&
      item.command?.includes('onchainos agent active-tasks --role asp') &&
      item.exit_code===0 && item.aggregated_output?.includes('"ok":true'));
    assert(query,'Codex did not execute a successful official task query');
    const answer=items.filter((item)=>item?.type==='agent_message').at(-1)?.text;
    assert(answer?.includes('ASP_PREFLIGHT_OK'),'Codex did not confirm successful task query');
    return 'Codex executed the official task query through the running container';
  });
}
if (jobId) {
  check('task status',()=>{
    const output=exec('onchainos','agent','status',jobId,'--agent-id',agentId);
    const status=output.match(/^Task status: (.+)$/m)?.[1];
    assert(status,'official task status unavailable');
    assert(/^(completed|complete|task completed)$/i.test(status),
      `self-test is not complete yet: ${status}`);
    return `${jobId}: ${status}`;
  });
}

const failed=checks.filter((item)=>!item.pass).length;
console.log(`${checks.length-failed}/${checks.length} preflight checks passed`);
console.log('Run a separate buyer task before review to prove notification, payment, delivery, and settlement.');
process.exitCode=failed ? 1 : 0;
