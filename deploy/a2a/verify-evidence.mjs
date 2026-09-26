// Internal A2A fact gathering: no x402 authorization or second charge.
import {verifyDelivery} from './protocol/verification.mjs';
try {
  const parts=[];let length=0;
  for await(const part of process.stdin){length+=part.length;if(length>32768)throw new Error('Input exceeds 32 KiB');parts.push(part);}
  const report=await verifyDelivery(JSON.parse(Buffer.concat(parts).toString()));
  console.log(JSON.stringify(report,null,2));
}catch(error){
  console.log(JSON.stringify({ok:false,error:error.name==='ZodError'?'Invalid verification input':String(error.message).slice(0,250)}));
  process.exitCode=1;
}
