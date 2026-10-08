import { executionFixture } from './extraction-execution.js';
import { createExtractionService, fakeExtractionConfig, extractionPrompt } from '../../lib/offer-import/extraction-service.js';
import { processingContract } from '../../lib/offer-import/evidence-resolution-v2.js';
import { bytesHash } from '../../lib/ai/safety-storage.js';
import { regulationFixture } from './regulation-import.js';
export const v5Instructions = extractionPrompt + '架空fixture専用。位置なしwire v3を返します。';
export const v5Config = { ...fakeExtractionConfig, version:'fictional-wire-v3',promptVersion:'fictional-wire-v3',promptHash:bytesHash(v5Instructions) };
export function wireV3Fixture(internal = regulationFixture().extraction) {
  const wire=structuredClone(internal);wire.schemaVersion=3;
  for(const c of wire.candidates)for(const e of c.evidence){delete e.start;delete e.end;}
  return wire;
}
export async function v5Fixture(t, {respond, ...options}={}) {
  const c=await executionFixture(t);const calls=[];
  const provider={kind:'fake',async extract(args){calls.push(structuredClone(args));return respond ? respond(args) : {extraction:wireV3Fixture(),usage:{inputTokens:100,outputTokens:200}};}};
  const reopen=extra=>createExtractionService({...c.options,provider,config:v5Config,simulationInstructions:v5Instructions,processing:processingContract(),...options,...extra});
  return {...c,calls,provider,service:reopen(),reopen};
}
