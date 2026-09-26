import crypto from 'node:crypto';
import fs from 'node:fs';
import {Interface, keccak256, parseUnits} from 'ethers';
import {CID} from 'multiformats/cid';
import {z} from 'zod';

export const CHAIN_ID = 196;
export const EXPLORER = 'https://www.okx.com/web3/explorer/xlayer';
const deployment = JSON.parse(fs.readFileSync(new URL('../config/verification.json', import.meta.url)));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(v => BigInt(v) < 2n ** 256n, 'Must fit uint256');

export function rawCID(value) {
  try {
    if (!/^b[a-z2-7]{20,100}$/.test(value)) return null;
    const cid = CID.parse(value);
    return cid.version === 1 && cid.code === 0x55 && cid.multihash.code === 0x12 && cid.multihash.size === 32 ? cid : null;
  } catch { return null; }
}
const cid = z.string().refine(value => !!rawCID(value), 'Use a CIDv1 base32 raw block with SHA-256');
export const verificationInput = z.object({
  transactionHash: hash.optional().describe('X Layer mainnet transaction hash; use this or txHash.'),
  txHash: hash.optional().describe('Alias of transactionHash for the /verify API.'),
  contractAddress: address.optional().describe('Expected transaction recipient contract; arbitrary contract business state is not decoded.'),
  tokenAddress: address.optional(),
  expectedPayer: address.optional(),
  expectedPayee: address.optional(),
  expectedAmount: z.string().regex(/^(0|[1-9][0-9]{0,77})(\.[0-9]{1,18})?$/).optional()
    .describe('Decimal token amount. Requires tokenAddress, expectedPayer and expectedPayee; decimals are read onchain.'),
  expectedPayment: z.object({
    token: address.describe('ERC-20 contract address.'),
    sender: address.describe('Expected Transfer event sender, which can be an escrow.'),
    recipient: address.describe('Expected Transfer event recipient.'),
    amountRaw: uint.describe('Exact amount in base units, as a decimal integer string.'),
  }).strict().optional().describe('Optional exact ERC-20 Transfer event to match. No symbol or decimal inference.'),
  jobId: uint.refine(value => BigInt(value) > 0n, 'Job ID must be positive').optional()
    .describe('Optional job in the Holon mainnet canary escrow. The transaction must contain an event for this job.'),
  manifestCid: cid.optional().describe('Optional public Holon delivery manifest CID. Checks manifest bytes and its referenced document.'),
  expectedDigest: hash.optional().describe('Optional expected Keccak-256 digest of the manifest bytes; requires manifestCid.'),
  orderId: uint.refine(value => BigInt(value) > 0n).optional().describe('Alias of jobId, only for the Holon escrow.'),
  allowanceSpender: address.optional().describe('Requires tokenAddress and expectedPayer; queries both transaction-block and snapshot allowance.'),
  allowance: z.object({token:address, owner:address, spender:address}).strict().optional()
    .describe('Query ERC-20 allowance at transaction-block end and current snapshot; never infers an owner or spender.'),
}).strict().superRefine((v, ctx) => {
  const invalid = message => ctx.addIssue({code:'custom',message});
  if (!!v.transactionHash === !!v.txHash) invalid('Provide exactly one of transactionHash or txHash');
  if (v.jobId && v.orderId) invalid('Use jobId or orderId, not both');
  if (v.expectedDigest && !v.manifestCid) invalid('expectedDigest requires manifestCid');
  if (v.expectedAmount !== undefined && !(v.tokenAddress && v.expectedPayer && v.expectedPayee)) invalid('expectedAmount requires tokenAddress, expectedPayer and expectedPayee');
  if (v.expectedPayment && (v.expectedAmount !== undefined || v.expectedPayee)) invalid('Use expectedPayment or flat payment expectations');
  if (v.expectedPayee && v.expectedAmount === undefined) invalid('expectedPayee requires expectedAmount');
  if (v.allowanceSpender && !(v.tokenAddress && v.expectedPayer)) invalid('allowanceSpender requires tokenAddress and expectedPayer');
  if (v.allowance && v.allowanceSpender) invalid('Use allowance or allowanceSpender');
  if ((v.tokenAddress || v.expectedPayer) && v.expectedAmount === undefined && !v.allowanceSpender) invalid('tokenAddress and expectedPayer require expectedAmount or allowanceSpender');
});

const tokenABI = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)',
  'function allowance(address,address) view returns (uint256)', 'function decimals() view returns (uint8)']);
const escrowABI = new Interface([
  'function getJob(uint256) view returns (tuple(address client,address provider,address evaluator,uint256 budget,uint256 expiredAt,uint8 status,string description,bytes32 deliverable,uint256 agentId,bool hasAgent))',
  'event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,string description)',
  'event BudgetSet(uint256 indexed jobId,uint256 amount)',
  'event JobFunded(uint256 indexed jobId,address indexed client,uint256 amount)',
  'event JobSubmitted(uint256 indexed jobId,address indexed provider,bytes32 deliverable)',
  'event DeliveryURI(uint256 indexed jobId,bytes32 indexed deliverable,string uri)',
  'event JobCompleted(uint256 indexed jobId,address indexed evaluator,bytes32 reason)',
  'event JobRejected(uint256 indexed jobId,address indexed rejector,bytes32 reason)',
  'event JobExpired(uint256 indexed jobId)',
  'event PaymentReleased(uint256 indexed jobId,address indexed provider,uint256 amount)',
  'event Refunded(uint256 indexed jobId,address indexed client,uint256 amount)',
]);
const statuses = ['Open','Funded','Submitted','Completed','Rejected','Expired'];
const lower = value => String(value || '').toLowerCase();
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export class VerificationUnavailable extends Error {}
export class VerificationBusy extends Error {}

async function limitedResponse(response, maximum) {
  if (!response.ok) throw new VerificationUnavailable('Upstream request failed');
  if (Number(response.headers.get('content-length') || 0) > maximum) {
    await response.body?.cancel();
    throw new VerificationUnavailable('Upstream response exceeds the supported size');
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new VerificationUnavailable('Upstream response exceeds the supported size');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function rpcReader(signal) {
  let id = 0;
  const url = process.env.XLAYER_MAINNET_RPC_URL || (process.env.HIRE_NETWORK === 'xlayer-mainnet' && process.env.XLAYER_RPC_URL) || 'https://rpc.xlayer.tech';
  return async (method, params) => {
    try {
      const response = await fetch(url, {method:'POST', signal:AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0', id:++id, method, params})});
      const data = JSON.parse((await limitedResponse(response, 2 * 1024 * 1024)).toString());
      if (data.error || !Object.hasOwn(data, 'result')) throw new Error('RPC failed');
      return data.result;
    } catch { throw new VerificationUnavailable(`X Layer RPC unavailable for ${method}; retry the same request`); }
  };
}
async function fetchCID(value, maximum, signal) {
  // Only validated CIDs reach configured gateways. Request bodies cannot supply URLs.
  if (!rawCID(value)) throw new VerificationUnavailable('Unsupported delivery CID');
  const sources = [];
  if (process.env.MVP_IPFS_API) sources.push({url:`${process.env.MVP_IPFS_API.replace(/\/$/,'')}/api/v0/cat?arg=${value}`,
    method:'POST', headers:process.env.MVP_IPFS_API_TOKEN ? {Authorization:`Bearer ${process.env.MVP_IPFS_API_TOKEN}`} : {}});
  const gateways = (process.env.MVP_IPFS_GATEWAYS || 'https://gateway.pinata.cloud/ipfs/,https://ipfs.io/ipfs/').split(',');
  for (const gateway of gateways.slice(0,2)) sources.push({url:gateway.trim().replace(/\/$/,'') + '/' + value, method:'GET'});
  for (const source of sources) {
    try {
      return await limitedResponse(await fetch(source.url, {...source, redirect:'error',
        signal:AbortSignal.any([signal, AbortSignal.timeout(8000)])}), maximum);
    } catch { if (signal.aborted) break; }
  }
  throw new VerificationUnavailable('IPFS content unavailable or oversized; retry the same request');
}

export function verificationCapabilities() {
  return {name:deployment.serviceName, version:'1.1.0', serviceType:'A2MCP', fee:deployment.fee, currency:deployment.currency, chainId:CHAIN_ID,
    mcpEndpoint:'/mcp', httpEndpoint:'/verify', httpAlias:'/api/xlayer/verify-delivery', tool:'verify_xlayer_delivery',
    escrow:deployment.escrow, inputSchema:z.toJSONSchema(verificationInput),
    limits:{manifestBytes:8192, documentBytes:16384, concurrentRequests:8},
    scope:'Any X Layer mainnet receipt and exact ERC-20 Transfer events; optional Holon canary job and raw-CID delivery integrity. Observed confirmations do not guarantee finality. Integrity does not establish authorship or content quality.'};
}

let active = 0;
export async function verifyDelivery(raw, dependencies = {}) {
  const parsed = verificationInput.parse(raw);
  const input = {...parsed, transactionHash:parsed.transactionHash || parsed.txHash, jobId:parsed.jobId || parsed.orderId,
    allowance:parsed.allowance || (parsed.allowanceSpender ? {token:parsed.tokenAddress,owner:parsed.expectedPayer,spender:parsed.allowanceSpender} : undefined)};
  if (active >= 8) throw new VerificationBusy('Verification capacity reached; retry shortly');
  active++;
  try { return await inspect(input, dependencies); } finally { active--; }
}

async function inspect(input, dependencies) {
  const signal = AbortSignal.timeout(40000);
  const rpc = dependencies.rpc || rpcReader(signal);
  const readCID = dependencies.readCID || ((value, max) => fetchCID(value, max, signal));
  const chain = await rpc('eth_chainId', []);
  if (Number(BigInt(chain)) !== CHAIN_ID) throw new VerificationUnavailable('RPC returned the wrong chain');
  const [receipt, blockTag] = await Promise.all([
    rpc('eth_getTransactionReceipt', [input.transactionHash]), rpc('eth_blockNumber', []),
  ]);
  const checks = [];
  const check = (name, passed, expected, actual) => checks.push({name, passed, expected, actual});
  const result = {ok:true, schemaVersion:2, network:'X Layer Mainnet', chainId:CHAIN_ID, checkedAt:new Date().toISOString(),
    snapshotBlock:Number(BigInt(blockTag)), transactionHash:lower(input.transactionHash),
    explorerUrl:`${EXPLORER}/tx/${input.transactionHash}`, checks, warnings:[], userExpectations:input,
    scope:['Receipt inclusion and execution', ...(input.expectedPayment || input.expectedAmount !== undefined ? ['Exact ERC-20 Transfer event'] : []),
      ...(input.contractAddress ? ['Expected transaction recipient'] : []), ...(input.allowance ? ['Allowance at transaction-block end and snapshot block'] : []),
      ...(input.jobId ? ['Holon canary job state at snapshot block'] : []), ...(input.manifestCid ? ['Public delivery byte integrity'] : [])],
    limitations:['Confirmations are observations, not a finality guarantee.', 'Transfer logs do not prove the economic value of an arbitrary token.',
      'Delivery hashes do not establish content quality or authorship.']};
  check('receiptFound', !!receipt, true, !!receipt);
  if (!receipt) return report({...result, verified:false, verificationStatus:'not_found', transaction:null});
  const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  check('receiptHash', lower(receipt.transactionHash) === lower(input.transactionHash), lower(input.transactionHash), lower(receipt.transactionHash));
  check('executionSucceeded', receipt.status === '0x1', '0x1', receipt.status);
  check('canonicalBlock', !!block && lower(block.hash) === lower(receipt.blockHash), lower(receipt.blockHash), lower(block?.hash));
  const confirmations = result.snapshotBlock - Number(BigInt(receipt.blockNumber)) + 1;
  check('includedAtSnapshot', confirmations > 0, true, confirmations > 0);
  result.transaction = {from:receipt.from, to:receipt.to, blockNumber:Number(BigInt(receipt.blockNumber)),
    blockHash:receipt.blockHash, blockTimestamp:block?.timestamp ? Number(BigInt(block.timestamp)) : null,
    confirmations:Math.max(0, confirmations), status:receipt.status === '0x1' ? 'succeeded' : 'reverted'};
  if (input.contractAddress) check('expectedContract', lower(receipt.to) === lower(input.contractAddress), lower(input.contractAddress), lower(receipt.to));
  if (input.contractAddress && lower(input.contractAddress) !== lower(deployment.escrow)) result.warnings.push('Third-party contract: receipt and standard ERC-20 logs only; business state is not interpreted.');
  if (input.expectedAmount !== undefined) {
    let decimals;
    try {
      const data = await rpc('eth_call', [{to:input.tokenAddress,data:tokenABI.encodeFunctionData('decimals')},receipt.blockNumber]);
      [decimals] = tokenABI.decodeFunctionResult('decimals', data);
      input.expectedPayment = {token:input.tokenAddress,sender:input.expectedPayer,recipient:input.expectedPayee,
        amountRaw:parseUnits(input.expectedAmount,Number(decimals)).toString()};
      if (BigInt(input.expectedPayment.amountRaw) >= 2n ** 256n) throw new Error('Amount out of range');
    } catch { throw new VerificationUnavailable('Cannot resolve the expected amount using token decimals at the transaction block; use expectedPayment.amountRaw'); }
  }
  if (input.allowance) {
    const {token,owner,spender} = input.allowance;
    result.allowance = {token,owner,spender,observedAt:result.checkedAt,
      semantics:'State at the end of each block; later transactions in the same block may change the allowance.'};
    for (const [name,tag] of [['transactionBlock',receipt.blockNumber],['snapshot',blockTag]]) {
      try {
        const data = await rpc('eth_call',[{to:token,data:tokenABI.encodeFunctionData('allowance',[owner,spender])},tag]);
        const [value] = tokenABI.decodeFunctionResult('allowance',data);
        result.allowance[name] = {blockNumber:Number(BigInt(tag)),amountRaw:value.toString()};
      } catch { result.allowance[name] = {blockNumber:Number(BigInt(tag)),amountRaw:null};
        result.warnings.push(`Allowance at ${name} is unavailable; no zero allowance is inferred.`); }
    }
  }
  result.transfers = [];
  for (const log of receipt.logs || []) {
    try {
      // Excludes ERC-721 Transfer logs (four topics) and malformed ERC-20 logs.
      if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
      const event = tokenABI.parseLog(log);
      if (event) result.transfers.push({token:lower(log.address), sender:lower(event.args.from),
        recipient:lower(event.args.to), amountRaw:event.args.value.toString(), logIndex:log.logIndex});
    } catch { /* Unrelated receipt log. */ }
  }
  if (input.expectedPayment) {
    const expected = {...input.expectedPayment, token:lower(input.expectedPayment.token),
      sender:lower(input.expectedPayment.sender), recipient:lower(input.expectedPayment.recipient)};
    const matches = result.transfers.filter(row => Object.entries(expected).every(([key,value]) => row[key] === value));
    check('expectedPayment', matches.length > 0, expected, matches);
  }
  if (input.jobId) {
    const events = (receipt.logs || []).filter(log => lower(log.address) === lower(deployment.escrow))
      .map(log => {try {return escrowABI.parseLog(log);} catch {return null;}})
      .filter(event => event && event.args.jobId.toString() === input.jobId);
    check('transactionJob', events.length > 0, {escrow:deployment.escrow, jobId:input.jobId}, events.map(event => event.name));
    // Do not query an arbitrary/nonexistent job when this receipt has no binding.
    if (events.length) {
      let job;
      try {
        const encoded = await rpc('eth_call', [{to:deployment.escrow, data:escrowABI.encodeFunctionData('getJob',[input.jobId])}, blockTag]);
        [job] = escrowABI.decodeFunctionResult('getJob', encoded);
      } catch { throw new VerificationUnavailable('Cannot read the bound Holon escrow job at the snapshot block'); }
      result.job = {escrow:deployment.escrow, jobId:input.jobId, buyer:job.client, provider:job.provider,
        blockNumber:result.snapshotBlock,
        evaluator:job.evaluator, amountRaw:job.budget.toString(), status:statuses[Number(job.status)] || 'Unknown',
        expiredAt:job.expiredAt.toString(), deliverable:job.deliverable, agentId:job.hasAgent ? job.agentId.toString() : null};
    }
  }
  if (input.manifestCid) {
    if (!input.jobId) result.warnings.push('Delivery bytes are not bound to this transaction through a supported escrow job. An expected digest is a user claim, not an onchain anchor.');
    const bytes = await readCID(input.manifestCid, 8192);
    const digest = sha256(bytes), expected = Buffer.from(rawCID(input.manifestCid).multihash.digest).toString('hex');
    check('manifestCID', bytes.length <= 8192 && digest === expected, expected, digest);
    result.delivery = {manifestCid:input.manifestCid, manifestSha256:digest, manifestKeccak256:keccak256(bytes)};
    result.delivery.anchor = result.job ? {contract:deployment.escrow,method:'getJob(uint256)',argument:input.jobId,
      field:'deliverable',hashType:'Keccak-256 of exact manifest bytes',blockNumber:result.snapshotBlock,value:result.job.deliverable} : null;
    if (input.expectedDigest) check('expectedDigest', lower(input.expectedDigest) === lower(result.delivery.manifestKeccak256), lower(input.expectedDigest), result.delivery.manifestKeccak256);
    if (input.jobId) check('jobDeliveryDigest', !!result.job && lower(result.job.deliverable) === lower(result.delivery.manifestKeccak256), result.job?.deliverable || null, result.delivery.manifestKeccak256);
    let manifest;
    try {if (digest === expected && bytes.length <= 8192) manifest = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} catch { /* Report invalid manifest below. */ }
    const valid = !!manifest && typeof manifest === 'object' && !Array.isArray(manifest) && rawCID(manifest.fileCid) &&
      /^[0-9a-f]{64}$/.test(manifest.fileSha256) && Number.isInteger(manifest.fileSize) && manifest.fileSize > 0 && manifest.fileSize <= 16384;
    check('manifestFormat', !!valid, 'Holon manifest with fileCid, fileSha256 and fileSize (1–16384 bytes)', valid ? 'supported' : 'invalid');
    if (valid) {
      if (input.jobId) check('manifestJob', Number(manifest.chainId) === CHAIN_ID && lower(manifest.escrow) === lower(deployment.escrow) &&
        String(manifest.jobId) === input.jobId && lower(manifest.provider) === lower(result.job?.provider),
      {chainId:CHAIN_ID, escrow:deployment.escrow, jobId:input.jobId, provider:result.job?.provider || null},
      {chainId:manifest.chainId, escrow:manifest.escrow, jobId:manifest.jobId, provider:manifest.provider});
      if (input.jobId) check('manifestBudget', !!result.job && String(manifest.amountRaw) === result.job.amountRaw &&
        lower(manifest.token) === lower(deployment.escrowToken),
      {token:deployment.escrowToken,amountRaw:result.job?.amountRaw || null},
      {token:manifest.token || null,amountRaw:manifest.amountRaw || null});
      const document = await readCID(manifest.fileCid, 16384);
      const fileDigest = sha256(document);
      check('documentCID', fileDigest === Buffer.from(rawCID(manifest.fileCid).multihash.digest).toString('hex'), Buffer.from(rawCID(manifest.fileCid).multihash.digest).toString('hex'), fileDigest);
      check('documentHash', fileDigest === manifest.fileSha256, manifest.fileSha256, fileDigest);
      check('documentSize', document.length === manifest.fileSize && document.length <= 16384, manifest.fileSize, document.length);
      Object.assign(result.delivery, {fileCid:manifest.fileCid, fileSha256:fileDigest, fileSize:document.length});
    }
  }
  const verified = checks.every(item => item.passed);
  return report({...result, verified, verificationStatus:verified ? 'verified' : 'mismatch'});
}

function report(result) {
  result.status = !result.verified ? 'FAIL' : result.warnings.length ? 'WARNING' : 'PASS';
  result.mismatches = result.checks.filter(check => !check.passed);
  result.assetFlow = {transfers:result.transfers || [],source:'ERC-20 Transfer logs in the requested receipt'};
  result.escrowState = result.job || null;
  result.deliveryProof = result.delivery || null;
  result.onchainFacts = {transaction:result.transaction,assetFlow:result.assetFlow,escrowState:result.escrowState,allowance:result.allowance || null};
  result.interpretation = {method:'deterministic',summary:result.status === 'FAIL' ? 'One or more requested checks failed; inspect mismatches.' :
    result.status === 'WARNING' ? 'Available checks passed with incomplete verification scope; inspect warnings.' : 'All requested checks passed within the stated scope.',
    passedChecks:result.checks.filter(check => check.passed).map(check => check.name)};
  result.disclaimer = 'Read-only evidence verification. No private-key custody or fund operations. Not investment advice or a security audit.';
  result.markdown = [`# X Layer Proof Verifier — ${result.status}`,`Checked: ${result.checkedAt}; snapshot block: ${result.snapshotBlock}.`,
    `Transaction: ${result.explorerUrl}`, '## Onchain facts',
    `Execution: ${result.transaction?.status || 'Receipt not found'}. ERC-20 transfers: ${result.transfers?.length || 0}.`,
    `Escrow: ${result.job ? `${result.job.escrow}, job ${result.job.jobId}, ${result.job.status} at block ${result.job.blockNumber}` : 'Not verified'}.`,
    ...(result.allowance ? ['## Allowance', '```json\n'+JSON.stringify(result.allowance,null,2)+'\n```'] : []),
    ...(result.delivery ? ['## Delivery proof', '```json\n'+JSON.stringify(result.delivery,null,2)+'\n```'] : []),
    '## User expectations', '```json\n'+JSON.stringify(result.userExpectations,null,2)+'\n```',
    '## Comparison', ...result.checks.map(check => `- ${check.passed ? 'PASS' : 'FAIL'}: ${check.name}`),
    ...(result.mismatches.length ? ['```json\n'+JSON.stringify(result.mismatches,null,2)+'\n```'] : []),
    '## Interpretation',result.interpretation.summary, ...result.warnings.map(warning => `- ${warning}`),
    '## Limits',...result.limitations.map(limit => `- ${limit}`),result.disclaimer].join('\n\n');
  return result;
}
