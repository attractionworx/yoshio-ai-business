import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { executionFixture } from './fixtures/extraction-execution.js';
import { openaiExtractionFixture, stubExtraction, fictionalRows } from './fixtures/openai-extraction.js';
import { createExtractionService } from '../lib/offer-import/extraction-service.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { validateExtraction } from '../lib/offer-import/validation.js';
import { validationReasonCode, validationReasons } from '../lib/offer-import/validation-reasons.js';
import { extractionPages, makeDocuments } from '../lib/offer-import/extraction-pages.js';
async function diagnosticFixture(t) {
  const c = await executionFixture(t);
  c.value.documents = makeDocuments(fictionalRows());
  return c;
}

const mutations = {
  validation_schema: x => { x.schemaVersion = 2; },
  validation_candidate_conversion_key: x => { x.candidates[0].conversionKey = 'fictional_wrong_group'; },
  validation_evidence_reference: x => { x.candidates[0].evidence[0].documentId = 'missing-document'; },
  validation_evidence_range: x => { x.candidates[0].evidence[0].end += 1; },
  validation_quote_length_mismatch: x => { x.candidates[0].evidence[0].quote = 'fictional-mismatched-quote'; },
  validation_evidence_duplicate: x => { x.candidates[0].evidence.push(structuredClone(x.candidates[0].evidence[0])); },
  validation_secret: x => { x.candidates[0].text = 'Cookie: fictional-private-value'; },
};
for (const [code, mutate] of Object.entries(mutations)) {
  test(`validation diagnostics: fake ${code} is settled, terminal, sanitized and restart-compatible`, async t => {
    const c = await diagnosticFixture(t); const responseFor = input => { const x = stubExtraction(input); mutate(x); return x; };
    let calls = 0;
    const service = createExtractionService({ ...c.options, provider: {kind:'fake', async extract({input}) {calls++; return {extraction:responseFor(input),usage:{inputTokens:100,outputTokens:200}};} } });
    const offerBefore = await fs.readFile(path.join(c.root,'offers',c.offer.id+'.json'));
    const activationBefore = await fs.readFile(path.join(c.root,'ai-budget/activation.json'));
    const r = await c.run(service);
    assert.deepEqual(r.error,{code,phase:'validation'}); assert.equal(r.state,'failed_after_request'); assert.equal(r.revision,5);
    assert.equal(r.budget.state,'settled'); assert.equal(r.budget.bookedMilliYen,1); assert.equal(r.budget.reservedMilliYen,0);
    assert.equal(r.validatedArtifact,null); assert.equal(r.plannedImport,null); assert.equal(r.savedImport,null);
    assert.equal(calls,1); await assert.rejects(service.execute(r.id,r.revision)); assert.equal(calls,1);
    assert.deepEqual(await c.imports.list(),[]); assert.equal((await service.store.get(r.id)).error.code,code);
    const ledger = await fs.readFile(path.join(c.root,'extraction-executions/ledger.json'),'utf8');
    assert.ok(!ledger.includes('fictional-private-value')); assert.ok(!ledger.includes('fictional-mismatched-quote')); assert.ok(!ledger.includes('missing-document'));
    const artifacts = await fs.readdir(path.join(c.root,'extraction-artifacts')); assert.equal(artifacts.filter(n=>n.endsWith('.json')).length,1);
    assert.deepEqual(await fs.readFile(path.join(c.root,'offers',c.offer.id+'.json')),offerBefore);
    assert.deepEqual(await fs.readFile(path.join(c.root,'ai-budget/activation.json')),activationBefore);
  });
}
for (const [label,change,code] of [
  ['missing block',x=>{x.candidates[0].evidence[0].blockId='missing-block';},'validation_evidence_reference'],
  ['reversed range',x=>{x.candidates[0].evidence[0].start=x.candidates[0].evidence[0].end;},'validation_evidence_range'],
  ['negative start is schema failure',x=>{x.candidates[0].evidence[0].start=-1;},'validation_schema'],
  ['candidate target/category',x=>{x.candidates[1].purpose='fact';},'validation_candidate_prohibited'],
  ['management page',x=>{x.candidates[0].text='<html><body>fictional-private</body></html>';},'validation_secret'],
]) test(`validation diagnostics: ${label} preserves validation order`, async t => {
  const c=await diagnosticFixture(t); const x=stubExtraction(c.value); change(x);
  assert.throws(()=>validateExtraction(x,c.value.documents),error=>error.code===code && !error.message.includes('fictional-private'));
});
test('validation diagnostics: invalid immutable input gets its own reason without changed acceptance',async t=>{
  const c=await diagnosticFixture(t); const docs=structuredClone(c.value.documents); docs[0].textHash='0'.repeat(64);
  assert.throws(()=>validateExtraction(stubExtraction(c.value),docs),{code:'validation_input'});
});
test('validation diagnostics: malformed fake response envelope uses fixed response reason and books usage',async t=>{
  const c=await diagnosticFixture(t); const service=createExtractionService({...c.options,provider:{kind:'fake',async extract({input}){return{extraction:stubExtraction(input),usage:{inputTokens:100,outputTokens:200},extra:'fictional-raw-private'};}}});
  const r=await c.run(service); assert.equal(r.error.code,'validation_response'); assert.equal(r.budget.bookedMilliYen,1);
  assert.ok(!(await fs.readFile(path.join(c.root,'extraction-executions/ledger.json'),'utf8')).includes('fictional-raw-private'));
});
test('validation diagnostics: SDK stub quote failure UI, maintenance and unchanged legacy failure history',async t=>{
  const c=await openaiExtractionFixture(t,{respond:(_request,_options,input)=>{const x=stubExtraction(input);mutations.validation_quote_length_mismatch(x);return{status:'completed',output_text:JSON.stringify(x),usage:{input_tokens:1000,output_tokens:2000}};}});
  const r=await c.run(); assert.equal(r.error.code,'validation_quote_not_found'); assert.equal(r.budget.bookedMilliYen,176);
  const v=await c.service.preview(r.id); const views=extractionPages(x=>String(x)); const html=views.detail(v);
  assert.match(html,/理由（validation_quote_not_found）/); assert.match(html,/完全一致がありません/);
  assert.ok(!html.includes('fictional-mismatched-quote'));assert.ok(!html.includes('href="/offer-imports/'));assert.ok(!html.includes('name="token"'));
  for (const [code, explanation] of Object.entries(validationReasons)) {
    const classified = structuredClone(v); classified.record.error.code = code;
    const shown = views.detail(classified); assert.ok(shown.includes(`理由（${code}）`)); assert.ok(shown.includes(explanation));
  }
  const maintenance=createMaintenanceService(c.root,{now:c.now});
  const currentBackup=await maintenance.create(); assert.equal((await maintenance.dryRun(currentBackup.manifest.id)).status,'normal');
  const legacy=structuredClone(v); legacy.record.error.code='validation_failed';
  const old=views.detail(legacy); assert.match(old,/理由（validation_failed）/); assert.match(old,/詳細理由の記録はありません/); assert.ok(!old.includes('理由（validation_quote）'));
  const unknown=structuredClone(v); unknown.record.error.code='<script>fictional-secret</script>';
  const safe=views.detail(unknown); assert.ok(!safe.includes('fictional-secret'));assert.match(safe,/理由（validation_failed）/);
  const before=await fs.readFile(path.join(c.root,'extraction-executions/ledger.json')); const parsed=JSON.parse(before);
  parsed.executions[0].revisions.at(-1).error.code='validation_failed'; await fs.writeFile(path.join(c.root,'extraction-executions/ledger.json'),JSON.stringify(parsed));
  assert.equal((await c.store.get(r.id)).error.code,'validation_failed');
  const b=await maintenance.create();assert.equal((await maintenance.dryRun(b.manifest.id)).status,'normal');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c.root,'extraction-executions/ledger.json'))),parsed);
  assert.equal(c.sdkCalls.length,1);
});
test('validation diagnostics: reason codes are fixed safe vocabulary and never derive from raw errors',()=>{
  for(const code of Object.keys(validationReasons))assert.match(code,/^[a-z_]{1,60}$/);
  assert.equal(validationReasonCode('secret_rejected:fictional-body'),'validation_failed');assert.equal(validationReasonCode('constructor'),'validation_failed');
});
