#!/usr/bin/env node

// One-time, bounded funding for the project's OKX.AI buyer Agent #13889.
// Preview by default. Execute only after the official buyer precheck reports
// a 0.10 USDT shortfall at the exact BUYER_AGENT address below.

import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  Contract, JsonRpcProvider, Wallet, formatEther, formatUnits, parseEther,
} from 'ethers';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const evidence=resolve(root,'docs/evidence/okx-ai-selftest-funding-2026-09-25.json');
const execute=process.argv[2]==='--execute';
if (process.argv.length>3 || (process.argv[2] && !execute))
  throw new Error('Usage: node --env-file=.env.mainnet-canary scripts/fund-okx-ai-selftest-buyer.mjs [--execute]');
if (process.env.HIRE_NETWORK!=='xlayer-mainnet') throw new Error('X Layer mainnet profile required');

const CHAIN_ID=196;
const USDC='0xB6CEceAB302E2E4948951eE7843FC24E92933061';
const USDT='0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const ROUTER='0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca';
const QUOTER='0xd1b797d92d87b688193a2b976efc8d577d204343';
const POOL='0xEEeB3C1F61DC3070C675c2670a3f2188A060012D';
const PROJECT_BUYER='0x0321ef63b7C10d1E33a7eB1a7b5f431121211eAb';
const PROJECT_PROVIDER='0xC51ba41519f2C7da10324c61a6325066a190252B';
const PROJECT_DEPLOYER='0x7Cd5e739CD6037C37d0bfF6ce6861f2983e69D36';
const BUYER_AGENT='0xd576d72631d4844e4afcb3a36a49faa84411df04';
const SWAP_IN=105_000n; // 0.105 USDC
const FUND=100_000n; // 0.100 USDT0
const GAS_TARGET=parseEther('0.001');
const ERC20=[
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];
const QUOTER_ABI=[
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];
const ROUTER_ABI=[
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

function save(report) {
  mkdirSync(dirname(evidence),{recursive:true});
  const tmp=`${evidence}.tmp`;
  writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  renameSync(tmp,evidence);
}
function confirmAddress(wallet,expected,label) {
  if (wallet.address.toLowerCase()!==expected.toLowerCase())
    throw new Error(`Unexpected ${label} key address`);
}
async function record(report,tx,label) {
  const receipt=await tx.wait(1);
  if (!receipt || receipt.status!==1) throw new Error(`${label} transaction failed: ${tx.hash}`);
  report.transactions.push({step:label,hash:tx.hash,blockNumber:receipt.blockNumber,
    gasUsed:receipt.gasUsed.toString()});
  save(report);
}

const provider=new JsonRpcProvider(process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech',CHAIN_ID,
  {batchMaxCount:1,cacheTimeout:-1});
provider.pollingInterval=1000;
try {
  if (Number((await provider.getNetwork()).chainId)!==CHAIN_ID) throw new Error('RPC chain mismatch');
  const deployer=new Wallet(process.env.DEPLOYER_PRIVATE_KEY,provider);
  const buyer=new Wallet(process.env.BUYER_PRIVATE_KEY,provider);
  const seller=new Wallet(process.env.AGENT_PROVIDER_PRIVATE_KEY,provider);
  confirmAddress(deployer,PROJECT_DEPLOYER,'deployer');
  confirmAddress(buyer,PROJECT_BUYER,'project buyer');
  confirmAddress(seller,PROJECT_PROVIDER,'project provider');
  for (const address of [USDC,USDT,ROUTER,QUOTER,POOL])
    if (await provider.getCode(address)==='0x') throw new Error(`Missing contract code: ${address}`);
  const usdc=new Contract(USDC,ERC20,buyer);
  const sellerUsdc=new Contract(USDC,ERC20,seller);
  const usdt=new Contract(USDT,ERC20,buyer);
  const quoter=new Contract(QUOTER,QUOTER_ABI,provider);
  const router=new Contract(ROUTER,ROUTER_ABI,buyer);
  if (Number(await usdc.decimals())!==6 || Number(await usdt.decimals())!==6)
    throw new Error('Unexpected token decimals');
  const quote=await quoter.quoteExactInputSingle.staticCall({tokenIn:USDC,tokenOut:USDT,
    amountIn:SWAP_IN,fee:100,sqrtPriceLimitX96:0n});
  if (quote.amountOut<FUND+3000n) throw new Error('Swap quote has insufficient margin');
  const balances=async()=>({
    projectBuyerUSDC:await usdc.balanceOf(PROJECT_BUYER),
    projectBuyerUSDT:await usdt.balanceOf(PROJECT_BUYER),
    providerUSDC:await sellerUsdc.balanceOf(PROJECT_PROVIDER),
    buyerAgentUSDT:await usdt.balanceOf(BUYER_AGENT),
    projectBuyerOKB:await provider.getBalance(PROJECT_BUYER),
    providerOKB:await provider.getBalance(PROJECT_PROVIDER),
    deployerOKB:await provider.getBalance(PROJECT_DEPLOYER),
  });
  const before=await balances();
  console.log(JSON.stringify({network:'xlayer-mainnet',buyerAgent:BUYER_AGENT,
    quoteUSDT:formatUnits(quote.amountOut,6),fundUSDT:formatUnits(FUND,6),
    before:Object.fromEntries(Object.entries(before).map(([key,value])=>
      [key,key.endsWith('OKB')?formatEther(value):formatUnits(value,6)]))},null,2));
  if (!execute) process.exit(0);
  const report=existsSync(evidence)?JSON.parse(readFileSync(evidence,'utf8')):{
    checkedAt:new Date().toISOString(),chainId:CHAIN_ID,buyerAgentId:'13889',
    buyerAgentWallet:BUYER_AGENT,swapInUSDC:'0.105',fundUSDT:'0.100',transactions:[],
  };
  if (report.buyerAgentWallet.toLowerCase()!==BUYER_AGENT.toLowerCase())
    throw new Error('Funding journal has a different recipient');
  if (report.funded) {
    console.log(`Already funded; journal: ${evidence}`);
    process.exit(0);
  }
  if (before.buyerAgentUSDT>=FUND) {
    report.funded=true;
    report.completedAt=new Date().toISOString();
    save(report);
    console.log(`Buyer Agent already has at least 0.100 USDT; journal: ${evidence}`);
    process.exit(0);
  }
  const buyerGas=await provider.getBalance(PROJECT_BUYER);
  if (buyerGas<GAS_TARGET) {
    const needed=GAS_TARGET-buyerGas;
    if (await provider.getBalance(PROJECT_DEPLOYER)<needed+parseEther('0.001'))
      throw new Error('Deployer OKB reserve too low');
    await record(report,await deployer.sendTransaction({to:PROJECT_BUYER,value:needed}),
      'top-up-project-buyer-gas');
  }
  if (await usdt.balanceOf(PROJECT_BUYER)<FUND) {
    const buyerUsdc=await usdc.balanceOf(PROJECT_BUYER);
    if (buyerUsdc<SWAP_IN) {
      const needed=SWAP_IN-buyerUsdc;
      if (await sellerUsdc.balanceOf(PROJECT_PROVIDER)<needed)
        throw new Error('Project provider has insufficient USDC');
      if (await provider.getBalance(PROJECT_PROVIDER)<parseEther('0.0001'))
        throw new Error('Project provider has insufficient OKB gas reserve');
      await record(report,await sellerUsdc.transfer(PROJECT_BUYER,needed),
        'transfer-project-usdc-to-swap-wallet');
    }
    const allowance=await usdc.allowance(PROJECT_BUYER,ROUTER);
    if (allowance!==SWAP_IN) {
      if (allowance>0n) await record(report,await usdc.approve(ROUTER,0n),'reset-router-allowance');
      await record(report,await usdc.approve(ROUTER,SWAP_IN),'approve-exact-usdc');
    }
    const freshQuote=await quoter.quoteExactInputSingle.staticCall({tokenIn:USDC,tokenOut:USDT,
      amountIn:SWAP_IN,fee:100,sqrtPriceLimitX96:0n});
    const minimum=freshQuote.amountOut*9950n/10000n;
    if (minimum<FUND) throw new Error('Fresh swap quote cannot fund task after slippage');
    const params={tokenIn:USDC,tokenOut:USDT,fee:100,recipient:PROJECT_BUYER,
      amountIn:SWAP_IN,amountOutMinimum:minimum,sqrtPriceLimitX96:0n};
    if (await router.exactInputSingle.staticCall(params)<FUND)
      throw new Error('Swap simulation returned less than task amount');
    const gas=await router.exactInputSingle.estimateGas(params);
    await record(report,await router.exactInputSingle(params,{gasLimit:gas*12n/10n}),
      'swap-usdc-to-usdt0');
  }
  if (await usdt.balanceOf(PROJECT_BUYER)<FUND)
    throw new Error('Project buyer has insufficient USDT0 after swap');
  await record(report,await usdt.transfer(BUYER_AGENT,FUND),'fund-okx-ai-buyer-agent');
  const after=await balances();
  if (after.buyerAgentUSDT<FUND) throw new Error('Buyer Agent USDT0 balance did not increase enough');
  report.funded=true;
  report.completedAt=new Date().toISOString();
  report.after={buyerAgentUSDT:formatUnits(after.buyerAgentUSDT,6),
    projectBuyerUSDC:formatUnits(after.projectBuyerUSDC,6),
    projectBuyerUSDT:formatUnits(after.projectBuyerUSDT,6)};
  save(report);
  console.log(`Funded buyer Agent with 0.100 USDT0; journal: ${evidence}`);
} finally {
  provider.destroy();
}
