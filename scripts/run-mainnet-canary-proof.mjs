import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  Contract,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  formatEther,
  formatUnits,
  keccak256,
  parseEther,
  toUtf8Bytes,
} from 'ethers';

import {ROOT, artifact, atomicJSON} from '../protocol/chain.mjs';

const PROFILE = Object.freeze({
  chainId: 196,
  manifest: 'xlayer-mainnet-native-usdc-canary.json',
  token: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
  amount: 100_000n,
  gasTarget: parseEther('0.0002'),
  publicOrigin: 'https://holonagentservice.lingoai.io',
  publicGateway: 'https://gateway.pinata.cloud/ipfs/',
  sshHost: 'lingoai-x-x-layer',
  remoteRoot: '/home/ecs-user/okx-agent-marketplace',
});
const PROGRESS = path.join(ROOT, 'docs/evidence/mainnet-native-usdc-proof.progress.json');
const EVIDENCE = path.join(ROOT, 'docs/evidence/mainnet-native-usdc-proof-2026-09-22.json');
const DATA = path.join(ROOT, 'data/mainnet-native-usdc-proof');
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function rawCid(raw) {
  const digest = crypto.createHash('sha256').update(raw).digest();
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`;
}

function ssh(command, input, encoding = 'utf8') {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', PROFILE.sshHost, command],
    {input, encoding: encoding === 'buffer' ? null : encoding, maxBuffer: 8 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`Remote IPFS command failed: ${String(result.stderr).trim().slice(0, 300)}`);
  return result.stdout;
}

function pinRaw(raw) {
  const expected = rawCid(raw);
  const command = `cd ${PROFILE.remoteRoot} && ./manage.sh exec -T ipfs ipfs add -Q --cid-version=1 --raw-leaves=true --pin=true -`;
  const actual = String(ssh(command, raw, 'buffer')).trim();
  if (actual !== expected) throw new Error(`Kubo returned an unexpected CID: ${actual}`);
  return actual;
}

function bundlePair(directory) {
  const archive = spawnSync('tar', ['-cf', '-', '-C', directory, 'document.md', 'manifest.json'],
    {encoding: 'buffer', maxBuffer: 8 * 1024 * 1024});
  if (archive.status !== 0) throw new Error(`Local CAR staging failed: ${String(archive.stderr).slice(0, 200)}`);
  const inner = 'set -eu; d=$(mktemp -d); trap "rm -rf $d" EXIT; tar -xf - -C "$d"; ' +
    'ipfs add -Q --cid-version=1 --raw-leaves=true --pin=true --wrap-with-directory "$d/document.md" "$d/manifest.json"';
  const command = `cd ${PROFILE.remoteRoot} && ./manage.sh exec -T ipfs sh -c '${inner}'`;
  const rootCid = String(ssh(command, archive.stdout, 'buffer')).trim();
  if (!/^b[a-z2-7]+$/.test(rootCid)) throw new Error('Kubo returned an invalid bundle root CID');
  const car = ssh(`cd ${PROFILE.remoteRoot} && ./manage.sh exec -T ipfs ipfs dag export ${rootCid}`, undefined, 'buffer');
  if (!Buffer.isBuffer(car) || car.length === 0) throw new Error('Kubo returned an empty CAR');
  const carDirectory = path.join(DATA, 'ipfs/car');
  fs.mkdirSync(carDirectory, {recursive: true});
  const carPath = path.join(carDirectory, `${rootCid}.car`);
  if (fs.existsSync(carPath)) {
    if (!fs.readFileSync(carPath).equals(car)) throw new Error('Existing CAR bytes differ from the exported bundle');
  } else fs.writeFileSync(carPath, car, {flag: 'wx'});
  return {rootCid, carPath: path.relative(ROOT, carPath), carBytes: car.length,
    carSha256: crypto.createHash('sha256').update(car).digest('hex')};
}

async function verifyPublic(cid, expected) {
  const url = `${PROFILE.publicGateway}${cid}`;
  let last = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(url, {redirect: 'error'});
      if (response.ok) {
        const actual = Buffer.from(await response.arrayBuffer());
        if (actual.equals(expected)) return {url,
          bytes: actual.length, sha256: crypto.createHash('sha256').update(actual).digest('hex')};
        last = 'public bytes differ from the pinned object';
      } else last = `HTTP ${response.status}`;
    } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Public IPFS readback failed: ${last}`);
}

function parsedEvent(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const event = contract.interface.parseLog(log);
      if (event?.name === name) return event;
    } catch {}
  }
  throw new Error(`${name} event is missing`);
}

async function main() {
  if (process.argv[2] !== 'execute') throw new Error('Usage: run-mainnet-canary-proof.mjs execute');
  if (process.env.HIRE_NETWORK !== 'xlayer-mainnet' || process.env.MVP_MAINNET_CANARY !== '1' ||
      process.env.MVP_DEPLOYMENT_MANIFEST !== PROFILE.manifest ||
      (process.env.PAYMENT_TOKEN_ADDRESS || '').toLowerCase() !== PROFILE.token.toLowerCase())
    throw new Error('The Circle native USDC mainnet canary profile is required');
  if (fs.existsSync(EVIDENCE)) throw new Error('Final mainnet proof evidence already exists; refusing a duplicate run');
  const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/deployments', PROFILE.manifest)));
  if (deployment.chainId !== PROFILE.chainId || deployment.canaryVersion !== 2 ||
      deployment.token.address.toLowerCase() !== PROFILE.token.toLowerCase())
    throw new Error('Native USDC canary manifest mismatch');
  const provider = new JsonRpcProvider(process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech', PROFILE.chainId,
    {batchMaxCount: 1, cacheTimeout: -1});
  provider.pollingInterval = 1000;
  try {
    if (Number((await provider.getNetwork()).chainId) !== PROFILE.chainId) throw new Error('RPC chain mismatch');
    const wallets = {
      deployer: new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider),
      buyer: new Wallet(process.env.BUYER_PRIVATE_KEY, provider),
      provider: new Wallet(process.env.AGENT_PROVIDER_PRIVATE_KEY, provider),
      facilitator: new Wallet(process.env.FACILITATOR_PRIVATE_KEY, provider),
    };
    const signers = Object.fromEntries(Object.entries(wallets)
      .map(([role, wallet]) => [role, new NonceManager(wallet)]));
    for (const [role, wallet] of Object.entries(wallets)) {
      const expected = deployment.canaryAccounts[role === 'provider' ? 'agent_provider' : role];
      if (wallet.address.toLowerCase() !== expected.toLowerCase()) throw new Error(`${role} wallet mismatch`);
    }
    const registry = new Contract(deployment.identityRegistry, artifact('IdentityRegistryUpgradeable').abi, signers.provider);
    const escrowBuyer = new Contract(deployment.escrow, artifact('MainnetCanaryEscrow').abi, signers.buyer);
    const escrowProvider = escrowBuyer.connect(signers.provider);
    const escrowFacilitator = escrowBuyer.connect(signers.facilitator);
    const token = new Contract(PROFILE.token, ERC20, signers.buyer);
    const progress = fs.existsSync(PROGRESS) ? JSON.parse(fs.readFileSync(PROGRESS)) : {
      schemaVersion: 1, network: 'xlayer-mainnet', chainId: PROFILE.chainId, deploymentId: deployment.deploymentId,
      deployment: {escrow: deployment.escrow, identityRegistry: deployment.identityRegistry, token: PROFILE.token},
      roles: Object.fromEntries(Object.entries(wallets).map(([role, wallet]) => [role, wallet.address])),
      amountRaw: PROFILE.amount.toString(), startedAt: new Date().toISOString(), transactions: [],
      initialBalances: {
        buyerUSDC: (await token.balanceOf(wallets.buyer.address)).toString(),
        providerUSDC: (await token.balanceOf(wallets.provider.address)).toString(),
        escrowUSDC: (await token.balanceOf(deployment.escrow)).toString(),
      },
    };
    if (progress.deploymentId !== deployment.deploymentId) throw new Error('Existing proof progress belongs to another deployment');
    const checkpoint = () => atomicJSON(PROGRESS, progress);
    checkpoint();
    async function sent(step, makeTransaction) {
      const previous = progress.transactions.find(item => item.step === step);
      if (previous) {
        const known = await provider.getTransactionReceipt(previous.hash);
        if (!known || known.status !== 1) throw new Error(`Recorded ${step} transaction is not confirmed`);
        return known;
      }
      const transaction = await makeTransaction();
      const confirmed = await transaction.wait(1);
      if (!confirmed || confirmed.status !== 1) throw new Error(`${step} transaction failed`);
      progress.transactions.push({step, hash: transaction.hash, blockNumber: confirmed.blockNumber,
        gasUsed: confirmed.gasUsed.toString()});
      checkpoint();
      return confirmed;
    }
    for (const role of ['provider', 'facilitator']) {
      const balance = await provider.getBalance(wallets[role].address);
      if (balance < PROFILE.gasTarget) {
        const deficit = PROFILE.gasTarget - balance;
        await sent(`fund-${role}-gas`, () => signers.deployer.sendTransaction({to: wallets[role].address, value: deficit}));
      }
    }
    const rawDirectory = path.join(DATA, 'ipfs/raw');
    fs.mkdirSync(rawDirectory, {recursive: true});
    const metadataRaw = Buffer.from(canonical({
      active: true,
      description: 'Team-controlled provider for the capped LingoAI X Layer mainnet proof.',
      name: 'LingoAI Mainnet Canary Provider',
      owner: wallets.provider.address.toLowerCase(),
      schemaVersion: '1.0',
      services: [{name: 'LingoAI Marketplace', endpoint: PROFILE.publicOrigin, version: '1'}],
      templates: ['community-introduction-faq-v1'],
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    }));
    const metadataPath = path.join(rawDirectory, 'metadata.json');
    if (!fs.existsSync(metadataPath)) fs.writeFileSync(metadataPath, metadataRaw, {flag: 'wx'});
    else if (!fs.readFileSync(metadataPath).equals(metadataRaw)) throw new Error('Existing Agent metadata bytes differ');
    const metadataCid = pinRaw(metadataRaw);
    progress.ipfs = {...progress.ipfs, metadataCid, metadata: await verifyPublic(metadataCid, metadataRaw)};
    checkpoint();
    if (progress.agentId == null) {
      const registration = await sent('register-agent', () => registry['register(string)'](`ipfs://${metadataCid}`));
      progress.agentId = parsedEvent(registry, registration, 'Registered').args.agentId.toString();
      checkpoint();
    }
    if ((await registry.ownerOf(progress.agentId)).toLowerCase() !== wallets.provider.address.toLowerCase() ||
        await registry.tokenURI(progress.agentId) !== `ipfs://${metadataCid}`)
      throw new Error('Registered Agent identity verification failed');
    if (progress.jobId == null) {
      progress.expiredAt = Math.floor(Date.now() / 1000) + 24 * 3600;
      const created = await sent('create-agent-job', () => escrowBuyer.createAgentJob(progress.agentId,
        wallets.facilitator.address, progress.expiredAt,
        'Mainnet canary: produce and settle a public LingoAI community FAQ delivery.'));
      progress.jobId = parsedEvent(escrowBuyer, created, 'JobCreated').args.jobId.toString();
      checkpoint();
    }
    let job = await escrowBuyer.getJob(progress.jobId);
    if (job.budget === 0n) await sent('set-budget', () => escrowBuyer.setBudget(progress.jobId, PROFILE.amount));
    job = await escrowBuyer.getJob(progress.jobId);
    if (Number(job.status) === 0) {
      if (await token.allowance(wallets.buyer.address, deployment.escrow) < PROFILE.amount)
        await sent('approve-exact-usdc', () => token.approve(deployment.escrow, PROFILE.amount));
      await sent('fund-job', () => escrowBuyer.fund(progress.jobId, PROFILE.amount));
    }
    job = await escrowBuyer.getJob(progress.jobId);
    if (Number(job.status) !== 1 && Number(job.status) !== 2 && Number(job.status) !== 3)
      throw new Error('Mainnet job is not in an escrowed or completed state');
    const documentRaw = Buffer.from(`# LingoAI Mainnet Canary Delivery\n\n` +
      `This public delivery proves a capped fixed-bounty AI Agent task on X Layer mainnet.\n\n` +
      `## Verification\n\n` +
      `- Chain ID: 196\n- Escrow: ${deployment.escrow}\n- Job ID: ${progress.jobId}\n` +
      `- Payment asset: Circle native USDC\n- Bounty: 0.10 USDC\n` +
      `- Provider Agent ID: ${progress.agentId}\n\n` +
      `The buyer funds escrow, the registered provider publishes this exact-byte delivery, and the designated evaluator releases payment.\n`);
    const documentCid = pinRaw(documentRaw);
    const manifestRaw = Buffer.from(canonical({
      chainId: PROFILE.chainId, escrow: deployment.escrow.toLowerCase(), fileCid: documentCid,
      fileSha256: crypto.createHash('sha256').update(documentRaw).digest('hex'), fileSize: documentRaw.length,
      jobId: progress.jobId, provider: wallets.provider.address.toLowerCase(), schemaVersion: '1.0',
      templateId: 'community-introduction-faq-v1', token: PROFILE.token.toLowerCase(), amountRaw: PROFILE.amount.toString(),
    }));
    const deliveryDirectory = path.join(rawDirectory, `job-${progress.jobId}`);
    fs.mkdirSync(deliveryDirectory, {recursive: true});
    const documentPath = path.join(deliveryDirectory, 'document.md');
    const manifestPath = path.join(deliveryDirectory, 'manifest.json');
    for (const [file, raw] of [[documentPath, documentRaw], [manifestPath, manifestRaw]]) {
      if (!fs.existsSync(file)) fs.writeFileSync(file, raw, {flag: 'wx'});
      else if (!fs.readFileSync(file).equals(raw)) throw new Error(`Existing delivery bytes differ: ${file}`);
    }
    const manifestCid = pinRaw(manifestRaw);
    const [documentPublic, manifestPublic] = await Promise.all([
      verifyPublic(documentCid, documentRaw), verifyPublic(manifestCid, manifestRaw),
    ]);
    if (!progress.ipfs.bundle) progress.ipfs.bundle = bundlePair(deliveryDirectory);
    progress.ipfs = {...progress.ipfs, documentCid, manifestCid, document: documentPublic,
      manifest: manifestPublic, manifestKeccak256: keccak256(manifestRaw)};
    checkpoint();
    job = await escrowBuyer.getJob(progress.jobId);
    if (Number(job.status) === 1)
      await sent('submit-delivery', () => escrowProvider.submitWithURI(progress.jobId,
        progress.ipfs.manifestKeccak256, `ipfs://${manifestCid}`));
    job = await escrowBuyer.getJob(progress.jobId);
    if (Number(job.status) === 2)
      await sent('complete-job', () => escrowFacilitator.complete(progress.jobId,
        keccak256(toUtf8Bytes('mainnet-canary-v2-accepted'))));
    job = await escrowBuyer.getJob(progress.jobId);
    const final = {
      buyerUSDC: await token.balanceOf(wallets.buyer.address),
      providerUSDC: await token.balanceOf(wallets.provider.address),
      escrowUSDC: await token.balanceOf(deployment.escrow),
      totalEscrowed: await escrowBuyer.totalEscrowed(),
      allowance: await token.allowance(wallets.buyer.address, deployment.escrow),
      buyerOKB: await provider.getBalance(wallets.buyer.address),
      providerOKB: await provider.getBalance(wallets.provider.address),
      facilitatorOKB: await provider.getBalance(wallets.facilitator.address),
    };
    const initialBuyer = BigInt(progress.initialBalances.buyerUSDC);
    const initialProvider = BigInt(progress.initialBalances.providerUSDC);
    if (Number(job.status) !== 3 || initialBuyer - final.buyerUSDC !== PROFILE.amount ||
        final.providerUSDC - initialProvider !== PROFILE.amount || final.escrowUSDC !== 0n ||
        final.totalEscrowed !== 0n || final.allowance !== 0n)
      throw new Error('Final mainnet proof invariants failed');
    const evidence = {...progress, completedAt: new Date().toISOString(), agentId: progress.agentId,
      jobId: progress.jobId, status: 'Completed', delivery: {uri: `ipfs://${manifestCid}`,
        digest: progress.ipfs.manifestKeccak256}, finalBalances: {
        buyerUSDC: formatUnits(final.buyerUSDC, 6), providerUSDC: formatUnits(final.providerUSDC, 6),
        escrowUSDC: formatUnits(final.escrowUSDC, 6), buyerOKB: formatEther(final.buyerOKB),
        providerOKB: formatEther(final.providerOKB), facilitatorOKB: formatEther(final.facilitatorOKB),
      }};
    atomicJSON(EVIDENCE, evidence);
    fs.unlinkSync(PROGRESS);
    console.log(JSON.stringify({ok: true, evidence: EVIDENCE, deploymentId: deployment.deploymentId,
      escrow: deployment.escrow, agentId: progress.agentId, jobId: progress.jobId, delivery: evidence.delivery,
      finalBalances: evidence.finalBalances, transactions: evidence.transactions}, null, 2));
  } finally {
    provider.destroy();
  }
}

try {
  await main();
} catch (error) {
  const rpc = process.env.XLAYER_RPC_URL || '__unused_rpc__';
  console.error(String(error.shortMessage || error.message).replaceAll(rpc, '[configured RPC]'));
  process.exitCode = 1;
}
