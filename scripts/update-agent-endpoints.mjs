import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {keccak256, Transaction} from 'ethers';
import {ROOT, networkConfig, provider, signer, checkedDeployment, chainContract, atomicJSON, manifestFile} from '../protocol/chain.mjs';
import {inspectServiceURL} from '../protocol/testnet.mjs';
import {visibleRead} from '../protocol/deployment.mjs';

// Run locally with the existing owners. Raw signed transactions are checkpointed
// in ignored data/ before broadcast, so an interrupted update reuses its hash.
assert.equal(networkConfig().chainId, 1952);
const url = inspectServiceURL(process.argv[2]);
assert.ok(url.configured, 'Provide the new HTTP(S) service origin');
const base = url.origin;
const p = await provider();
try {
  const d = await checkedDeployment(p);
  const response = await fetch(`${base}/api/xlayer/config`, {signal:AbortSignal.timeout(30000)});
  assert.equal(response.status, 200, 'The new service must be healthy first');
  const config = await response.json();
  assert.equal(config.network.chainId, 1952);
  assert.equal(config.deployment.deploymentId, d.deploymentId);
  const file = path.join(ROOT, 'data/agent-endpoint-update.json');
  let journal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
  if (journal && (journal.base !== base || journal.deploymentId !== d.deploymentId)) {
    assert.ok(journal.completed, 'Finish the previous endpoint update first');
    atomicJSON(`${file}.${Date.now()}.json`, journal);
    journal = null;
  }
  journal ||= {base, deploymentId:d.deploymentId, entries:{}};
  for (const agent of d.agents) {
    const wallet = signer(agent.role, p);
    const registry = chainContract('IdentityRegistryUpgradeable', d.identityRegistry, wallet);
    assert.equal((await registry.ownerOf(agent.id)).toLowerCase(), wallet.address.toLowerCase());
    const current = await registry.tokenURI(agent.id);
    assert.ok(current.startsWith('data:application/json;base64,'));
    const metadata = JSON.parse(Buffer.from(current.split(',')[1], 'base64').toString());
    for (const service of metadata.services) {
      if (service.name === 'web') service.endpoint = `${base}/#marketplace`;
      if (service.name === 'x402') service.endpoint = `${base}/api/agent/research`;
    }
    const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`;
    let entry = journal.entries[agent.id];
    if (current !== uri || entry) {
      const transaction = await registry.setAgentURI.populateTransaction(agent.id, uri);
      if (!entry) {
        const raw = await wallet.signTransaction(await wallet.populateTransaction(transaction));
        entry = journal.entries[agent.id] = {raw, hash:keccak256(raw), uri};
        atomicJSON(file, journal);
      }
      const parsed = Transaction.from(entry.raw);
      assert.equal(parsed.from.toLowerCase(), wallet.address.toLowerCase());
      assert.equal(parsed.to.toLowerCase(), d.identityRegistry.toLowerCase());
      assert.equal(parsed.chainId, 1952n);
      assert.equal(parsed.value, 0n);
      assert.equal(parsed.data, transaction.data);
      assert.equal(entry.hash, keccak256(entry.raw));
      assert.equal(entry.uri, uri);
      if (!await p.getTransactionReceipt(entry.hash) && !await p.getTransaction(entry.hash)) {
        try {await p.broadcastTransaction(entry.raw)} catch (error) {
          if (!await p.getTransaction(entry.hash)) throw error;
        }
      }
      const receipt = await p.getTransactionReceipt(entry.hash) || await p.waitForTransaction(entry.hash, 1, 120000);
      assert.equal(receipt?.status, 1, `Update pending or failed: ${entry.hash}`);
      await visibleRead(() => registry.tokenURI(agent.id), {accept:value => value === uri});
      if (!d.transactions.some(tx => tx.hash === entry.hash)) d.transactions.push({step:`update-endpoint-${agent.slug}`, hash:entry.hash, blockNumber:receipt.blockNumber});
      console.log(`Agent #${agent.id}: ${entry.hash}`);
    }
    agent.metadataURI = uri;
    atomicJSON(manifestFile(), d);
  }
  journal.completed = true;
  atomicJSON(file, journal);
  console.log(`Verified ${d.agents.length} Agent endpoints: ${base}`);
} finally {p.destroy()}
