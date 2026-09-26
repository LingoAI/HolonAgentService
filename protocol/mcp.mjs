import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {verificationInput, verificationCapabilities, verifyDelivery} from './verification.mjs';
import {SUPPORTED_PROTOCOL_VERSIONS} from '@modelcontextprotocol/sdk/types.js';

export function createMcpServer(verify = verifyDelivery) {
  const server = new McpServer({name:'holon-xlayer-verification', version:'1.0.0'}, {
    instructions:'X Layer mainnet evidence verification, 0.01 USDT per tool call via x402. Discovery is free. Inspect status, warnings and individual checks; successful HTTP does not establish successful verification. The verification itself performs no fund operations.'});
  server.registerTool('verify_xlayer_delivery', {
    title:'Verify X Layer transaction and delivery',
    description:verificationCapabilities().scope,
    inputSchema:verificationInput,
    annotations:{readOnlyHint:true, destructiveHint:false, idempotentHint:false, openWorldHint:true},
  }, async input => {
    try {
      const result = await verify(input);
      return {content:[{type:'text',text:JSON.stringify(result)}], structuredContent:result};
    } catch (error) {
      return {isError:true, content:[{type:'text', text:error.name === 'ZodError' ? 'Invalid verification parameters' : error.message}]};
    }
  });
  server.registerResource('verification-capabilities', 'holon://verification/capabilities',
    {title:'Verification scope and input schema', mimeType:'application/json'}, async uri => ({
      contents:[{uri:uri.href, mimeType:'application/json', text:JSON.stringify(verificationCapabilities())}],
    }));
  return server;
}

export async function handleMcp(req, res, input, verify, payments) {
  if (req.method !== 'POST') {
    res.writeHead(405, {'Content-Type':'application/json', Allow:'POST'});
    res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:'Use POST for stateless Streamable HTTP'}}));
    return;
  }
  if (payments && input?.method === 'tools/call') {
    const validEnvelope = input.jsonrpc === '2.0' && (typeof input.id === 'string' || (typeof input.id === 'number' && Number.isFinite(input.id))) &&
      input.params?.name === 'verify_xlayer_delivery' && verificationInput.safeParse(input.params.arguments).success;
    const accept = req.headers.accept || '';
    const version = req.headers['mcp-protocol-version'];
    if (!validEnvelope || !accept.includes('application/json') || !accept.includes('text/event-stream') ||
        (version && !SUPPORTED_PROTOCOL_VERSIONS.includes(version))) {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({jsonrpc:'2.0',id:input.id ?? null,error:{code:-32602,message:'Invalid tool request, Accept header or MCP protocol version; no payment attempted'}}));
      return;
    }
    const paid = await payments.call(input.params.arguments,req.headers['payment-signature'],'/mcp');
    if (paid.status !== 200) {
      res.writeHead(paid.status,{'Content-Type':'application/json','Cache-Control':'no-store',...paid.headers});
      res.end(JSON.stringify(paid.body)); return;
    }
    for (const [name,value] of Object.entries(paid.headers)) res.setHeader(name,value);
    verify = async () => paid.body;
  }
  const server = createMcpServer(verify);
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined, enableJsonResponse:true});
  res.once('close', () => {void transport.close(); void server.close();});
  await server.connect(transport);
  await transport.handleRequest(req, res, input);
}
