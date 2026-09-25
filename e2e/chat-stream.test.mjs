import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../frontend/js/stream.js', import.meta.url), 'utf8');
const { streamChat } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const enc = new TextEncoder();
async function run(chunks, {status = 200, type = 'text/event-stream', signal} = {}) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({start(c) {chunks.forEach(x => c.enqueue(typeof x === 'string' ? enc.encode(x) : x)); c.close();}}), {status, headers:{'content-type':type}});
  try {
    const result = await streamChat('synthetic', {signal, onToken:t=>seen.push(['token',t]), onDone:()=>seen.push(['done']), onError:e=>seen.push(['error',e])});
    return {result, seen};
  } finally { globalThis.fetch = original; }
}
test('UTF8 split at every byte and CRLF split across chunks', async () => {
  const bytes = enc.encode('event:token\r\ndata:"你好🌱"\r\n\r\nevent:done\r\ndata:{}\r\n\r\n');
  const {result,seen} = await run(Array.from(bytes,b=>new Uint8Array([b])));
  assert.equal(result.status,'done'); assert.deepEqual(seen,[['token','你好🌱'],['done']]);
});
test('multiline data and heartbeat', async () => {
  const {seen} = await run([': heartbeat\nevent: token\ndata: "Hi"\n\nevent: done\ndata: {\ndata: }\n\n']);
  assert.deepEqual(seen,[['token','Hi'],['done']]);
});
test('CR line endings', async () => assert.equal((await run(['event:done\rdata:{}\r\r'])).result.status,'done'));
test('provider error is terminal even if an old server sends done and tokens afterward', async () => {
  const {result,seen}=await run(['event: token\ndata: "Partial"\n\nevent: error\ndata: "Unavailable"\n\nevent: done\ndata: {}\n\nevent: token\ndata: "Wrong"\n\n']);
  assert.equal(result.status,'error'); assert.deepEqual(seen,[['token','Partial'],['error','Unavailable']]);
});
test('early EOF preserves partial and fails once',async()=>{
  const {result,seen}=await run(['event: token\ndata: "Partial"\n\n']);
  assert.equal(result.status,'error'); assert.equal(seen[0][1],'Partial'); assert.equal(seen.filter(e=>e[0]==='error').length,1);
});
test('malformed JSON handled once without throwing',async()=>{
  const {result,seen}=await run(['event: token\ndata: nope\n\n']); assert.equal(result.status,'error'); assert.equal(seen.length,1);
});
test('invalid token shape rejected',async()=>assert.equal((await run(['event:token\ndata:{}\n\n'])).result.status,'error'));
test('wrong content type and non-OK status cannot look successful',async()=>{
  assert.equal((await run(['<html>login</html>'],{type:'text/html'})).result.status,'error');
  assert.deepEqual((await run(['denied'],{status:401})).seen,[['error','HTTP 401']]);
});
test('abort is a separate terminal result without failure callback',async()=>{
  const c=new AbortController();c.abort();const {result,seen}=await run([],{signal:c.signal});assert.equal(result.status,'aborted');assert.deepEqual(seen,[]);
});
test('invalid UTF8 fails without rendering replacement characters',async()=>assert.equal((await run([new Uint8Array([255])])).result.status,'error'));
