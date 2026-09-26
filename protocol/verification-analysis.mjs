import {verifyDelivery, VerificationUnavailable} from './verification.mjs';
import {evidenceForAnalysis, validateAnalysis} from './analysis-contract.mjs';

export function analysisConfiguration() {
  return {enabled:!!process.env.VERIFICATION_AI_URL,required:process.env.VERIFICATION_AI_REQUIRED==='1',
    role:'Advisory explanation of deterministic evidence; never changes checks or verdicts.'};
}

export async function explainReport(report, {request=fetch, configuration=analysisConfiguration()}={}) {
  if (!configuration.enabled) {
    if (configuration.required) throw new VerificationUnavailable('AI explanation is unavailable; no payment settled');
    return {...report,analysis:{available:false,reason:'AI explanation is not configured'}};
  }
  const evidence=evidenceForAnalysis(report);
  try {
    const response=await request(process.env.VERIFICATION_AI_URL, {method:'POST',redirect:'error',
      signal:AbortSignal.timeout(35000),headers:{'Content-Type':'application/json',
        'X-Analysis-Token':process.env.VERIFICATION_AI_TOKEN || ''},body:JSON.stringify(evidence)});
    if (!response.ok) throw new Error('AI service unavailable');
    const raw=await response.text();
    if (Buffer.byteLength(raw)>32768) throw new Error('AI response too large');
    const result=JSON.parse(raw);
    const analysis=validateAnalysis(result.analysis,evidence);
    const interpretation={method:'ai',provider:'Codex',model:String(result.model || 'runtime-default').slice(0,80),
      advisory:true,generatedAt:new Date().toISOString(),...analysis};
    return {...report,deterministicInterpretation:report.interpretation,interpretation,
      markdown:report.markdown+'\n\n## AI explanation (advisory)\n\n'+analysis.summary+'\n\n'+
        analysis.findings.map(item=>`${item.explanation}\n\nEvidence: ${item.references.join(', ')}. Next check: ${item.nextStep}`).join('\n\n')+
        '\n\n'+analysis.limitations.map(text=>'- '+text).join('\n')};
  } catch {
    // Do not silently charge for a promised AI report when inference is down.
    throw new VerificationUnavailable('AI explanation is unavailable or could not be grounded in the evidence; no payment settled');
  }
}

export async function verifyAndExplain(input, dependencies={}) {
  return explainReport(await verifyDelivery(input,dependencies),dependencies);
}
