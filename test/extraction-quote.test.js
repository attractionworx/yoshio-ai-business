import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { validateExtraction, hashDocumentText } from '../lib/offer-import/validation.js';
import { extractionProfile } from '../lib/ai/extraction-profile.js';
import { historicalExtractionProfiles } from '../lib/ai/extraction-profile-registry.js';
import { buildExtractionPayload } from '../lib/ai/extraction-payload.js';
import { executionFixture } from './fixtures/extraction-execution.js';
import { createExtractionService } from '../lib/offer-import/extraction-service.js';
import { extractionPages } from '../lib/offer-import/extraction-pages.js';
function fixture(text, start=0, end=text.length, quote=text, split=0) {
  const blocks=split ? [{id:'before',start:0,end:split},{id:'selected',start:split,end:text.length}] : [{id:'selected',start:0,end:text.length}];
  return { documents:[{id:'fictional-document',format:'text',label:'架空資料',kind:'asp_material',versionLabel:'架空v1',text,textHash:hashDocumentText(text),blocks}],
    extraction:{schemaVersion:1,candidates:[{target:'facts',category:'feature',conversionKey:null,purpose:'fact',usage:'internal_only',text:'response-only-fictional-marker',evidence:[{documentId:'fictional-document',blockId:'selected',start,end,quote}]}]}};
}
const positives=[
  ['surrogate','A😀B',1,3],['combining','Ae\u0301B',1,3],['fullwidth','AＡB',1,2],
  ['LF','A\nB',0,3],['CRLF','A\r\nB',0,4],['tab spaces','A\t  B',0,5],
  ['quotation marks','A“B”"C',0,6],['literal JSON escape','A\\nB',0,4],
  ['decoded JSON escape',JSON.parse('"A\\nB"'),0,3],['nonzero block','XYZhello',3,8,3],
  ['repetition','abc abc',4,7],
];
for(const [label,text,start,end,split=0] of positives) test(`quote exact acceptance: ${label}`,()=>{
  const f=fixture(text,start,end,text.slice(start,end),split);
  assert.deepEqual(validateExtraction(JSON.parse(JSON.stringify(f.extraction)),f.documents),f.extraction);
});
const negatives=[
  ['end off one','A😀B',1,2,'😀','length_mismatch'],
  ['combining normalization','Ae\u0301B',1,3,'é','length_mismatch'],
  ['fullwidth normalization','XＡB',1,2,'A','same_length_mismatch'],
  ['LF to CRLF','A\nB',0,3,'A\r\nB','length_mismatch'],
  ['CRLF to LF','A\r\nB',0,4,'A\nB','length_mismatch'],
  ['tab normalization','A\tB',0,3,'A B','same_length_mismatch'],
  ['space collapsing','A  B',0,4,'A B','length_mismatch'],
  ['quotes changed','A“B”',0,4,'A"B"','same_length_mismatch'],
  ['quotes added','ABC',0,3,'"ABC"','length_mismatch'],
  ['escape text counted','A\nB',0,3,'A\\nB','length_mismatch'],
  ['trim',' ABC ',0,5,'ABC','found_elsewhere_in_block'],
  ['other position','abc XYZ',4,7,'abc','found_elsewhere_in_block'],
  ['elsewhere beats length','abc XYZ',4,6,'abc','found_elsewhere_in_block'],
  ['repeat skip selected start','abc abc',0,2,'abc','found_elsewhere_in_block'],
];
for(const [label,text,start,end,quote,reason] of negatives) test(`quote mismatch rejection: ${label}`,()=>{
  const f=fixture(text,start,end,quote);assert.throws(()=>validateExtraction(f.extraction,f.documents),{code:`validation_quote_${reason}`});
});
test('quote multiple documents uses only referenced document',()=>{
  const f=fixture('ABC');const second=fixture('XYZ').documents[0];second.id='second';f.documents.push(second);
  const e=f.extraction.candidates[0].evidence[0];e.documentId='second';e.quote='XYZ';assert.doesNotThrow(()=>validateExtraction(f.extraction,f.documents));
  e.quote='ABC';assert.throws(()=>validateExtraction(f.extraction,f.documents),{code:'validation_quote_same_length_mismatch'});
});
test('quote references, range, candidate and duplicate order stays unchanged',()=>{
  const f=fixture('abc XYZ',3,7,'abc',3);const e=f.extraction.candidates[0].evidence[0];
  assert.throws(()=>validateExtraction(f.extraction,f.documents),{code:'validation_quote_length_mismatch'}); // other-block occurrence does not classify elsewhere
  e.start=0;assert.throws(()=>validateExtraction(f.extraction,f.documents),{code:'validation_evidence_range'});
  e.blockId='missing';assert.throws(()=>validateExtraction(f.extraction,f.documents),{code:'validation_evidence_reference'});
  f.extraction.candidates[0].conversionKey='wrong';assert.throws(()=>validateExtraction(f.extraction,f.documents),{code:'validation_candidate_conversion_key'});
  const good=fixture('ABC');good.extraction.candidates[0].evidence.push(structuredClone(good.extraction.candidates[0].evidence[0]));
  assert.throws(()=>validateExtraction(good.extraction,good.documents),{code:'validation_evidence_duplicate'});
});
function removeDescriptions(v){return Array.isArray(v)?v.map(removeDescriptions):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>k!=='description').map(([k,x])=>[k,removeDescriptions(x)])):v;}
test('quote instructions and strict wire annotations cover exact contract without acceptance changes',()=>{
  const priorProfile=historicalExtractionProfiles[2];
  for(const fragment of ['JSON解析後','先頭基準','0始まり','UTF-16コード単位','end-exclusive','block相対位置は禁止','連続原文','trim','訂正','要約','引用符追加','A😀B','start=1,end=3','CRLF','start=0,end=4']) assert.ok(priorProfile.instructions.includes(fragment),fragment);
  assert.deepEqual(removeDescriptions(priorProfile.outputSchema),historicalExtractionProfiles[1].outputSchema);
  const f=fixture('ABC');const payload=buildExtractionPayload({documents:f.documents},priorProfile);
  assert.equal(payload.text.format.strict,true);assert.deepEqual(payload.text.format.schema,priorProfile.outputSchema);
  for(const key of ['documentId','blockId','start','end','quote'])assert.ok(payload.text.format.schema.$defs.evidence.properties[key].description);
});
async function contents(root){let result='';for(const name of await fs.readdir(root)){const p=path.join(root,name);const s=await fs.stat(p);result+=s.isDirectory()?await contents(p):await fs.readFile(p,'utf8');}return result;}
for(const [label,text,start,end,quote,reason] of [negatives[0],negatives[2],negatives[11]])test(`quote fake provider durable diagnostic: ${label}`,async t=>{
  const c=await executionFixture(t);const f=fixture(text,start,end,quote);c.value.documents=f.documents;
  const service=createExtractionService({...c.options,provider:{kind:'fake',async extract(){return {extraction:f.extraction,usage:{inputTokens:100,outputTokens:200}};}}});
  const r=await c.run(service);assert.deepEqual(r.error,{code:`validation_quote_${reason}`,phase:'validation'});
  assert.equal(r.state,'failed_after_request');assert.equal(r.budget.state,'settled');assert.equal(r.budget.reservedMilliYen,0);
  for(const k of ['validatedArtifact','plannedImport','savedImport'])assert.equal(r[k],null);
  const html=extractionPages(x=>String(x)).detail(await service.preview(r.id));assert.ok(html.includes(r.error.code));assert.ok(!html.includes('response-only-fictional-marker'));
  assert.ok(!(await contents(c.root)).includes('response-only-fictional-marker'));assert.deepEqual((await c.store.get(r.id)).error,r.error);
  assert.deepEqual(await c.imports.list(),[]);
});
