import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { extractionProfile, profileConfiguration } from '../lib/ai/extraction-profile.js';
import { buildExtractionPayload, estimateExtractionInput, fixedJSON } from '../lib/ai/extraction-payload.js';
import { createOpenAIExtractionProvider } from '../lib/ai/openai-extraction-provider.js';
import { createExtractionService } from '../lib/offer-import/extraction-service.js';
import { createExecutionGate } from '../lib/offer-import/execution-gate.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { projectReflection } from '../lib/offer-import/projection.js';
import { createOfferImport } from '../lib/offer-import/contract.js';
import { costMilliYen } from '../lib/ai/budget-coordinator.js';
import { digest } from '../lib/ai/safety-storage.js';
import { hashDocumentText, validateExtraction } from '../lib/offer-import/validation.js';
import { makeDocuments } from '../lib/offer-import/extraction-pages.js';
import { requestDigest } from '../lib/offer-import/execution-contract.js';
import { openaiExtractionFixture, fictionalRows, stubExtraction } from './fixtures/openai-extraction.js';
import { fixtureBudgetPolicy } from './fixtures/ai-budget.js';
import { blockedConnections } from './helpers/network-guard.js';

test('6-1: canonical payload deterministic across object key order, includes all outbound fields', () => {
  const docs = makeDocuments(fictionalRows()); const input = { targetOffer: { id:'fictional', revision:1 }, documents: docs };
  const a = buildExtractionPayload(input, extractionProfile); const b = buildExtractionPayload({ documents: docs, targetOffer: { revision:1,id:'fictional' } }, extractionProfile);
  assert.equal(fixedJSON(a),fixedJSON(b)); assert.equal(digest(a),digest(b)); assert.deepEqual(JSON.parse(a.input),input);
  assert.equal(a.store,false); assert.equal(a.service_tier,'default'); assert.deepEqual(a.tools,[]); assert.equal(a.max_output_tokens,10000); assert.equal(a.text.format.strict,true);
  assert.equal(a.model,'gpt-6-luna'); assert.equal(a.instructions,extractionProfile.instructions);
  assert.ok(Object.isFrozen(extractionProfile)); assert.ok(Object.isFrozen(extractionProfile.outputSchema.$defs.payload.properties));
});
for (const field of ['model','pricing','exchange','builderHash','instructions','outputSchema','estimator','maxInputTokens','maxOutputTokens','providerHash']) test(`6-1: ${field} profile change changes configuration/request hash`, () => {
  const altered = structuredClone(extractionProfile);
  if (typeof altered[field] === 'number') altered[field]++;
  else if (typeof altered[field] === 'string') altered[field] += '-changed';
  else altered[field].version = 'changed';
  const a=profileConfiguration(), b=profileConfiguration(altered);
  assert.notEqual(a.version,b.version); assert.notEqual(digest(a),digest(b));
  assert.notEqual(requestDigest('a'.repeat(64),a,'openai',extractionProfile.model),requestDigest('a'.repeat(64),b,'openai',altered.model));
});
test('6-1: wire schema preserves enum/required/bounds/evidence and existing v1 semantics', async () => {
  const source = JSON.parse(await fs.readFile(new URL('../schemas/regulation-extraction.schema.json',import.meta.url)));
  const wire = extractionProfile.outputSchema;
  const strip = v => Array.isArray(v) ? v.map(strip) : v && typeof v==='object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !['$schema','title','description','type'].includes(k)).map(([k,x])=>[k,strip(x)])) : v;
  assert.deepEqual(strip(wire),strip(source)); assert.equal(wire.properties.schemaVersion.type,'integer'); assert.equal(wire.$defs.payload.properties.target.type,'string');
});
test('6-1: estimate covers instructions, metadata and schema; max reservation exactly 1.824 yen', async t => {
  const c=await openaiExtractionFixture(t); const r=await c.prepare(); const v=await c.service.preview(r.id);
  const B=Buffer.byteLength(fixedJSON(v.payload)); assert.equal(r.estimate.inputTokens,2*B+8192); assert.equal(v.requestBytes,B);
  assert.ok(r.estimate.inputTokens>2*Buffer.byteLength(c.value.documents.map(d=>d.text).join(''))+8192);
  assert.equal(r.estimate.maximumReservedMilliYen,1824); assert.equal(r.estimate.estimatedMilliYen,costMilliYen({inputTokens:r.estimate.inputTokens,outputTokens:10000},r.configuration));
  assert.equal(c.sdkCalls.length,0);
});
test('6-1: over 64k rejected before artifact/ledger/provider; no split or truncation', async t => {
  const c=await openaiExtractionFixture(t); const value={ ...c.value,documents:makeDocuments([{...fictionalRows()[0],text:'架空'.repeat(15000)}]) };
  assert.ok(estimateExtractionInput(buildExtractionPayload(value,extractionProfile),extractionProfile).inputTokens>64000);
  await assert.rejects(c.service.prepare(value),{code:'input_limit'}); assert.equal(c.sdkCalls.length,0); assert.equal((await c.store.read()).executions.length,0);
  await assert.rejects(fs.lstat(path.join(c.root,'extraction-artifacts')),{code:'ENOENT'});
});
test('6-1: multiple documents have deterministic IDs/hash/UTF16 blocks including emoji and newlines', () => {
  const rows=fictionalRows(); rows[0].text='架空😀\r\n末尾'; const a=makeDocuments(rows); assert.deepEqual(a,makeDocuments(rows));
  assert.equal(a[0].blocks[0].end,rows[0].text.length); assert.equal(a[0].textHash,hashDocumentText(rows[0].text)); assert.notEqual(a[0].id,a[1].id);
});
test('6-1: original caller mutation cannot change immutable prepared input or sent payload', async t => {
  const c=await openaiExtractionFixture(t); const original=structuredClone(c.value); const r=await c.prepare(); c.value.documents[0].text='changed caller';
  const v=await c.service.preview(r.id); assert.deepEqual(v.input,original); const result=await c.service.approveAndExecute(r.id,v.token,{confirm:true});
  assert.equal(result.state,'succeeded'); assert.equal(fixedJSON(c.sdkCalls[0].request),fixedJSON(v.payload));
});
test('6-1: explicit approval required, signed token cannot cross execution or survive restart', async t => {
  const c=await openaiExtractionFixture(t); const r=await c.prepare(); const v=await c.service.preview(r.id);
  await assert.rejects(c.service.approveAndExecute(r.id,v.token,{confirm:false}),{code:'approval_required'});
  await assert.rejects(c.service.approveAndExecute(r.id,v.token+'x',{confirm:true}),{code:'approval_conflict'});
  const restarted=createExtractionService({...c.options,provider:c.provider}); await assert.rejects(restarted.approveAndExecute(r.id,v.token,{confirm:true}));
  const other=structuredClone(c.value); other.documents[0].label+='別版'; const q=await c.service.prepare(other);
  await assert.rejects(c.service.approveAndExecute(q.id,v.token,{confirm:true})); assert.equal(c.sdkCalls.length,0);
});
test('6-1: null effective real policy blocks approval without reserving or requesting', async t => {
  const c=await openaiExtractionFixture(t,{policy:{...fixtureBudgetPolicy,realStopMilliYen:null}}); const r=await c.prepare(); const v=await c.service.preview(r.id);
  assert.equal(v.token,null); assert.equal(v.budget.effectivePolicy.realStopMilliYen,null); assert.equal(v.budget.reason,'budget_policy_unavailable');
  await assert.rejects(c.service.approve(r.id,1,{confirm:true,requestHash:r.requestHash}),{code:'budget_policy_unavailable'});
  assert.equal((await c.store.get(r.id)).budget.reservedMilliYen,0); assert.equal(c.sdkCalls.length,0);
});
test('6-1: absent credentials block before reserve, no environment lookup', async t => {
  const c=await openaiExtractionFixture(t); const s=createExtractionService({...c.options,provider:createOpenAIExtractionProvider()}); const r=await s.prepare(c.value);
  assert.equal((await s.preview(r.id)).blocked,'provider_unavailable'); await assert.rejects(s.approve(r.id,1,{confirm:true,requestHash:r.requestHash}),{code:'provider_unavailable'});
  assert.equal((await c.store.get(r.id)).state,'prepared');
});
test('6-1: SDK success after durable sending books real usage, creates only pending/unverified', async t => {
  const c=await openaiExtractionFixture(t); const r=await c.run(); assert.equal(r.state,'succeeded'); assert.equal(c.sdkCalls.length,1);
  assert.equal(c.sdkCalls[0].options.maxRetries,0); assert.equal(c.sdkCalls[0].options.timeout,120000); assert.ok(c.sdkCalls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(r.budget.usage,{inputTokens:1000,outputTokens:2000}); assert.equal(r.budget.bookedMilliYen,176); assert.equal(r.budget.reservedMilliYen,0);
  const budget=await c.coordinator.state(); assert.equal(budget.totals.real.bookedMilliYen,176); assert.equal(budget.totals.simulation.bookedMilliYen,0);
  const imported=await c.imports.get(r.savedImport.id); assert.equal(imported.documents.length,2);
  for (const candidate of imported.candidates) { assert.equal(candidate.review.decision,'pending'); assert.equal(candidate.review.verification,'unverified'); }
  assert.equal((await c.offers.get(c.offer.id)).revision,1); assert.equal((await c.offers.get(c.offer.id)).status,'draft');
  await createExecutionGate(c.root)(r.savedImport.id,(await c.imports.history(r.savedImport.id))[0]);
});
for (const defect of ['json','schema','source_checked','adopt','quote','secret','incomplete','refused']) test(`6-1: ${defect} response books known usage and creates no partial import`, async t => {
  const c=await openaiExtractionFixture(t,{respond:(_request,_options,input)=>{
    const extraction=stubExtraction(input); let output=JSON.stringify(extraction); let status='completed';
    if(defect==='json') output='{ invalid fictional JSON'; if(defect==='schema') output='{"schemaVersion":2,"candidates":[]}';
    if(defect==='source_checked') {extraction.candidates[0].verification='source_checked';output=JSON.stringify(extraction);}
    if(defect==='adopt') {extraction.candidates[0].decision='accepted';output=JSON.stringify(extraction);}
    if(defect==='quote') {extraction.candidates[0].evidence[0].quote='does not match';output=JSON.stringify(extraction);}
    if(defect==='secret') {extraction.candidates[0].text='Cookie: fictional-secret';output=JSON.stringify(extraction);}
    if(defect==='incomplete') status='incomplete'; if(defect==='refused') output=undefined;
    return {status,output_text:output,usage:{input_tokens:1000,output_tokens:2000}};
  }});
  const r=await c.run(); assert.equal(r.state,'failed_after_request'); assert.equal(r.budget.bookedMilliYen,176); assert.equal(r.budget.reservedMilliYen,0); assert.equal(c.sdkCalls.length,1); assert.deepEqual(await c.imports.list(),[]);
});
for (const defect of ['timeout','connection','401','missing_usage','usage_limit','processing_tier']) test(`6-1: ${defect} unknown keeps reservation and blocks generation/extraction`, async t => {
  const c=await openaiExtractionFixture(t,{respond:()=>{
    if(['timeout','connection','401'].includes(defect)) throw Object.assign(new Error('fictional private raw error'),{name:defect==='timeout'?'APIConnectionTimeoutError':'Error',status:defect==='401'?401:undefined});
    return {status:'completed',service_tier:defect==='processing_tier'?'priority':'default',output_text:'{}',usage:defect==='missing_usage'?null:{input_tokens:64001,output_tokens:1}};
  }});
  const r=await c.run(); assert.equal(r.state,'unknown'); assert.equal(r.budget.reservedMilliYen,1824); assert.equal(r.budget.bookedMilliYen,0);
  assert.equal((await c.service.status(r.id)).externalRetryAllowed,false); await assert.rejects(c.generation.execute(c.plan,c.generation.confirmation(c.plan)),{code:'ai_in_progress'});
  const second=structuredClone(c.value);second.documents[0].label+='別版';const q=await c.service.prepare(second);
  await assert.rejects(c.service.approve(q.id,1,{confirm:true,requestHash:q.requestHash}),{code:'ai_in_progress'}); assert.equal(c.sdkCalls.length,1);
});
test('6-1: double click and concurrent generation never issue a second SDK request', async t => {
  let release;let started;const called=new Promise(r=>{started=r;});
  const c=await openaiExtractionFixture(t,{respond:(_request,_options,input)=>{started();return new Promise(resolve=>{release=()=>resolve({status:'completed',output_text:JSON.stringify(stubExtraction(input)),usage:{input_tokens:1000,output_tokens:2000}});});}});
  const r=await c.prepare();const v=await c.service.preview(r.id);const first=c.service.approveAndExecute(r.id,v.token,{confirm:true});await called;
  await assert.rejects(c.service.approveAndExecute(r.id,v.token,{confirm:true})); await assert.rejects(c.generation.execute(c.plan,c.generation.confirmation(c.plan)),{code:'ai_in_progress'});
  release();assert.equal((await first).state,'succeeded');assert.equal(c.sdkCalls.length,1);await assert.rejects(c.service.execute(r.id,2));
});
test('6-1: 120000ms service deadline aborts SDK and leaves unknown reservation', async t => {
  let started; const called = new Promise(resolve=>{started=resolve;});
  const c=await openaiExtractionFixture(t,{respond:(_request,options)=>{started(options.signal);return new Promise(()=>{});}});
  const r=await c.prepare();const v=await c.service.preview(r.id);
  t.mock.timers.enable({apis:['setTimeout']});
  const execution=c.service.approveAndExecute(r.id,v.token,{confirm:true});const signal=await called;
  t.mock.timers.tick(120000);const result=await execution;assert.equal(signal.aborted,true);assert.equal(result.state,'unknown');assert.equal(result.budget.reservedMilliYen,1824);assert.equal(c.sdkCalls.length,1);
});
test('6-1: two extraction executions cannot reserve/send concurrently',async t=>{
  let release,started;const called=new Promise(resolve=>{started=resolve;});
  const c=await openaiExtractionFixture(t,{respond:(_request,_options,input)=>{started();return new Promise(resolve=>{release=()=>resolve({status:'completed',output_text:JSON.stringify(stubExtraction(input)),usage:{input_tokens:1000,output_tokens:2000}});});}});
  const first=await c.prepare();const secondInput=structuredClone(c.value);secondInput.documents[0].label+='別版';const second=await c.service.prepare(secondInput);
  const view=await c.service.preview(first.id);const pending=c.service.approveAndExecute(first.id,view.token,{confirm:true});await called;
  await assert.rejects(c.service.approve(second.id,1,{confirm:true,requestHash:second.requestHash}),{code:'ai_in_progress'});assert.equal(c.sdkCalls.length,1);release();assert.equal((await pending).state,'succeeded');
});
test('6-1: expired confirmation and changed offer revision prevent SDK calls',async t=>{
  let time=Date.parse('2026-10-04T01:00:00.000Z');const c=await openaiExtractionFixture(t,{now:()=>new Date(time)});const r=await c.prepare();const view=await c.service.preview(r.id);
  time+=15*60*1000;await assert.rejects(c.service.approveAndExecute(r.id,view.token,{confirm:true}),{code:'approval_conflict'});
  const approved=await c.service.approve(r.id,1,{confirm:true,requestHash:r.requestHash});const input=structuredClone(c.offer);for(const key of ['id','schemaVersion','revision','createdAt','updatedAt'])delete input[key];input.name+='更新';
  await c.offers.update(c.offer.id,1,input);const result=await c.service.execute(r.id,approved.revision);assert.equal(result.state,'failed_before_request');assert.equal(c.sdkCalls.length,0);
});
test('6-1: config changed after approval stops proven-unsent and releases reservation', async t => {
  const c=await openaiExtractionFixture(t);const r=await c.prepare();const approved=await c.service.approve(r.id,1,{confirm:true,requestHash:r.requestHash});
  const file=path.join(c.root,'extraction-executions/ledger.json');const ledger=JSON.parse(await fs.readFile(file));
  for(const row of ledger.executions[0].revisions){row.configuration.version+='-changed';const {hash,...cfg}=row.configuration;row.configuration.hash=digest(cfg);row.requestHash=requestDigest(row.inputArtifact.hash,row.configuration,row.provider,row.model);if(row.approval)row.approval.hash=row.requestHash;}
  await fs.writeFile(file,JSON.stringify(ledger));const stopped=await c.service.execute(r.id,approved.revision);assert.equal(stopped.state,'failed_before_request');assert.equal(stopped.budget.reservedMilliYen,0);assert.equal(c.sdkCalls.length,0);
});
test('6-1: immutable artifact tampering after approval never invokes SDK', async t => {
  const c=await openaiExtractionFixture(t);const r=await c.prepare();const approved=await c.service.approve(r.id,1,{confirm:true,requestHash:r.requestHash});
  const file=path.join(c.root,'extraction-artifacts',r.inputArtifact.id+'.json');await fs.writeFile(file,'{}');const result=await c.service.execute(r.id,approved.revision);
  assert.equal(result.state,'failed_before_request');assert.equal(c.sdkCalls.length,0);
});
test('6-1: import save-only recovery retains planned ID, calls SDK only once', async t => {
  let failed=true;const c=await openaiExtractionFixture(t,{serviceOptions:{fault:async phase=>{if(failed&&phase==='before_import_save'){failed=false;throw new Error('fictional disk failure');}}}});
  const r=await c.run();assert.equal(r.state,'import_save_failed');assert.equal(c.sdkCalls.length,1);
  const saved=await c.service.recover(r.id,r.revision,{confirm:true,operation:'save_only'});assert.equal(saved.state,'succeeded');assert.equal(saved.savedImport.id,r.plannedImport.id);assert.equal(c.sdkCalls.length,1);
});
test('6-1: saved import stays review-blocked until execution result finalized', async t => {
  const c=await openaiExtractionFixture(t,{serviceOptions:{fault:async phase=>{if(phase==='before_result')throw new Error('fictional');}}});const r=await c.run();
  const gate=createExecutionGate(c.root);const first=(await c.imports.history(r.plannedImport.id))[0];await assert.rejects(gate(first.id,first),{code:'execution_unresolved'});
  const done=await c.service.recover(r.id,r.revision,{confirm:true,operation:'finalize_result'});await gate(done.savedImport.id,first);assert.equal(c.sdkCalls.length,1);
});
test('6-1: mixed origin evidence is preserved but existing reflection excludes it', async t => {
  const c=await openaiExtractionFixture(t);const extraction=stubExtraction(c.value);extraction.candidates[0].evidence.push(extraction.candidates[1].evidence[0]);
  const created=await c.imports.create({ ...c.value, extraction });const reviewed=await c.imports.review(created.id,'candidate-1',1,{decision:'accepted',edited:null,sourceChecked:true,reason:''});
  const plan=projectReflection(reviewed,c.offer,{offerId:c.offer.id,conversions:[]});assert.equal(plan.mappings.length,0);assert.ok(plan.excluded.some(x=>x.reason.includes('複数の提供元')));
});
for(const text of ['Cookie: fictional-secret','password=fictional-secret','<html><body>管理画面</body></html>','管理画面 ログアウト'])test(`6-1: privacy/secret input rejected before request ${text.slice(0,12)}`,async t=>{
  const c=await openaiExtractionFixture(t);const rows=fictionalRows();rows[0].text=text;
  await assert.rejects(async()=>c.service.prepare({...c.value,documents:makeDocuments(rows)}));assert.equal(c.sdkCalls.length,0);assert.equal((await c.store.read()).executions.length,0);
});
test('6-1: real execution/input/profile/usage consistent in maintenance v2 backup and dry-run',async t=>{
  const c=await openaiExtractionFixture(t);await c.run();const m=createMaintenanceService(c.root,{now:c.now});assert.equal((await m.integrity()).status,'normal');
  const backup=await m.create();assert.equal(backup.manifest.schemaVersion,2);const dry=await m.dryRun(backup.manifest.id);assert.equal(dry.status,'normal');assert.equal(dry.report.metrics.extractionExecutions,1);
});
test('6-1: all tests make zero external connection attempts',()=>assert.equal(blockedConnections.length,0));
