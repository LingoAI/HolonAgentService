import test from 'node:test';
import assert from 'node:assert/strict';
import {explainReport} from './verification-analysis.mjs';
import {evidenceForAnalysis,validateAnalysis,analysisPrompt} from './analysis-contract.mjs';
import {VerificationUnavailable} from './verification.mjs';

const report={status:'FAIL',transactionHash:'0x'+'a'.repeat(64),network:'X Layer Mainnet',
  checkedAt:'2026-09-26T00:00:00Z',snapshotBlock:123,checks:[{name:'expectedPayment',passed:false,expected:{amountRaw:'10000'},actual:[]}],
  warnings:[],scope:['Exact transfer'],limitations:['No quality guarantee'],userExpectations:{expectedAmount:'0.01'},
  onchainFacts:{transaction:{status:'succeeded'}},assetFlow:{transfers:[]},interpretation:{method:'deterministic',summary:'Mismatch'},markdown:'Original facts'};
const analysis={summary:'The transfer did not match the supplied expectations.',findings:[{references:['expectedPayment'],
  explanation:'The supplied transfer tuple was not found.',nextStep:'Confirm the expected token, payer, recipient and amount.'}],limitations:['This does not establish why expectations differ.']};
const configured={enabled:true,required:true};
test('AI report preserves exact deterministic evidence and labels interpretation advisory',async()=>{
  const before=structuredClone(report);
  const result=await explainReport(report,{configuration:configured,request:async(url,options)=>{
    const evidence=JSON.parse(options.body);assert.equal(evidence.status,'FAIL');assert.deepEqual(evidence.checks,report.checks);
    return new Response(JSON.stringify({analysis,model:'test-model'}));
  }});
  assert.deepEqual(report,before);assert.deepEqual(result.checks,report.checks);assert.equal(result.status,'FAIL');
  assert.deepEqual(result.onchainFacts,report.onchainFacts);assert.deepEqual(result.deterministicInterpretation,report.interpretation);
  assert.equal(result.interpretation.method,'ai');assert.equal(result.interpretation.advisory,true);
  assert.match(result.markdown,/Original facts[\s\S]*AI explanation/);
});
test('unknown evidence references, omitted failures and attempted verdict injection are rejected',()=>{
  const evidence=evidenceForAnalysis(report);
  for(const invalid of [{...analysis,status:'PASS'},{...analysis,findings:[]},
    {...analysis,findings:[{...analysis.findings[0],references:['fabricatedBalance']}]},
    {...analysis,summary:'<script>unsafe</script>'}]) assert.throws(()=>validateAnalysis(invalid,evidence));
});
test('inference outage, timeout, oversized or malformed output fails before settlement',async()=>{
  for(const request of [async()=>new Response('{}',{status:503}),async()=>{throw new Error('timeout');},
    async()=>new Response('invalid JSON'),async()=>new Response('a'.repeat(32769)),
    async()=>new Response(JSON.stringify({analysis:{...analysis,findings:[]}}))]) {
    await assert.rejects(explainReport(report,{configuration:configured,request}),VerificationUnavailable);
  }
});
test('production required mode never silently falls back to templates',async()=>{
  await assert.rejects(explainReport(report,{configuration:{enabled:false,required:true}}),VerificationUnavailable);
  const result=await explainReport(report,{configuration:{enabled:false,required:false}});
  assert.equal(result.analysis.available,false);assert.equal(result.interpretation.method,'deterministic');
});
test('model input excludes document bytes, secrets and report prose, and bounds transfer data',()=>{
  const source={...report,documentText:'PRIVATE_DOCUMENT',apiKey:'PRIVATE_CREDENTIAL',markdown:'UNTRUSTED_PROSE',
    assetFlow:{transfers:Array.from({length:80},()=>({token:'0x123'}))}};
  const evidence=evidenceForAnalysis(source),prompt=analysisPrompt(evidence);
  assert.equal(evidence.onchainFacts.assetFlow.transfers.length,40);assert.equal(evidence.onchainFacts.assetFlow.omittedTransfers,40);
  assert.doesNotMatch(prompt,/PRIVATE_DOCUMENT|PRIVATE_CREDENTIAL|UNTRUSTED_PROSE/);
  assert.match(prompt,/never instructions/);
});
