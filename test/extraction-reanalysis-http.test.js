import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { reanalysisFixture } from './fixtures/extraction-reanalysis.js';

async function fixture(t) {
  const c=await reanalysisFixture(t); const app=createApp({dataDirectory:c.root,generationOptions:{now:c.now},extractionOptions:{provider:c.provider}});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});t.after(()=>new Promise(r=>app.close(r)));
  const base=`http://127.0.0.1:${app.address().port}`; const source=`/offer-extractions/${c.source.id}`;
  const post=(url,body,headers={Origin:base})=>fetch(base+url,{method:'POST',body,headers,redirect:'manual'});
  const preparation=async()=>{const response=await fetch(base+source+'/reanalysis');const html=await response.text();assert.equal(response.status,200);return {response,html,token:html.match(/name="token" value="([^"]+)"/)[1]};};
  return {...c,sourceRecord:c.source,app,base,source,post,preparation};
}
test('reanalysis HTTP: detail-only two-step human approval, same-operation repeat, pending review, CSP',async t=>{
  const c=await fixture(t); const parentHtml=await(await fetch(c.base+c.source)).text();assert.match(parentHtml,/意図的再解析の準備を確認/);
  const p=await c.preparation();assert.equal(p.response.headers.get('cache-control'),'no-store');assert.match(p.response.headers.get('content-security-policy'),/form-action 'self'/);assert.ok(!p.html.includes(' checked'));
  assert.ok(!p.html.includes('架空の紙工作教材'));assert.equal(c.attempts.length,1);
  const form=new URLSearchParams({token:p.token,confirm:'yes'});
  const response=await c.post(c.source+'/reanalysis/prepare',form);assert.equal(response.status,303); const location=response.headers.get('location');assert.notEqual(location,c.source);
  const repeated=await c.post(c.source+'/reanalysis/prepare',form);assert.equal(repeated.status,303);assert.equal(repeated.headers.get('location'),location);
  const h=await(await fetch(c.base+location)).text();assert.match(h,/execution v2/);assert.match(h,/新しい送信・新たな費用予約/);assert.ok(!h.includes(' checked'));assert.ok(!h.includes('href="/offer-imports/'));assert.equal(c.attempts.length,1);
  const token=h.match(/name="token" value="([^"]+)"/)[1];const sent=await c.post(location+'/approve',new URLSearchParams({token,confirm:'yes'}));assert.equal(sent.status,303);assert.equal(c.attempts.length,2);
  assert.equal((await c.post(location+'/approve',new URLSearchParams({token,confirm:'yes'}))).status,409);assert.equal(c.attempts.length,2);
  const result=await(await fetch(c.base+location)).text();assert.match(result,/pending \/ unverified/);assert.match(result,/href="\/offer-imports\//);
  const sourceAfter=await(await fetch(c.base+c.source)).text();assert.match(sourceAfter,/追加作成不可/);assert.ok(!sourceAfter.includes('/reanalysis"'));assert.deepEqual(await c.store.get(c.sourceRecord.id),c.sourceRecord);
});
for(const defect of ['origin','missing_origin','cross_site','unchecked','duplicate_confirm','reason_injection','operation_injection','raw_field','token','host'])test(`reanalysis HTTP: ${defect} blocked without writes or send`,async t=>{
  const c=await fixture(t);const p=await c.preparation();const form=new URLSearchParams({token:p.token,confirm:'yes'});const headers={Origin:c.base};
  if(defect==='origin')headers.Origin='https://outside.test';if(defect==='missing_origin')delete headers.Origin;if(defect==='cross_site')headers['Sec-Fetch-Site']='cross-site';
  if(defect==='unchecked')form.delete('confirm');if(defect==='duplicate_confirm')form.append('confirm','yes');if(defect==='reason_injection')form.set('reasonCode','unapproved');
  if(defect==='operation_injection')form.set('operationId',c.source.id);if(defect==='raw_field')form.set('raw','fictional-private');if(defect==='token')form.set('token',p.token+'x');
  let response;if(defect==='host')response=await new Promise((resolve,reject)=>{const req=http.request(c.base+c.source+'/reanalysis/prepare',{method:'POST',headers:{...headers,Host:'outside.test','Content-Type':'application/x-www-form-urlencoded'}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,text:async()=>''}));});req.on('error',reject);req.end(form.toString());});
  else response=await c.post(c.source+'/reanalysis/prepare',form,headers);
  assert.ok([400,403,409].includes(response.status));assert.ok(!(await response.text()).includes('fictional-private'));assert.equal((await c.store.read()).executions.length,1);assert.equal(c.attempts.length,1);
});
test('reanalysis HTTP: normal duplicate has fixed code, no artifact write and no API charge',async t=>{
  const c=await fixture(t); const form=new URLSearchParams({offerId:c.offer.id,offerRevision:'1'});
  c.value.documents.forEach((d,i)=>Object.entries({label:d.label,kind:d.kind,versionLabel:d.versionLabel||'',text:d.text}).forEach(([k,v])=>form.set(`documents.${i}.${k}`,v)));
  // Original blocks differ from pasted blocks; material fingerprint still identifies the same material.
  const response=await c.post('/offer-extractions/prepare',form); const html=await response.text();assert.equal(response.status,409);assert.match(html,/duplicate_request/);assert.match(html,/外部送信していません/);assert.match(html,/API料金は発生していません/);assert.equal((await c.store.read()).executions.length,1);assert.equal(c.attempts.length,1);
});
