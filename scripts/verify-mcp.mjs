import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {decodePaymentRequiredHeader} from '@okxweb3/x402-core/http';

// Public readiness check: never signs an authorization and never sends funds.
const settings=JSON.parse(fs.readFileSync(new URL('../config/verification.json',import.meta.url)));
const base=(process.argv[2] || settings.origin).replace(/\/$/,'');
const input={txHash:settings.exampleTransactionHash};
const info=await fetch(base+'/api/xlayer/verification').then(r=>r.json());
assert.equal(info.tool,settings.tool);assert.equal(info.fee,'0.01');
const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
const rest=await post('/verify',input),restBody=await rest.json();
if(info.payment.enabled && info.payment.configured){
  assert.equal(rest.status,402,JSON.stringify(restBody));
  const challenge=decodePaymentRequiredHeader(rest.headers.get('payment-required'));
  assert.equal(challenge.accepts[0].amount,'10000');assert.equal(challenge.accepts[0].network,'eip155:196');
  assert.equal(challenge.accepts[0].payTo.toLowerCase(),settings.payment.payTo);
}else{assert.equal(rest.status,503);assert.equal(restBody.code,'payment_not_ready');}
assert.equal((await post('/verify',{txHash:'invalid'})).status,400);
assert.equal((await post('/mcp',{}, {Origin:'https://untrusted.example'})).status,403);
const client=new Client({name:'holon-readiness-check',version:'1.1.0'});
try{
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
  const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name),[settings.tool]);
  const scope=await client.readResource({uri:'holon://verification/capabilities'});
  assert.equal(JSON.parse(scope.contents[0].text).chainId,196);
}finally{await client.close();}
const invocation=await post('/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:settings.tool,arguments:input}},
  {Accept:'application/json, text/event-stream'});
assert.equal(invocation.status,rest.status);
console.log(JSON.stringify({ok:true,checkedAt:new Date().toISOString(),origin:base,fee:settings.fee,
  paymentReady:rest.status===402,paidCallVerified:false,chainTransactionsSent:0,
  checks:['MCP initialization','tool discovery','capabilities resource','MCP and REST payment gate','invalid input','origin rejection']},null,2));
