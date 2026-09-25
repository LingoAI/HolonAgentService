import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {logsInRange, logScanStart} from './logs.mjs';

test('log pagination covers inclusive boundaries once, orders results and limits concurrency', async () => {
  let active=0, peak=0;
  const ranges=[];
  const result=await logsInRange(async (from,to)=>{
    active++;peak=Math.max(peak,active);ranges.push([from,to]);
    await delay(from===42?5:0);active--;
    return Array.from({length:to-from+1},(_,i)=>from+i);
  },42,391);
  assert.deepEqual(ranges,[[42,141],[142,241],[242,341],[342,391]]);
  assert.deepEqual(result,Array.from({length:350},(_,i)=>i+42));
  assert.ok(peak<=3);
  assert.deepEqual(await logsInRange(()=>assert.fail('empty range'),5,4),[]);
  await assert.rejects(logsInRange(()=>[],0,500,2000),/Invalid/);
});
test('cached logs retain history only when their anchor is on the current chain', async () => {
  const cache={toBlock:300,anchorNumber:200,anchorHash:'canonical'};
  assert.equal(await logScanStart(50,350,cache,async()=>({hash:'canonical'})),201);
  assert.equal(await logScanStart(50,350,cache,async()=>({hash:'reorg'})),50);
  assert.equal(await logScanStart(50,150,cache,()=>assert.fail('rolled back chain')),50);
  assert.equal(await logScanStart(50,350,null,()=>assert.fail('no cache')),50);
});
