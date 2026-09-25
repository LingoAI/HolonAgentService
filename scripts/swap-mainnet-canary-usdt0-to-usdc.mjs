import path from 'node:path';
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  formatUnits,
  parseEther,
} from 'ethers';

import {ROOT, atomicJSON} from '../protocol/chain.mjs';

const PROFILE = Object.freeze({
  chainId: 196,
  usdt0: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
  usdc: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
  factory: '0x4B2ab38DBF28D31D467aA8993f6c2585981D6804',
  quoter: '0xd1b797d92d87b688193a2b976efc8d577d204343',
  router: '0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca',
  pool: '0xEEeB3C1F61DC3070C675c2670a3f2188A060012D',
  fee: 100,
  amountIn: 110_000n,
  minimumRateBps: 9_900n,
  slippageBps: 50n,
  buyerGasTarget: parseEther('0.0002'),
});

const ERC20 = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const FACTORY = ['function getPool(address,address,uint24) view returns (address)'];
const QUOTER = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];
const ROUTER = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

function assertProfile(env = process.env) {
  if (env.HIRE_NETWORK !== 'xlayer-mainnet' || env.MVP_MAINNET_CANARY !== '1')
    throw new Error('The explicit X Layer mainnet canary profile is required');
  if ((env.PAYMENT_TOKEN_ADDRESS || '').toLowerCase() !== PROFILE.usdc.toLowerCase())
    throw new Error('PAYMENT_TOKEN_ADDRESS must be Circle native USDC on X Layer');
}

async function receipt(tx, label) {
  const value = await tx.wait(1);
  if (!value || value.status !== 1) throw new Error(`${label} transaction failed`);
  return {step: label, hash: tx.hash, blockNumber: value.blockNumber, gasUsed: value.gasUsed.toString()};
}

async function main() {
  const execute = process.argv[2] === 'execute';
  if (process.argv[2] && !execute) throw new Error('Usage: swap-mainnet-canary-usdt0-to-usdc.mjs [execute]');
  assertProfile();
  const provider = new JsonRpcProvider(process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech', PROFILE.chainId,
    {batchMaxCount: 1, cacheTimeout: -1});
  provider.pollingInterval = 1000;
  try {
    if (Number((await provider.getNetwork()).chainId) !== PROFILE.chainId) throw new Error('RPC chain mismatch');
    const buyer = new Wallet(process.env.BUYER_PRIVATE_KEY, provider);
    const deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    if (buyer.address.toLowerCase() !== '0x0321ef63b7c10d1e33a7eb1a7b5f431121211eab')
      throw new Error('Unexpected buyer wallet for the funded mainnet canary');
    const usdt0 = new Contract(PROFILE.usdt0, ERC20, buyer);
    const usdc = new Contract(PROFILE.usdc, ERC20, buyer);
    const factory = new Contract(PROFILE.factory, FACTORY, provider);
    const quoter = new Contract(PROFILE.quoter, QUOTER, provider);
    const router = new Contract(PROFILE.router, ROUTER, buyer);
    for (const address of [PROFILE.usdt0, PROFILE.usdc, PROFILE.factory, PROFILE.quoter, PROFILE.router, PROFILE.pool])
      if (await provider.getCode(address) === '0x') throw new Error(`Expected contract has no bytecode: ${address}`);
    const [usdt0Name, usdt0Symbol, usdt0Decimals, usdcName, usdcSymbol, usdcDecimals, pool] = await Promise.all([
      usdt0.name(), usdt0.symbol(), usdt0.decimals(), usdc.name(), usdc.symbol(), usdc.decimals(),
      factory.getPool(PROFILE.usdt0, PROFILE.usdc, PROFILE.fee),
    ]);
    if (Number(usdt0Decimals) !== 6 || Number(usdcDecimals) !== 6 || usdcName !== 'USDC' || usdcSymbol !== 'USDC' ||
        pool.toLowerCase() !== PROFILE.pool.toLowerCase())
      throw new Error('Token metadata or official Uniswap pool mismatch');
    const quote = await quoter.quoteExactInputSingle.staticCall({tokenIn: PROFILE.usdt0, tokenOut: PROFILE.usdc,
      amountIn: PROFILE.amountIn, fee: PROFILE.fee, sqrtPriceLimitX96: 0n});
    const amountOut = quote.amountOut;
    if (amountOut * 10_000n < PROFILE.amountIn * PROFILE.minimumRateBps)
      throw new Error('Quote is below the frozen minimum 0.99 USDC per USDT0');
    const amountOutMinimum = amountOut * (10_000n - PROFILE.slippageBps) / 10_000n;
    const before = {
      usdt0: await usdt0.balanceOf(buyer.address),
      usdc: await usdc.balanceOf(buyer.address),
      buyerOKB: await provider.getBalance(buyer.address),
      deployerOKB: await provider.getBalance(deployer.address),
    };
    const report = {
      schemaVersion: 1,
      network: 'xlayer-mainnet',
      chainId: PROFILE.chainId,
      readOnly: !execute,
      checkedAt: new Date().toISOString(),
      buyer: buyer.address,
      route: {protocol: 'Uniswap V3', pool: PROFILE.pool, fee: PROFILE.fee, router: PROFILE.router},
      fromToken: {address: PROFILE.usdt0, name: usdt0Name, symbol: usdt0Symbol, decimals: 6},
      toToken: {address: PROFILE.usdc, name: usdcName, symbol: usdcSymbol, decimals: 6},
      amountInRaw: PROFILE.amountIn.toString(),
      amountIn: formatUnits(PROFILE.amountIn, 6),
      quotedAmountOutRaw: amountOut.toString(),
      quotedAmountOut: formatUnits(amountOut, 6),
      amountOutMinimumRaw: amountOutMinimum.toString(),
      amountOutMinimum: formatUnits(amountOutMinimum, 6),
      before: {usdt0: formatUnits(before.usdt0, 6), usdc: formatUnits(before.usdc, 6),
        buyerOKB: formatEther(before.buyerOKB), deployerOKB: formatEther(before.deployerOKB)},
      transactions: [],
    };
    if (!execute) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (before.usdt0 < PROFILE.amountIn) throw new Error('Buyer has insufficient USDT0 for the frozen swap amount');
    const evidence = path.join(ROOT, 'evidence/xlayer/mainnet-usdt0-to-native-usdc-2026-09-22.json');
    if (await import('node:fs').then(({default: fs}) => fs.existsSync(evidence)))
      throw new Error('Swap evidence already exists; refusing a duplicate execution');
    if (before.buyerOKB < PROFILE.buyerGasTarget) {
      const required = PROFILE.buyerGasTarget - before.buyerOKB;
      if (before.deployerOKB <= required) throw new Error('Deployer has insufficient OKB to fund buyer gas');
      report.transactions.push(await receipt(await deployer.sendTransaction({to: buyer.address, value: required}), 'fund-buyer-gas'));
    }
    const currentAllowance = await usdt0.allowance(buyer.address, PROFILE.router);
    if (currentAllowance > 0n && currentAllowance < PROFILE.amountIn)
      report.transactions.push(await receipt(await usdt0.approve(PROFILE.router, 0n), 'reset-usdt0-allowance'));
    if (await usdt0.allowance(buyer.address, PROFILE.router) < PROFILE.amountIn)
      report.transactions.push(await receipt(await usdt0.approve(PROFILE.router, PROFILE.amountIn), 'approve-exact-usdt0'));
    const params = {tokenIn: PROFILE.usdt0, tokenOut: PROFILE.usdc, fee: PROFILE.fee, recipient: buyer.address,
      amountIn: PROFILE.amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n};
    const simulated = await router.exactInputSingle.staticCall(params);
    if (simulated < amountOutMinimum) throw new Error('Swap simulation fell below the minimum output');
    const gas = await router.exactInputSingle.estimateGas(params);
    report.transactions.push(await receipt(await router.exactInputSingle(params, {gasLimit: gas * 12n / 10n}), 'swap-usdt0-to-native-usdc'));
    const after = {
      usdt0: await usdt0.balanceOf(buyer.address),
      usdc: await usdc.balanceOf(buyer.address),
      buyerOKB: await provider.getBalance(buyer.address),
      deployerOKB: await provider.getBalance(deployer.address),
      allowance: await usdt0.allowance(buyer.address, PROFILE.router),
    };
    const actualOut = after.usdc - before.usdc;
    if (before.usdt0 - after.usdt0 !== PROFILE.amountIn || actualOut < amountOutMinimum)
      throw new Error('Post-swap balance verification failed');
    report.readOnly = false;
    report.executedAt = new Date().toISOString();
    report.actualAmountOutRaw = actualOut.toString();
    report.actualAmountOut = formatUnits(actualOut, 6);
    report.after = {usdt0: formatUnits(after.usdt0, 6), usdc: formatUnits(after.usdc, 6),
      buyerOKB: formatEther(after.buyerOKB), deployerOKB: formatEther(after.deployerOKB),
      routerAllowanceRaw: after.allowance.toString()};
    atomicJSON(evidence, report);
    console.log(JSON.stringify(report, null, 2));
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
