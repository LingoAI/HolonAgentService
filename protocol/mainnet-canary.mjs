import fs from 'node:fs';
import path from 'node:path';
import {
  Contract,
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Wallet,
  formatEther,
  getCreateAddress,
  keccak256,
  parseEther,
  randomBytes,
} from 'ethers';

import {ROOT, artifact, atomicJSON, confirmed} from './chain.mjs';
import {verifyDeploymentRecord, visibleRead} from './deployment.mjs';

export const MAINNET_CANARY = Object.freeze({
  network: 'xlayer-mainnet',
  chainId: 196,
  rpcUrl: 'https://rpc.xlayer.tech',
  manifest: 'xlayer-mainnet-native-usdc-canary.json',
  envFile: '.env.mainnet-canary',
  canaryVersion: 2,
  token: Object.freeze({
    address: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
    name: 'USDC',
    symbol: 'USDC',
    decimals: 6,
    version: '2',
  }),
  maxBudgetRaw: 1_000_000n,
  maxTotalEscrowRaw: 5_000_000n,
});

const TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
];
const REQUIRED_KEYS = ['DEPLOYER_PRIVATE_KEY', 'BUYER_PRIVATE_KEY', 'AGENT_PROVIDER_PRIVATE_KEY', 'FACILITATOR_PRIVATE_KEY'];

function requireCanaryEnvironment(env = process.env) {
  if (env.HIRE_NETWORK !== MAINNET_CANARY.network) throw new Error('HIRE_NETWORK must be xlayer-mainnet');
  if (env.MVP_MAINNET_CANARY !== '1') throw new Error('MVP_MAINNET_CANARY=1 is required for every mainnet canary command');
  if ((env.MVP_DEPLOYMENT_MANIFEST || MAINNET_CANARY.manifest) !== MAINNET_CANARY.manifest)
    throw new Error(`MVP_DEPLOYMENT_MANIFEST must be ${MAINNET_CANARY.manifest}`);
  const expected = MAINNET_CANARY.token;
  if ((env.PAYMENT_TOKEN_ADDRESS || '').toLowerCase() !== expected.address.toLowerCase() ||
      env.PAYMENT_TOKEN_NAME !== expected.name || env.PAYMENT_TOKEN_VERSION !== expected.version)
    throw new Error('Mainnet canary payment-token configuration does not match the reviewed X Layer USDC profile');
}

function envPath(root = ROOT) {
  return path.join(root, MAINNET_CANARY.envFile);
}

function manifestPath(root = ROOT) {
  return path.join(root, 'contracts/deployments', MAINNET_CANARY.manifest);
}

function progressPath(root = ROOT) {
  return manifestPath(root).replace(/\.json$/, '.progress.json');
}

function publicRoles(env = process.env) {
  const roles = {};
  for (const key of REQUIRED_KEYS) {
    const role = key.replace(/_PRIVATE_KEY$/, '').toLowerCase();
    try { roles[role] = new Wallet(env[key]).address; }
    catch { roles[role] = null; }
  }
  return roles;
}

export function initializeMainnetCanary({root = ROOT, makeWallet = () => Wallet.createRandom()} = {}) {
  const file = envPath(root);
  if (fs.existsSync(file)) throw new Error(`${MAINNET_CANARY.envFile} already exists; existing mainnet keys were preserved`);
  const wallets = Object.fromEntries(REQUIRED_KEYS.map(key => [key, makeWallet()]));
  const lines = [
    '# Dedicated X Layer mainnet canary profile. Never copy testnet or production keys here.',
    `HIRE_NETWORK=${MAINNET_CANARY.network}`,
    `XLAYER_RPC_URL=${MAINNET_CANARY.rpcUrl}`,
    'MVP_MAINNET_CANARY=1',
    `MVP_DEPLOYMENT_MANIFEST=${MAINNET_CANARY.manifest}`,
    `PAYMENT_TOKEN_ADDRESS=${MAINNET_CANARY.token.address}`,
    `PAYMENT_TOKEN_NAME=${MAINNET_CANARY.token.name}`,
    `PAYMENT_TOKEN_VERSION=${MAINNET_CANARY.token.version}`,
    `MAINNET_CANARY_MAX_BUDGET_RAW=${MAINNET_CANARY.maxBudgetRaw}`,
    `MAINNET_CANARY_MAX_TOTAL_ESCROW_RAW=${MAINNET_CANARY.maxTotalEscrowRaw}`,
    ...REQUIRED_KEYS.map(key => `${key}=${wallets[key].privateKey}`),
    '',
    '# Configure these only when a separate HTTPS mainnet canary service is released.',
    'HOLON_PUBLIC_URL=',
    'MVP_PUBLIC_ORIGIN=',
    'MVP_RETENTION_UNTIL=2026-10-31',
    'PROTOCOL_PORT=9404',
    'PORT=8768',
    'HOLON_READONLY=0',
    '',
  ];
  fs.writeFileSync(file, lines.join('\n'), {flag: 'wx', mode: 0o600});
  return {
    network: MAINNET_CANARY.network,
    chainId: MAINNET_CANARY.chainId,
    envFile: file,
    token: MAINNET_CANARY.token,
    limits: {maxBudgetRaw: MAINNET_CANARY.maxBudgetRaw.toString(), maxTotalEscrowRaw: MAINNET_CANARY.maxTotalEscrowRaw.toString()},
    addresses: Object.fromEntries(REQUIRED_KEYS.map(key => [key.replace(/_PRIVATE_KEY$/, '').toLowerCase(), wallets[key].address])),
  };
}

async function connectedProvider(env = process.env) {
  requireCanaryEnvironment(env);
  const provider = new JsonRpcProvider(env.XLAYER_RPC_URL || MAINNET_CANARY.rpcUrl, undefined,
    {batchMaxCount: 1, cacheTimeout: -1});
  provider.pollingInterval = 1000;
  const chainId = Number(await provider.send('eth_chainId', []));
  if (chainId !== MAINNET_CANARY.chainId) {
    provider.destroy();
    throw new Error(`RPC chain mismatch: expected ${MAINNET_CANARY.chainId}, received ${chainId}`);
  }
  return provider;
}

async function readToken(provider) {
  const code = await provider.getCode(MAINNET_CANARY.token.address);
  if (code === '0x') throw new Error('Reviewed X Layer USDC address has no bytecode');
  const token = new Contract(MAINNET_CANARY.token.address, TOKEN_ABI, provider);
  const [name, symbol, decimals, version, domainSeparator] = await Promise.all([
    token.name(), token.symbol(), token.decimals(), token.version(), token.DOMAIN_SEPARATOR(),
  ]);
  return {address: MAINNET_CANARY.token.address, name, symbol, decimals: Number(decimals), version,
    domainSeparator, bytecodeHash: keccak256(code)};
}

function checkedLimits(env = process.env) {
  const maxBudgetRaw = BigInt(env.MAINNET_CANARY_MAX_BUDGET_RAW || MAINNET_CANARY.maxBudgetRaw);
  const maxTotalEscrowRaw = BigInt(env.MAINNET_CANARY_MAX_TOTAL_ESCROW_RAW || MAINNET_CANARY.maxTotalEscrowRaw);
  if (maxBudgetRaw !== MAINNET_CANARY.maxBudgetRaw || maxTotalEscrowRaw !== MAINNET_CANARY.maxTotalEscrowRaw)
    throw new Error('Canary limits are frozen at 1 USDC per job and 5 USDC aggregate for this deployment profile');
  return {maxBudgetRaw, maxTotalEscrowRaw};
}

async function deploymentGas(provider, deployer, limits) {
  const nonce = await provider.getTransactionCount(deployer.address, 'latest');
  const implementation = getCreateAddress({from: deployer.address, nonce});
  const proxy = getCreateAddress({from: deployer.address, nonce: nonce + 1});
  const implementationFactory = new ContractFactory(artifact('IdentityRegistryUpgradeable').abi,
    artifact('IdentityRegistryUpgradeable').bytecode);
  const proxyFactory = new ContractFactory(artifact('ERC1967Proxy').abi, artifact('ERC1967Proxy').bytecode);
  const escrowFactory = new ContractFactory(artifact('MainnetCanaryEscrow').abi, artifact('MainnetCanaryEscrow').bytecode);
  const init = new Interface(artifact('IdentityRegistryUpgradeable').abi).encodeFunctionData('initialize');
  const requests = [
    await implementationFactory.getDeployTransaction(),
    await proxyFactory.getDeployTransaction(implementation, init),
    await escrowFactory.getDeployTransaction(MAINNET_CANARY.token.address, proxy, limits.maxBudgetRaw, limits.maxTotalEscrowRaw),
  ];
  try {
    const estimates = await Promise.all(requests.map(tx => provider.estimateGas({from: deployer.address, data: tx.data})));
    return {estimated: true, gas: estimates.reduce((total, value) => total + value, 0n), estimates: estimates.map(String)};
  } catch {
    return {estimated: false, gas: 10_000_000n, estimates: []};
  }
}

export async function preflightMainnetCanary({env = process.env, root = ROOT, connect = connectedProvider} = {}) {
  const report = {network: MAINNET_CANARY.network, chainId: MAINNET_CANARY.chainId, readOnly: true,
    checkedAt: new Date().toISOString(), token: null, deployer: null, roles: publicRoles(env), rpc: {reachable: false},
    contracts: {compiled: false}, blockers: [], deploymentReady: false};
  try { requireCanaryEnvironment(env); } catch (error) { report.blockers.push(error.message); return report; }
  let limits;
  try { limits = checkedLimits(env); } catch (error) { report.blockers.push(error.message); return report; }
  try {
    for (const name of ['IdentityRegistryUpgradeable', 'ERC1967Proxy', 'MainnetCanaryEscrow']) artifact(name);
    report.contracts.compiled = true;
  } catch { report.blockers.push('Run npm run compile before the mainnet canary preflight'); }
  const missing = REQUIRED_KEYS.filter(key => !report.roles[key.replace(/_PRIVATE_KEY$/, '').toLowerCase()]);
  if (missing.length) report.blockers.push(`Missing or invalid dedicated keys: ${missing.join(', ')}`);
  const addresses = Object.values(report.roles).filter(Boolean).map(value => value.toLowerCase());
  if (addresses.length && new Set(addresses).size !== addresses.length) report.blockers.push('Use distinct mainnet canary role wallets');
  if (fs.existsSync(progressPath(root))) report.blockers.push('A partial mainnet deployment exists; use resume:mainnet-canary');
  if (fs.existsSync(manifestPath(root))) report.blockers.push('The mainnet canary manifest already exists; verify it instead of redeploying');
  let provider;
  try {
    provider = await connect(env);
    const [blockNumber, feeData, token] = await Promise.all([provider.getBlockNumber(), provider.getFeeData(), readToken(provider)]);
    report.rpc = {reachable: true, chainId: MAINNET_CANARY.chainId, blockNumber,
      feePriceWei: String(feeData.maxFeePerGas || feeData.gasPrice || 0n)};
    report.token = token;
    for (const field of ['address', 'name', 'symbol', 'decimals', 'version']) {
      const expected = MAINNET_CANARY.token[field];
      const actual = token[field];
      if (String(actual).toLowerCase() !== String(expected).toLowerCase()) report.blockers.push(`USDC ${field} mismatch`);
    }
    if (report.roles.deployer) {
      const wallet = new Wallet(env.DEPLOYER_PRIVATE_KEY, provider);
      const balance = await provider.getBalance(wallet.address);
      const gas = report.contracts.compiled ? await deploymentGas(provider, wallet, limits) : {estimated: false, gas: 10_000_000n, estimates: []};
      const price = feeData.maxFeePerGas || feeData.gasPrice || 0n;
      const required = gas.gas * price * 2n;
      const suggested = required > parseEther('0.01') ? required : parseEther('0.01');
      report.deployer = {address: wallet.address, balanceOKB: formatEther(balance), gasEstimated: gas.estimated,
        deploymentGas: gas.gas.toString(), stepEstimates: gas.estimates, requiredOKB: formatEther(required),
        suggestedFundingOKB: formatEther(suggested), funded: price > 0n && balance >= required};
      if (!price) report.blockers.push('RPC did not return a usable gas price');
      else if (balance < required) report.blockers.push('Deployer needs mainnet OKB for the capped canary deployment');
    }
  } catch {
    report.blockers.push('Mainnet RPC or USDC compatibility check failed; inspect the configured RPC without exposing its URL');
  } finally { provider?.destroy(); }
  report.limits = {maxBudgetRaw: limits.maxBudgetRaw.toString(), maxTotalEscrowRaw: limits.maxTotalEscrowRaw.toString(),
    maxBudget: '1 USDC', maxTotalEscrow: '5 USDC'};
  report.deploymentReady = report.blockers.length === 0;
  return report;
}

export async function deployMainnetCanary({resume = false, env = process.env, root = ROOT, connect = connectedProvider} = {}) {
  requireCanaryEnvironment(env);
  const limits = checkedLimits(env);
  const output = manifestPath(root), progress = progressPath(root);
  if (fs.existsSync(output)) throw new Error('Mainnet canary deployment already exists; use verify:mainnet-canary');
  if (resume && !fs.existsSync(progress)) throw new Error('No partial mainnet canary deployment to resume');
  if (!resume && fs.existsSync(progress)) throw new Error('Partial mainnet canary deployment found; use resume:mainnet-canary');
  const provider = await connect(env);
  try {
    const token = await readToken(provider);
    for (const field of ['address', 'name', 'symbol', 'decimals', 'version'])
      if (String(token[field]).toLowerCase() !== String(MAINNET_CANARY.token[field]).toLowerCase())
        throw new Error(`USDC ${field} mismatch`);
    const owner = new Wallet(env.DEPLOYER_PRIVATE_KEY, provider);
    const records = resume ? JSON.parse(fs.readFileSync(progress)).transactions : [];
    const expectedSteps = ['IdentityRegistryUpgradeable', 'ERC1967Proxy', 'MainnetCanaryEscrow'];
    if (!Array.isArray(records) || records.length > expectedSteps.length || records.some((item, index) => item.step !== expectedSteps[index]))
      throw new Error('Invalid mainnet canary progress record');
    const checkpoint = () => atomicJSON(progress, {network: MAINNET_CANARY.network, chainId: MAINNET_CANARY.chainId, transactions: records});
    async function make(name, args) {
      const compiled = artifact(name);
      const factory = new ContractFactory(compiled.abi, compiled.bytecode, owner);
      const previous = records.find(record => record.step === name);
      if (previous) {
        const expected = await factory.getDeployTransaction(...args);
        const receipt = await verifyDeploymentRecord(provider, previous, owner.address, expected.data);
        previous.blockNumber = receipt.blockNumber;
        previous.blockHash = receipt.blockHash;
        checkpoint();
        return new Contract(previous.address, compiled.abi, owner);
      }
      const instance = await factory.deploy(...args);
      const record = {step: name, address: await instance.getAddress(), hash: instance.deploymentTransaction().hash};
      records.push(record); checkpoint();
      const receipt = await confirmed(instance.deploymentTransaction());
      record.blockNumber = receipt.blockNumber;
      record.blockHash = receipt.blockHash;
      record.bytecodeHash = keccak256(await visibleRead(() => provider.getCode(record.address)));
      checkpoint();
      return instance;
    }
    const implementation = await make('IdentityRegistryUpgradeable', []);
    const proxy = await make('ERC1967Proxy', [await implementation.getAddress(), implementation.interface.encodeFunctionData('initialize')]);
    const escrow = await make('MainnetCanaryEscrow', [MAINNET_CANARY.token.address, await proxy.getAddress(),
      limits.maxBudgetRaw, limits.maxTotalEscrowRaw]);
    const canaryAccounts = publicRoles(env);
    const manifest = {
      schemaVersion: 1,
      deploymentId: `mainnet-canary-${Buffer.from(randomBytes(16)).toString('hex')}`,
      deploymentMode: 'mainnet-canary',
      canaryVersion: MAINNET_CANARY.canaryVersion,
      mvpVersion: 1,
      network: MAINNET_CANARY.network,
      chainId: MAINNET_CANARY.chainId,
      identityRegistry: await proxy.getAddress(),
      identityImplementation: await implementation.getAddress(),
      identityOwner: owner.address,
      escrow: await escrow.getAddress(),
      escrowArtifact: 'MainnetCanaryEscrow',
      token: {...MAINNET_CANARY.token, testToken: false, bytecodeHash: token.bytecodeHash, domainSeparator: token.domainSeparator},
      limits: {maxBudgetRaw: limits.maxBudgetRaw.toString(), maxTotalEscrowRaw: limits.maxTotalEscrowRaw.toString()},
      applicationDomain: {name: 'LingoAI Mainnet Canary Market', version: '2'},
      canaryAccounts,
      deployer: owner.address,
      client: canaryAccounts.buyer,
      provider: canaryAccounts.agent_provider,
      facilitator: canaryAccounts.facilitator,
      agents: [],
      transactions: records,
      deployedAt: new Date().toISOString(),
      warning: 'Capped public demonstration only; not the production market contract.',
    };
    atomicJSON(output, manifest);
    fs.unlinkSync(progress);
    return manifest;
  } finally { provider.destroy(); }
}

export async function verifyMainnetCanary({env = process.env, root = ROOT, connect = connectedProvider} = {}) {
  requireCanaryEnvironment(env);
  const file = manifestPath(root);
  if (!fs.existsSync(file)) throw new Error('Mainnet canary deployment manifest is missing');
  const manifest = JSON.parse(fs.readFileSync(file));
  if (manifest.network !== MAINNET_CANARY.network || manifest.chainId !== MAINNET_CANARY.chainId ||
      manifest.deploymentMode !== 'mainnet-canary' || manifest.canaryVersion !== MAINNET_CANARY.canaryVersion ||
      manifest.escrowArtifact !== 'MainnetCanaryEscrow')
    throw new Error('Mainnet canary manifest identity mismatch');
  const provider = await connect(env);
  try {
    for (const address of [manifest.identityImplementation, manifest.identityRegistry, manifest.escrow, manifest.token.address])
      if (await provider.getCode(address) === '0x') throw new Error(`No bytecode at recorded address ${address}`);
    const token = await readToken(provider);
    const escrow = new Contract(manifest.escrow, artifact('MainnetCanaryEscrow').abi, provider);
    const registry = new Contract(manifest.identityRegistry, artifact('IdentityRegistryUpgradeable').abi, provider);
    const [paymentToken, identityRegistry, maxBudget, maxTotalEscrowed, totalEscrowed, jobCount, identityOwner] = await Promise.all([
      escrow.paymentToken(), escrow.identityRegistry(), escrow.maxBudget(), escrow.maxTotalEscrowed(),
      escrow.totalEscrowed(), escrow.jobCount(), registry.owner(),
    ]);
    if (paymentToken.toLowerCase() !== MAINNET_CANARY.token.address.toLowerCase() ||
        identityRegistry.toLowerCase() !== manifest.identityRegistry.toLowerCase() ||
        maxBudget.toString() !== manifest.limits.maxBudgetRaw || maxTotalEscrowed.toString() !== manifest.limits.maxTotalEscrowRaw)
      throw new Error('On-chain canary constructor configuration mismatch');
    const receipts = [];
    for (const record of manifest.transactions) {
      const receipt = await provider.getTransactionReceipt(record.hash);
      if (!receipt || receipt.status !== 1 || receipt.contractAddress?.toLowerCase() !== record.address.toLowerCase())
        throw new Error(`Deployment receipt mismatch: ${record.step}`);
      receipts.push({step: record.step, hash: record.hash, address: record.address, blockNumber: receipt.blockNumber});
    }
    return {ok: true, readOnly: true, checkedAt: new Date().toISOString(), chainId: MAINNET_CANARY.chainId,
      deploymentId: manifest.deploymentId, escrow: manifest.escrow, identityRegistry: manifest.identityRegistry,
      identityOwner, token, limits: manifest.limits, totalEscrowed: totalEscrowed.toString(), jobCount: jobCount.toString(), receipts};
  } finally { provider.destroy(); }
}
