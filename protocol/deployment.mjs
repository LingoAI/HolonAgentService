import {setTimeout as delay} from 'node:timers/promises';

// Public RPC replicas can briefly return empty data after a successful receipt.
// Retry reads only: transaction broadcasts must never be retried this way.
export async function visibleRead(read, {accept = value => value != null && value !== '0x', attempts = 8, delayMs = 1500} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      if (!(error.code === 'BAD_DATA' && error.value === '0x')) throw error;
    }
    if (attempt + 1 < attempts) await delay(delayMs);
  }
  throw new Error('Confirmed deployment is not yet visible on the RPC; retry the resume command later');
}

export function deploymentRecords(progress, network, steps) {
  if (progress.network !== network.name || progress.chainId !== network.chainId) throw new Error('Partial deployment network mismatch');
  if (!Array.isArray(progress.transactions) || !progress.transactions.length || progress.transactions.length > steps.length) throw new Error('Invalid partial deployment records');
  for (const [index, record] of progress.transactions.entries()) {
    if (record.step !== steps[index] || !/^0x[0-9a-f]{40}$/i.test(record.address) || !/^0x[0-9a-f]{64}$/i.test(record.hash)) throw new Error('Invalid partial deployment step or address');
  }
  return progress.transactions;
}

export async function verifyDeploymentRecord(p, record, owner, data) {
  const tx = await visibleRead(() => p.getTransaction(record.hash));
  if (tx.from.toLowerCase() !== owner.toLowerCase() || tx.to != null || tx.data.toLowerCase() !== data.toLowerCase()) throw new Error(`Deployment transaction mismatch: ${record.step}`);
  const receipt = await p.getTransactionReceipt(record.hash) || await p.waitForTransaction(record.hash, 1, 120000);
  if (!receipt || receipt.status !== 1 || receipt.hash.toLowerCase() !== record.hash.toLowerCase() || receipt.contractAddress?.toLowerCase() !== record.address.toLowerCase()) throw new Error(`Deployment receipt mismatch: ${record.step}`);
  // A testnet reorganization can move the same successful transaction. Accept it
  // only when its current receipt belongs to the canonical block at that height.
  await visibleRead(() => p.getBlock(receipt.blockNumber), {accept:block => block?.hash === receipt.blockHash});
  await visibleRead(() => p.getCode(record.address));
  return receipt;
}
