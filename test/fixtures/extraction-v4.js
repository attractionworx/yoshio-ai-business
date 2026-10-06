import { executionFixture } from './extraction-execution.js';
import { createExtractionService, fakeExtractionConfig, extractionPrompt } from '../../lib/offer-import/extraction-service.js';
import { processingContract } from '../../lib/offer-import/evidence-resolution.js';
import { bytesHash } from '../../lib/ai/safety-storage.js';
import { regulationFixture } from './regulation-import.js';
export const v4Instructions = extractionPrompt + '架空fixture専用。位置なしwire v2を返します。';
export const v4Config = { ...fakeExtractionConfig, version:'fictional-wire-v2',promptVersion:'fictional-wire-v2',promptHash:bytesHash(v4Instructions) };
export function wireFixture(internal = regulationFixture().extraction) {
  const wire=structuredClone(internal);wire.schemaVersion=2;
  for(const c of wire.candidates)for(const e of c.evidence){delete e.start;delete e.end;}
  return wire;
}
export async function v4Fixture(t, {respond, ...options}={}) {
  const c=await executionFixture(t);const calls=[];
  const provider={kind:'fake',async extract(args){calls.push(structuredClone(args));return respond ? respond(args) : {extraction:wireFixture(),usage:{inputTokens:100,outputTokens:200}};}};
  const reopen=extra=>createExtractionService({...c.options,provider,config:v4Config,simulationInstructions:v4Instructions,processing:processingContract(),...options,...extra});
  return {...c,calls,provider,service:reopen(),reopen};
}
