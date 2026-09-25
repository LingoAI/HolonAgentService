// X Layer's public testnet RPC accepts at most 100 blocks per eth_getLogs.
// Bounded parallel reads retain ordering without issuing an unbounded burst.
export async function logsInRange(read, fromBlock, toBlock, maxBlocks = 100) {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < 0 || !Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 100) throw new Error('Invalid log block range');
  const logs = [];
  for (let from = fromBlock; from <= toBlock; from += maxBlocks * 3) {
    const pages = [];
    for (let start = from; start <= toBlock && start < from + maxBlocks * 3; start += maxBlocks) pages.push(read(start, Math.min(start + maxBlocks - 1, toBlock)));
    for (const page of await Promise.all(pages)) logs.push(...page);
  }
  return logs;
}

// Keep an overlapping tail for recent reorgs, and verify the older anchor before
// retaining cached history. A changed anchor triggers a full rescan.
export async function logScanStart(firstBlock, toBlock, cached, getBlock) {
  if (!cached || cached.toBlock > toBlock || cached.anchorNumber < firstBlock || cached.anchorNumber > cached.toBlock) return firstBlock;
  const anchor = await getBlock(cached.anchorNumber);
  return anchor?.hash === cached.anchorHash ? cached.anchorNumber + 1 : firstBlock;
}
