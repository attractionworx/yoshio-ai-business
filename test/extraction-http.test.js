import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server.js';
import { openaiExtractionFixture, fictionalRows } from './fixtures/openai-extraction.js';
import { parseExtractionForm, makeDocuments, extractionFailureContext, extractionPages } from '../lib/offer-import/extraction-pages.js';
import { createArtifactStore } from '../lib/offer-import/extraction-artifacts.js';
import { fixtureBudgetPolicy } from './fixtures/ai-budget.js';
import { capture, snapshotHash } from '../lib/maintenance/snapshot.js';

export function extractionForm(c) {
  const form=new URLSearchParams({offerId:c.offer.id,offerRevision:String(c.offer.revision)});
  fictionalRows().forEach((row,i)=>Object.entries(row).forEach(([key,value])=>form.set(`documents.${i}.${key}`,value)));
  return form;
}
async function fixture(t,options={}) {
  const c=await openaiExtractionFixture(t,options);
  const app=createApp({dataDirectory:c.root,generationOptions:{now:c.now},extractionOptions:{provider:c.provider,...options.serviceOptions}});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(r=>app.close(r)));const base=`http://127.0.0.1:${app.address().port}`;
  const post=(url,form,headers={})=>fetch(base+url,{method:'POST',headers:{Origin:base,...headers},body:form,redirect:'manual'});
  const prepare=async()=>{const response=await post('/offer-extractions/prepare',extractionForm(c));assert.equal(response.status,303);return response.headers.get('location');};
  return {...c,app,base,post,httpPrepare:prepare};
}
test('6-1 HTTP: offer/draft intake, immutable prepare, complete escaped confirmation, explicit send and review',async t=>{
  const c=await fixture(t);const before=snapshotHash(await capture(c.root));
  const offers=await(await fetch(c.base+'/offers')).text();assert.match(offers,/資料から登録候補を作る/);
  const intake=await fetch(c.base+`/offer-extractions/new?offerId=${c.offer.id}`);const html=await intake.text();assert.equal(intake.status,200);assert.match(html,/\/offers\/new/);assert.match(html,/documents\.1\.text/);assert.ok(!html.includes('type="file"'));
  assert.equal(snapshotHash(await capture(c.root)),before);const location=await c.httpPrepare();assert.equal(c.sdkCalls.length,0);
  const response=await fetch(c.base+location);const confirmation=await response.text();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/form-action 'self'/);
  for(const label of ['対象案件','metadata','extraction instructions','output schema','gpt-6-luna','推定input tokens','最大output tokens','最大予約額','pricing version','為替version','profile','configuration hash','request hash','immutable input artifact','共通real budget','今回予約後の判定','privacy'])assert.ok(confirmation.includes(label),label);
  assert.match(confirmation,/1\.824円/);assert.match(confirmation,/pending|明示|承認/);assert.ok(!confirmation.includes(' checked'));assert.ok(!confirmation.includes('<html><body>'));
  const token=confirmation.match(/name="token" value="([^"]+)"/)[1];
  assert.equal((await c.post(location+'/approve',new URLSearchParams({token}))).status,400);
  const sent=await c.post(location+'/approve',new URLSearchParams({token,confirm:'yes'}));assert.equal(sent.status,303);assert.equal(c.sdkCalls.length,1);
  const result=await(await fetch(c.base+location)).text();assert.match(result,/succeeded/);assert.match(result,/pending \/ unverified/);assert.match(result,/応答の実usage/);assert.ok(!result.includes('action="'+location+'/approve"'));
  const importId=(await c.store.read()).executions[0].revisions.at(-1).savedImport.id;assert.equal((await fetch(c.base+'/offer-imports/'+importId)).status,200);
  assert.equal((await c.post(location+'/approve',new URLSearchParams({token,confirm:'yes'}))).status,409);assert.equal(c.sdkCalls.length,1);
});
test('6-1 HTTP: null real cap renders stopped confirmation without approval form and never enables real',async t=>{
  const c=await fixture(t,{policy:{...fixtureBudgetPolicy,realStopMilliYen:null}});const location=await c.httpPrepare();const html=await(await fetch(c.base+location)).text();
  assert.match(html,/無効（null）/);assert.match(html,/real_budget_disabled/);assert.ok(!html.includes('budget_uninitialized'));assert.match(html,/送信停止/);assert.ok(!html.includes('name="token"'));assert.equal(c.sdkCalls.length,0);assert.equal((await c.coordinator.activation()).policy.realStopMilliYen,null);
  await assert.rejects(fs.lstat(path.join(c.root,'ai-budget/real-approval.json')),{code:'ENOENT'});
});
test('6-1 HTTP: saved but unfinished import is never review-linked or accepted',async t=>{
  const c=await fixture(t,{serviceOptions:{fault:async phase=>{if(phase==='before_result')throw new Error('fictional-private');}}});const location=await c.httpPrepare();
  const confirmation=await(await fetch(c.base+location)).text();const token=confirmation.match(/name="token" value="([^"]+)"/)[1];await c.post(location+'/approve',new URLSearchParams({token,confirm:'yes'}));
  const r=(await c.store.read()).executions[0].revisions.at(-1);assert.equal(r.state,'recovery_required');const html=await(await fetch(c.base+location)).text();assert.ok(!html.includes('href="/offer-imports/'));
  assert.equal((await fetch(c.base+'/offer-imports/'+r.plannedImport.id)).status,409);assert.equal(c.sdkCalls.length,1);
});
test('6-1 HTTP: connection unknown status hides send/review forms and retains reservation',async t=>{
  const c=await fixture(t,{respond:()=>{throw new Error('fictional-private');}});const location=await c.httpPrepare();const html=await(await fetch(c.base+location)).text();const token=html.match(/name="token" value="([^"]+)"/)[1];
  await c.post(location+'/approve',new URLSearchParams({token,confirm:'yes'}));const stopped=await(await fetch(c.base+location)).text();assert.match(stopped,/unknown/);assert.match(stopped,/送信結果不明（send_unknown）/);assert.match(stopped,/二重送信防止のため再送しない/);assert.ok(!stopped.includes('API料金は発生していません'));assert.ok(!stopped.includes('name="token"'));assert.ok(!stopped.includes('href="/offer-imports/'));assert.ok(!stopped.includes('fictional-private'));
  assert.equal((await c.store.read()).executions[0].revisions.at(-1).budget.reservedMilliYen,1824);
});
for(const defect of ['origin','missing_origin','cross_site','unknown','duplicate','revision','secret','html','oversize','content_type','host'])test(`6-1 HTTP: prepare ${defect} rejected with no artifact/send`,async t=>{
  const c=await fixture(t);const data=extractionForm(c);const headers={Origin:c.base};
  if(defect==='origin')headers.Origin='https://outside.test';if(defect==='missing_origin')delete headers.Origin;
  if(defect==='cross_site')headers['Sec-Fetch-Site']='cross-site';if(defect==='unknown')data.set('api_key','fictional-secret');
  if(defect==='duplicate')data.append('documents.0.text','duplicate');if(defect==='revision')data.set('offerRevision','2');
  if(defect==='secret')data.set('documents.0.text','Cookie: fictional-secret');if(defect==='html')data.set('documents.0.text','<html><body>private</body></html>');
  if(defect==='oversize')data.set('documents.0.text','x'.repeat(2*1024*1024));if(defect==='content_type')headers['Content-Type']='application/json';
  let response;
  if(defect==='host')response=await new Promise((resolve,reject)=>{const req=http.request(c.base+'/offer-extractions/prepare',{method:'POST',headers:{...headers,Host:'outside.test','Content-Type':'application/x-www-form-urlencoded'}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,text:async()=>''}));});req.on('error',reject);req.end(data.toString());});
  else response=await fetch(c.base+'/offer-extractions/prepare',{method:'POST',headers,body:data});
  assert.ok([400,403,409,413,415].includes(response.status));const html=await response.text();assert.ok(!html.includes('fictional-secret'));assert.ok(!html.includes('<body>private'));assert.equal(c.sdkCalls.length,0);assert.equal((await c.store.read()).executions.length,0);
});
for(const defect of ['origin','missing_origin','cross_site','unchecked','duplicate','amount_injection','token','revision'])test(`6-1 HTTP: approval ${defect} refused before send`,async t=>{
  const c=await fixture(t);const location=await c.httpPrepare();const html=await(await fetch(c.base+location)).text();const token=html.match(/name="token" value="([^"]+)"/)[1];
  const form=new URLSearchParams({token,confirm:'yes'});const headers={Origin:c.base};
  if(defect==='origin')headers.Origin='https://outside.test';if(defect==='missing_origin')delete headers.Origin;if(defect==='cross_site')headers['Sec-Fetch-Site']='cross-site';
  if(defect==='unchecked')form.delete('confirm');if(defect==='duplicate')form.append('confirm','yes');if(defect==='amount_injection')form.set('inputMilliYenPerMillion','1');if(defect==='token')form.set('token',token+'x');if(defect==='revision')form.set('revision','1');
  const response=await fetch(c.base+location+'/approve',{method:'POST',headers,body:form});assert.ok([400,403,409].includes(response.status));assert.equal(c.sdkCalls.length,0);assert.equal((await c.store.read()).executions[0].revisions.at(-1).state,'prepared');
});
test('6-1: input parser rejects unknown metadata and ID injection, ignores only wholly empty rows',()=>{
  const c={offer:{id:'10000000-0000-4000-8000-000000000001',revision:1}};const form=extractionForm(c);const value=parseExtractionForm(form);assert.deepEqual(value.documents,makeDocuments(fictionalRows()));
  form.set('documents.2.label','');form.set('documents.2.text','');form.set('documents.2.kind','user_provided');form.set('documents.2.versionLabel','');assert.equal(parseExtractionForm(form).documents.length,2);
  form.set('documents.0.id','injected');assert.throws(()=>parseExtractionForm(form));
});

for (const defect of ['budget_uninitialized','input_invalid','input_limit','revision_conflict','save_uncertain']) test(`6-1 UX: prepare reason ${defect}, no API, persistence distinguished`, async t => {
  const options = defect === 'save_uncertain' ? { serviceOptions: { artifacts: { async create() { throw Object.assign(new Error('fictional-private-body'), { code: 'persistence_uncertain', status: 503 }); } } } } : {};
  const c = await fixture(t, options); const form = extractionForm(c);
  if (defect === 'budget_uninitialized') await fs.rename(path.join(c.root,'ai-budget/activation.json'),path.join(c.root,'fixture-activation-away.json'));
  if (defect === 'input_invalid') form.set('documents.0.text','Cookie: fictional-secret');
  if (defect === 'input_limit') form.set('documents.0.text','架空'.repeat(15000));
  if (defect === 'revision_conflict') form.set('offerRevision','2');
  const response = await c.post('/offer-extractions/prepare',form); const html = await response.text();
  assert.ok(response.status >= 400); assert.match(html,new RegExp('停止理由（'+defect+'）'));
  assert.match(html,/外部送信していません/); assert.match(html,/API料金は発生していません/);
  assert.equal(c.sdkCalls.length,0); assert.equal((await c.store.read()).executions.length,0);
  assert.ok(!html.includes('fictional-secret')); assert.ok(!html.includes('fictional-private-body'));
  assert.ok(!html.includes('送信済みの可能性')); assert.equal(html.includes('保存前に停止'),defect !== 'save_uncertain');
  if (defect === 'save_uncertain') assert.match(html,/保存結果不明/);
});
test('6-1 UX: fixed reason allowlist never leaks raw error or claims no charge for approval uncertainty', () => {
  const views = extractionPages(v=>v);
  const raw = { code:'<script>fictional-secret</script>', message:'fictional-private-body', status:503 };
  const html = views.failure(extractionFailureContext(raw,'approve'));
  assert.match(html,/operation_uncertain/); assert.match(html,/二重送信防止のため再送しない/);
  assert.ok(!html.includes('API料金は発生していません')); assert.ok(!html.includes('fictional-'));
  assert.match(views.failure({code:raw.code,state:'before_save'}),/operation_uncertain/);
});

test('6-1 UX: artifact saved before failed prepare remains uncertain, never retried or sent', async t => {
  let backing; let calls = 0;
  const c = await fixture(t, { serviceOptions: { artifacts: { async create(...args) {
    calls++; await backing.create(...args); throw Object.assign(new Error('fictional-private-disk'), {code:'persistence_uncertain',status:503});
  } } } });
  backing = createArtifactStore(c.root, {now:c.now});
  const response = await c.post('/offer-extractions/prepare',extractionForm(c)); const html = await response.text();
  assert.match(html,/save_uncertain/); assert.match(html,/保存結果不明/); assert.match(html,/外部送信していません/);
  assert.ok(!html.includes('保存前に停止')); assert.ok(!html.includes('fictional-private-disk'));
  assert.equal(calls,1); assert.equal(c.sdkCalls.length,0); assert.equal((await c.store.read()).executions.length,0);
  const files = await fs.readdir(path.join(c.root,'extraction-artifacts')); assert.equal(files.filter(n=>n.endsWith('.json')).length,1);
});
