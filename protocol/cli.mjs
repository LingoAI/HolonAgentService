import {deploy, registerAgents, readState, localAction, executeJob, manifest, transactionData, clientAction} from './chain.mjs';
import {buyerCall} from './payments.mjs';
const [command, ...rest] = process.argv.slice(2);
try {
  const args = rest[0] ? JSON.parse(rest[0]) : {};
  let result;
  if (command === 'deploy') result = await deploy();
  else if (command === 'resume-deploy') result = await deploy({resume:true});
  else if (command === 'register-agent') result = await registerAgents();
  else if (command === 'status') result = await readState();
  else if (command === 'execute-job') result = await executeJob(args.jobId);
  else if (command === 'prepare') result = transactionData(args.action,args,manifest());
  else if (command === 'client-action') result = await clientAction(args.action,args);
  else if (command === 'buyer-service') {
    const r = await buyerCall(process.env.HOLON_PUBLIC_URL || 'http://127.0.0.1:8765',args.text);
    if(r.httpStatus!==200)throw new Error(r.body.error || 'Payment did not settle');
    result=r.body;
  }
  else if (command === 'local-action') result = await localAction(args.action,args);
  else throw new Error('Commands: deploy, resume-deploy, register-agent, status, prepare, execute-job, client-action, buyer-service, local-action');
  console.log(JSON.stringify({ok:true,result},(_,v)=>typeof v === 'bigint' ? v.toString() : v));
} catch (error) { console.error(error.shortMessage || error.message); process.exitCode=1; }
