import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {handleMcp} from './mcp.mjs';

test('official MCP client initializes, discovers, reads scope and invokes the stateless tool', async () => {
  const invocations = [];
  const server = http.createServer(async (req,res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const input = parts.length ? JSON.parse(Buffer.concat(parts)) : undefined;
    await handleMcp(req,res,input,async args => {invocations.push(args);return {ok:true,verified:false,verificationStatus:'not_found'};});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({name:'verification-test',version:'1.0.0'});
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool=>tool.name),['verify_xlayer_delivery']);
    assert.equal(tools.tools[0].annotations.readOnlyHint,true);
    const resource = await client.readResource({uri:'holon://verification/capabilities'});
    assert.equal(JSON.parse(resource.contents[0].text).chainId,196);
    const args = {transactionHash:'0x'+'a'.repeat(64)};
    const result = await client.callTool({name:'verify_xlayer_delivery',arguments:args});
    assert.equal(result.structuredContent.verified,false);
    assert.deepEqual(invocations,[args]);
    const bad = await client.callTool({name:'verify_xlayer_delivery',arguments:{transactionHash:'bad'}});
    assert.equal(bad.isError,true); assert.equal(invocations.length,1);
    const get = await fetch(url); assert.equal(get.status,405);
  } finally {await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('MCP requires payment only for valid tool calls and forwards settlement proof',async()=>{
  let charges=0;
  const payments={call:async(args,signature,route)=>{
    assert.equal(route,'/mcp');
    if(!signature)return {status:402,headers:{'PAYMENT-REQUIRED':'test-challenge'},body:{x402Version:2}};
    charges++;return {status:200,headers:{'PAYMENT-RESPONSE':'test-proof'},body:{ok:true,status:'PASS'}};
  }};
  const server=http.createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);
    await handleMcp(req,res,parts.length?JSON.parse(Buffer.concat(parts)):undefined,undefined,payments);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  const input={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'verify_xlayer_delivery',arguments:{txHash:'0x'+'a'.repeat(64)}}};
  const post=(body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},body:JSON.stringify(body)});
  try {
    const challenge=await post(input);assert.equal(challenge.status,402);assert.equal(challenge.headers.get('payment-required'),'test-challenge');
    const bad=await post({...input,id:null},{'PAYMENT-SIGNATURE':'authorized'});assert.equal(bad.status,400);assert.equal(charges,0);
    const result=await post(input,{'PAYMENT-SIGNATURE':'authorized'});assert.equal(result.status,200);assert.equal(result.headers.get('payment-response'),'test-proof');
    assert.equal((await result.json()).result.structuredContent.status,'PASS');assert.equal(charges,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
