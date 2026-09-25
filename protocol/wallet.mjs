import {createWalletClient, custom, defineChain, keccak256, toBytes} from 'viem';
import {x402Client} from '@x402/core/client';
import {ExactEvmScheme} from '@x402/evm/exact/client';
import {encodePaymentSignatureHeader} from '@x402/core/http';

export async function connectNetwork(network, injected=window.okxwallet || window.ethereum) {
  if(!injected)throw new Error('Connect an EVM wallet such as OKX Wallet or MetaMask.');
  const [account]=await injected.request({method:'eth_requestAccounts'});
  if(!account)throw new Error('The wallet did not return an account.');
  const chainId=`0x${network.chainId.toString(16)}`;
  if(BigInt(await injected.request({method:'eth_chainId'}))!==BigInt(chainId)) {
    try {await injected.request({method:'wallet_switchEthereumChain',params:[{chainId}]})}
    catch(error) {
      if(error.code!==4902 && error.data?.originalError?.code!==4902)throw error;
      await injected.request({method:'wallet_addEthereumChain',params:[{chainId,chainName:network.label,nativeCurrency:network.nativeCurrency,rpcUrls:[network.rpcUrl],...(network.explorer ? {blockExplorerUrls:[network.explorer]} : {})}]});
      await injected.request({method:'wallet_switchEthereumChain',params:[{chainId}]});
    }
  }
  if(BigInt(await injected.request({method:'eth_chainId'}))!==BigInt(chainId))throw new Error('Wallet network did not change.');
  return {account,injected};
}
export async function paymentSignature(required,expected,network,injected) {
  const selected=required.accepts?.[0];
  for(const key of ['scheme','network','amount','asset','payTo','maxTimeoutSeconds']) {
    if(String(selected?.[key]).toLowerCase()!==String(expected[key]).toLowerCase())throw new Error(`Payment quote changed (${key}); refresh before paying.`);
  }
  if(selected.extra?.name!==expected.extra.name || selected.extra?.version!==expected.extra.version || selected.extra?.assetTransferMethod!=='eip3009')throw new Error('Unexpected payment token domain.');
  const {account,injected:wallet}=await connectNetwork(network,injected);
  const chain=defineChain({id:network.chainId,name:network.label,nativeCurrency:network.nativeCurrency,rpcUrls:{default:{http:[network.rpcUrl]}}});
  const wc=createWalletClient({account,chain,transport:custom(wallet)});
  const signer={address:account,signTypedData:args=>wc.signTypedData({...args,account})};
  const client=new x402Client().register(expected.network,new ExactEvmScheme(signer))
    .setSpendControls({allowedAssets:[{network:expected.network,asset:expected.asset,maxAmountPerPayment:expected.amount}]});
  return encodePaymentSignatureHeader(await client.createPaymentPayload(required));
}

export function verifyResult(content, expectedHash) {
  if(keccak256(toBytes(content)).toLowerCase()!==expectedHash.toLowerCase())throw new Error('Result hash does not match the on-chain deliverable.');
  return JSON.parse(content);
}
export async function waitForReceipt(wallet,hash,{timeoutMs=120000,pollMs=1500,onMined=()=>{}}={}) {
  const until=Date.now()+timeoutMs;
  while(Date.now()<until) {
    const receipt=await wallet.request({method:'eth_getTransactionReceipt',params:[hash]});
    if(receipt) {
      onMined(receipt);
      if(BigInt(receipt.status)!==1n)throw new Error(`Transaction failed: ${hash}`);
      return receipt;
    }
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
  throw new Error('Transaction is still pending. Use “Check pending transaction” before sending another.');
}

export async function signLogin(injected,account,message) {
  try {return await injected.request({method:'personal_sign',params:[message,account]})}
  catch(error) {
    if(error.code===4001)throw error;
    return injected.request({method:'personal_sign',params:[account,message]});
  }
}

export async function signApplication(injected,account,typedData) {
  const domainFields=[
    {name:'name',type:'string'},{name:'version',type:'string'},
    {name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'},
  ];
  const payload={...typedData,types:{EIP712Domain:domainFields,...typedData.types}};
  return injected.request({method:'eth_signTypedData_v4',params:[account,JSON.stringify(payload)]});
}

export async function sendTransaction(injected,account,transaction,options={}) {
  const hash=await injected.request({method:'eth_sendTransaction',params:[{from:account,...transaction}]});
  const receipt=await waitForReceipt(injected,hash,options);
  return {hash,receipt};
}

export async function tokenBalance(injected,token,account,decimals=6) {
  const data=`0x70a08231${account.toLowerCase().slice(2).padStart(64,'0')}`;
  const raw=BigInt(await injected.request({method:'eth_call',params:[{to:token,data},'latest']}));
  const padded=raw.toString().padStart(decimals+1,'0');
  return {raw:raw.toString(),formatted:`${padded.slice(0,-decimals)}.${padded.slice(-decimals)}`.replace(/\.?0+$/,'') || '0'};
}

export function registeredAgentId(receipt,registry) {
  const topic=keccak256(toBytes('Registered(uint256,string,address)')).toLowerCase();
  const log=receipt?.logs?.find(item=>item.address?.toLowerCase()===registry.toLowerCase() && item.topics?.[0]?.toLowerCase()===topic);
  if(!log || !log.topics?.[1])throw new Error('Confirmed registration receipt did not contain a Registered event.');
  return BigInt(log.topics[1]).toString();
}
