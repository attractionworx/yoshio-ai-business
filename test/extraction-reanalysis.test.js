import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { reanalysisFixture } from './fixtures/extraction-reanalysis.js';
import { executionFixture } from './fixtures/extraction-execution.js';
import { createExecutionStore } from '../lib/offer-import/execution-store.js';
import { validateExecutionLedger } from '../lib/offer-import/execution-contract.js';
import { validateExecutionLedgerAny, sendBindingHash } from '../lib/offer-import/execution-v2-contract.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { createArtifactStore } from '../lib/offer-import/extraction-artifacts.js';
import { digest } from '../lib/ai/safety-storage.js';
import { capture } from '../lib/maintenance/snapshot.js';
import { blockedConnections } from './helpers/network-guard.js';
import { extractionPages, extractionFailureContext } from '../lib/offer-import/extraction-pages.js';

const ledgerPath = c => path.join(c.root,'extraction-executions/ledger.json');
const prepare = async c => { const v = await c.service.reanalysisPreview(c.source.id); return { v, child: await c.service.prepareReanalysis(c.source.id,v.token,{confirm:true}) }; };
const approve = (c,r,s=c.service) => s.approve(r.id,r.revision,{confirm:true,requestHash:r.requestHash});
const bytes = async c => Object.fromEntries(Object.entries((await capture(c.root)).files).map(([n,b])=>[n,b.toString()]));

test('reanalysis: separate v2 preparation, immutable input, unchanged parent, separate bound send', async t => {
  const c = await reanalysisFixture(t); assert.equal(c.source.state,'failed_after_request');
  const parent = (await c.store.read()).executions[0]; const activation = await fs.readFile(path.join(c.root,'ai-budget/activation.json'),'utf8');
  await assert.rejects(c.service.prepare(c.value),{code:'duplicate_request'});
  const {child} = await prepare(c); assert.equal(child.schemaVersion,2); assert.equal(child.state,'prepared');
  assert.equal(child.reanalysis.sourceRevision,c.source.revision); assert.equal(child.reanalysis.sourceHash,digest(c.source));
  assert.equal(child.reanalysis.reasonCode,'validation_failure_investigation'); assert.equal(child.budget.reservedMilliYen,0);
  assert.equal(child.inputArtifact.hash,c.source.inputArtifact.hash); assert.notEqual(child.inputArtifact.id,c.source.inputArtifact.id);
  const a = await createArtifactStore(c.root).read(child.inputArtifact,child.id,'input'); assert.deepEqual(a.content,c.value);
  assert.equal(c.attempts.length,1); assert.equal((await c.imports.list()).length,0);
  const approved = await approve(c,child); assert.equal(approved.approval.bindingHash,sendBindingHash(child));
  const result = await c.service.execute(child.id,approved.revision); assert.equal(result.state,'succeeded'); assert.equal(c.attempts.length,2);
  const history = (await c.store.read()).executions[1].revisions;
  assert.deepEqual(history.map(r=>r.state),['prepared','approved','sending','response_received','validated','import_saving','succeeded']);
  assert.deepEqual((await c.store.read()).executions[0],parent);
  assert.equal(await fs.readFile(path.join(c.root,'ai-budget/activation.json'),'utf8'),activation);
  const imp = await c.imports.get(result.savedImport.id); assert.ok(imp.candidates.every(x=>x.review.decision==='pending'&&x.review.verification==='unverified'));
  const totals = await c.coordinator.transaction(common=>common.totals);
  assert.equal(totals.simulation.bookedMilliYen,c.source.budget.bookedMilliYen+result.budget.bookedMilliYen); assert.equal(totals.real.bookedMilliYen,0);
  assert.equal(totals.simulation.reservedMilliYen,0); assert.equal((await c.service.status(result.id)).reviewReady,true);
});
test('reanalysis: v1 strict validator remains unchanged; mixed history accepted only by dispatcher',async t=>{
  const c=await reanalysisFixture(t); const old=await c.store.read(); assert.deepEqual(validateExecutionLedger(old),old);
  const {child}=await prepare(c); const mixed=await c.store.read(); assert.throws(()=>validateExecutionLedger(mixed)); assert.deepEqual(validateExecutionLedgerAny(mixed),mixed); assert.deepEqual(mixed.executions[0],old.executions[0]);
  const distinct=structuredClone(c.value); distinct.documents[0].label+='架空別資料'; await c.service.prepare(distinct);
  assert.deepEqual((await c.store.read()).executions.map(e=>e.revisions[0].schemaVersion),[1,2,1]);
  await assert.rejects(c.store.create(child),{code:'reanalysis_dedicated_only'});
  await assert.rejects(c.service.prepare(c.value),{code:'duplicate_request'});
});
test('reanalysis: same operation double click returns one prepared child; different operation cannot create second',async t=>{
  const c=await reanalysisFixture(t); const first=await c.service.reanalysisPreview(c.source.id); const other=await c.service.reanalysisPreview(c.source.id);
  const child=await c.service.prepareReanalysis(c.source.id,first.token,{confirm:true});
  assert.deepEqual(await c.service.prepareReanalysis(c.source.id,first.token,{confirm:true}),child);
  await assert.rejects(c.service.prepareReanalysis(c.source.id,other.token,{confirm:true}),{code:'reanalysis_child_exists'});
  assert.equal((await c.store.read()).executions.length,2); assert.equal((await fs.readdir(path.join(c.root,'extraction-artifacts'))).length,2);
  assert.equal(c.attempts.length,1); await assert.rejects(c.service.reanalysisPreview(c.source.id),{code:'reanalysis_child_exists'});
});
for(const same of [true,false]) test(`reanalysis: concurrent ${same?'same':'different'} operation creates at most one child`,async t=>{
  const c=await reanalysisFixture(t); const v=await c.service.reanalysisPreview(c.source.id); const w=same?v:await c.service.reanalysisPreview(c.source.id);
  const results=await Promise.allSettled([v,w].map(x=>c.service.prepareReanalysis(c.source.id,x.token,{confirm:true})));
  assert.equal((await c.store.read()).executions.length,2); assert.ok(results.some(x=>x.status==='fulfilled')); assert.equal(c.attempts.length,1);
});
test('reanalysis: explicit preparation and new send approval both required; tokens cannot cross source or restart',async t=>{
  const c=await reanalysisFixture(t); const v=await c.service.reanalysisPreview(c.source.id);
  await assert.rejects(c.service.prepareReanalysis(c.source.id,v.token,{confirm:false}));
  await assert.rejects(c.service.prepareReanalysis(randomUUID(),v.token,{confirm:true}));
  await assert.rejects(c.reopen().prepareReanalysis(c.source.id,v.token,{confirm:true}));
  await assert.rejects(c.service.prepareReanalysis(c.source.id,v.token+'x',{confirm:true}));
  const child=await c.service.prepareReanalysis(c.source.id,v.token,{confirm:true});
  await assert.rejects(c.service.execute(child.id,1));
  const s=c.reopen(); assert.equal((await s.status(child.id)).record.state,'prepared'); assert.equal(c.attempts.length,1);
  const send=await s.preview(child.id); assert.ok(send.token); await assert.rejects(s.approveAndExecute(child.id,send.token,{confirm:false}));
  const result=await s.approveAndExecute(child.id,send.token,{confirm:true}); assert.equal(result.state,'succeeded');
  await assert.rejects(s.approveAndExecute(child.id,send.token,{confirm:true})); assert.equal(c.attempts.length,2);
});
test('reanalysis: concurrent send calls provider only once and unchanged parent',async t=>{
  const c=await reanalysisFixture(t); const {child}=await prepare(c); const a=await approve(c,child);
  const results=await Promise.allSettled([c.service.execute(a.id,a.revision),c.service.execute(a.id,a.revision)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1); assert.equal(c.attempts.length,2); assert.deepEqual(await c.store.get(c.source.id),c.source);
});
for(const stage of ['after_reanalysis_input','before_reanalysis_persist','after_reanalysis_persist']) test(`reanalysis: ${stage} partial result stops safely on restart`,async t=>{
  const c=await reanalysisFixture(t); const s=c.reopen({fault:async p=>{if(p===stage)throw Error('fictional-private');}}); const v=await s.reanalysisPreview(c.source.id);
  await assert.rejects(s.prepareReanalysis(c.source.id,v.token,{confirm:true}),{preparePersistence:'uncertain'});
  assert.equal(c.attempts.length,1); const restarted=c.reopen();
  if(stage==='after_reanalysis_persist') {
    assert.equal((await c.store.read()).executions.length,2); await assert.rejects(restarted.reanalysisPreview(c.source.id),{code:'reanalysis_child_exists'});
    const child=(await c.store.read()).executions[1].revisions[0]; assert.equal((await restarted.preview(child.id)).record.state,'prepared');
  } else {
    assert.equal((await c.store.read()).executions.length,1); await assert.rejects(restarted.reanalysisPreview(c.source.id),{code:'reanalysis_integrity'});
  }
  assert.ok(!JSON.stringify(await c.store.read()).includes('fictional-private'));
});
test('reanalysis: interrupted sending retains reservation and never resends on restart',async t=>{
  const c=await reanalysisFixture(t); const s=c.reopen({fault:async p=>{if(p==='after_sending')throw Error('fictional-stop');}});
  const child=await c.prepareChild(s); const a=await approve(c,child,s); await assert.rejects(s.execute(a.id,a.revision));
  const latest=await c.store.get(a.id); assert.equal(latest.state,'sending'); assert.ok(latest.budget.reservedMilliYen>0); assert.equal(c.attempts.length,1);
  const restarted=c.reopen(); await assert.rejects(restarted.execute(a.id,latest.revision)); await assert.rejects(restarted.reanalysisPreview(c.source.id));
  await assert.rejects(c.generation.execute(c.plan,c.generation.confirmation(c.plan)),{code:'ai_in_progress'});
  const unknown=await restarted.recover(a.id,latest.revision,{confirm:true,operation:'mark_interrupted'}); assert.equal(unknown.state,'unknown'); assert.equal(c.attempts.length,1);
});
for(const state of ['prepared','approved','succeeded','unknown','recovery_required']) test(`reanalysis: ${state} source rejected`,async t=>{
  const c=await executionFixture(t); let r;
  if(state==='prepared')r=await c.service.prepare(c.value);
  else if(state==='approved')r=await c.ready();
  else if(state==='succeeded')r=await c.run();
  else {
    const {createExtractionService}=await import('../lib/offer-import/extraction-service.js');
    const provider={kind:'fake',async extract(){if(state==='unknown')throw Error('fixture');return c.provider.extract({input:c.value});}};
    const s=createExtractionService({...c.options,provider,fault:async p=>{if(state==='recovery_required'&&p==='before_result')throw Error('fixture');}});
    await c.run(s).catch(()=>{}); r=(await c.store.read()).executions[0].revisions.at(-1); assert.equal(r.state,state);
  }
  await assert.rejects(c.service.reanalysisPreview(r.id));
});
for(const issue of ['activation','artifact','ledger','partial','conflict','budget']) test(`reanalysis: ${issue} precondition stops before artifact creation`,async t=>{
  const c=await reanalysisFixture(t); const count=(await fs.readdir(path.join(c.root,'extraction-artifacts'))).length;
  if(issue==='activation')await fs.unlink(path.join(c.root,'ai-budget/activation.json'));
  if(issue==='artifact')await fs.writeFile(path.join(c.root,'extraction-artifacts',c.source.inputArtifact.id+'.json'),'{}');
  if(issue==='ledger')await fs.writeFile(ledgerPath(c),'{}');
  if(issue==='partial')await fs.writeFile(path.join(c.root,'extraction-executions/.write-intent'),'fixture');
  if(issue==='conflict')await fs.mkdir(path.join(c.root,'ai-budget/.lock'));
  if(issue==='budget') { const file=path.join(c.root,'ai-budget/activation.json');const a=JSON.parse(await fs.readFile(file));a.policy.simulationStopMilliYen=1; await fs.writeFile(file,JSON.stringify(a)); }
  await assert.rejects(c.service.reanalysisPreview(c.source.id)); assert.equal((await fs.readdir(path.join(c.root,'extraction-artifacts'))).length,count);assert.equal(c.attempts.length,1);
});
for(const field of ['sourceHash','lineageHash','reasonCode','sourceRevision','sourceExecutionId','operationId','approvalBinding','inputArtifact']) test(`reanalysis: maintenance detects tampered ${field}`,async t=>{
  const c=await reanalysisFixture(t); const {child}=await prepare(c); await approve(c,child);
  const file=ledgerPath(c); const ledger=JSON.parse(await fs.readFile(file)); const revisions=ledger.executions[1].revisions;
  for(const r of revisions) {
    if(field==='approvalBinding'){if(r.approval)r.approval.bindingHash='0'.repeat(64);}
    else if(field==='inputArtifact')r.inputArtifact.hash='0'.repeat(64);
    else { r.reanalysis[field]=field==='sourceRevision'?999:field==='sourceExecutionId'||field==='operationId'?randomUUID():field==='reasonCode'?'unapproved':'0'.repeat(64); }
  }
  await fs.writeFile(file,JSON.stringify(ledger)); await assert.rejects(c.store.read(),{code:'execution_unreadable'});
  const m=createMaintenanceService(c.root,{now:c.now}); assert.equal((await m.integrity()).status,'error'); await assert.rejects(m.create()); assert.equal(c.attempts.length,1);
});
test('reanalysis: backup version accurately covers v2 and old v1-execution backup remains readable',async t=>{
  const c=await reanalysisFixture(t); const m=createMaintenanceService(c.root,{now:c.now}); const old=await m.create(); assert.equal(old.manifest.contracts.extractionExecution,1);
  const {child}=await prepare(c); const a=await approve(c,child); await c.service.execute(a.id,a.revision);
  const current=await m.create(); assert.equal(current.manifest.schemaVersion,2); assert.equal(current.manifest.contracts.extractionExecution,2);
  assert.equal((await m.integrity()).status,'normal'); assert.equal((await m.integrity()).metrics.reanalysisExecutions,1);
  const before=await bytes(c); const dry=await m.dryRun(current.manifest.id); assert.equal(dry.backupValid,true);assert.equal(dry.restored,false);assert.equal(dry.status,'normal');
  assert.deepEqual(await bytes(c),before); const oldDry=await m.dryRun(old.manifest.id);assert.equal(oldDry.backupValid,true); assert.equal(oldDry.manifest.contracts.extractionExecution,1);
});
test('reanalysis: fixed duplicate UI explains no request/charge and never renders raw diagnostic data',()=>{
  const views=extractionPages(x=>String(x).replaceAll('<','&lt;')); const h=views.failure(extractionFailureContext({code:'duplicate_request',status:409},'prepare'));
  assert.match(h,/duplicate_request/);assert.match(h,/外部送信していません/);assert.match(h,/API料金は発生していません/);
  assert.doesNotMatch(h,/FICTIONAL_RAW_PRIVATE/);
});
test('reanalysis: no outgoing connections',()=>assert.equal(blockedConnections.length,0));

for(const otherState of ['approved','unknown','recovery_required','import_save_failed'])test(`reanalysis: other ${otherState} blocks preparation and send`,async t=>{
  const c=await reanalysisFixture(t); const v=await c.service.reanalysisPreview(c.source.id); const distinct=structuredClone(c.value); distinct.documents[0].label+='架空別入力';
  const s=c.reopen({provider:otherState==='unknown'?{kind:'fake',async extract(){throw Error('fixture-only');}}:c.provider,
    fault:async p=>{if((otherState==='recovery_required'&&p==='before_result')||(otherState==='import_save_failed'&&p==='before_import_save'))throw Error('fixture-only');}});
  const a=await c.ready(s,distinct); if(otherState!=='approved')await s.execute(a.id,a.revision).catch(()=>{});
  assert.equal((await c.store.get(a.id)).state,otherState);
  await assert.rejects(c.service.prepareReanalysis(c.source.id,v.token,{confirm:true}));assert.equal((await c.store.read()).executions.length,2);
});
test('reanalysis: budget contention after preparation stops before new reservation/provider',async t=>{
  const c=await reanalysisFixture(t); const {child}=await prepare(c); await fs.mkdir(path.join(c.root,'ai-budget/.lock'));
  await assert.rejects(approve(c,child)); assert.equal((await c.store.get(child.id)).state,'prepared');assert.equal(c.attempts.length,1);
});
test('reanalysis: target revision changes invalidate preparation approval',async t=>{
  const c=await reanalysisFixture(t); const v=await c.service.reanalysisPreview(c.source.id);
  const business={...c.offer};for(const k of ['schemaVersion','id','revision','createdAt','updatedAt'])delete business[k];business.name='架空改訂案件';await c.offers.update(c.offer.id,1,business);
  await assert.rejects(c.service.prepareReanalysis(c.source.id,v.token,{confirm:true}),{code:'target_revision_conflict'});assert.equal((await c.store.read()).executions.length,1);
});
for(const stage of ['prepare','sending'])test(`reanalysis: actual ${stage} durable-save acknowledgement failure does not resend`,async t=>{
  const c=await reanalysisFixture(t);const fileSystem={...fs,async rename(from,to){if(to===ledgerPath(c)){await fs.rename(from,to);throw Error('fictional-save-ack');}return fs.rename(from,to);}};
  if(stage==='prepare') {
    const store=createExecutionStore(c.root,{fileSystem,now:c.now});const s=c.reopen({store});const v=await s.reanalysisPreview(c.source.id);
    await assert.rejects(s.prepareReanalysis(c.source.id,v.token,{confirm:true}),{preparePersistence:'uncertain'});
  } else {
    const {child}=await prepare(c);const a=await approve(c,child);const s=c.reopen({store:createExecutionStore(c.root,{fileSystem,now:c.now})});await assert.rejects(s.execute(a.id,a.revision));
  }
  await assert.rejects(createExecutionStore(c.root).read());assert.equal((await createMaintenanceService(c.root).integrity()).stopped,true); assert.equal(c.attempts.length,1);
});
test('reanalysis: failed child may be next source, one child per source persists across v2 chain',async t=>{
  const c=await reanalysisFixture(t);const s=c.reopen({provider:{kind:'fake',async extract(){return {extraction:{},usage:{inputTokens:10,outputTokens:20}};}}});
  const child=await c.prepareChild(s);const a=await approve(c,child,s);const failed=await s.execute(a.id,a.revision);assert.equal(failed.state,'failed_after_request');
  const v=await s.reanalysisPreview(failed.id);const next=await s.prepareReanalysis(failed.id,v.token,{confirm:true});assert.equal(next.reanalysis.sourceExecutionId,child.id);
  assert.equal((await c.store.read()).executions.length,3); await assert.rejects(s.reanalysisPreview(c.source.id),{code:'reanalysis_child_exists'});assert.equal((await createMaintenanceService(c.root).integrity()).status,'normal');
});
for(const corruption of ['second_child','missing_parent','cycle','operation_duplicate','configuration','estimate'])test(`reanalysis: recomputed hashes cannot hide ${corruption} graph violation`,async t=>{
  const c=await reanalysisFixture(t);const {child}=await prepare(c);const ledger=await c.store.read();const entry=ledger.executions[1];const r=entry.revisions[0];
  if(corruption==='second_child') {const clone=structuredClone(entry);clone.revisions[0].id=randomUUID();clone.revisions[0].inputArtifact.id=randomUUID();clone.revisions[0].reanalysis.operationId=randomUUID();ledger.executions.push(clone);}
  if(corruption==='missing_parent')ledger.executions.shift();
  if(corruption==='cycle')r.reanalysis.sourceExecutionId=r.id;
  if(corruption==='operation_duplicate') {const clone=structuredClone(entry);clone.revisions[0].id=randomUUID();clone.revisions[0].inputArtifact.id=randomUUID();ledger.executions.push(clone);}
  if(corruption==='configuration'){r.configuration.version='fixture-modified';const {hash,...config}=r.configuration;r.configuration.hash=digest(config);}
  if(corruption==='estimate')r.estimate.inputTokens++;
  for(const e of ledger.executions.filter(e=>e.revisions[0].reanalysis)) {
    const a=e.revisions[0].reanalysis;const {lineageHash,...fields}=a;a.lineageHash=digest(fields);
  }
  assert.throws(()=>validateExecutionLedgerAny(ledger));assert.equal(c.attempts.length,1);assert.equal(child.state,'prepared');
});
test('reanalysis: no startup migration or write during restart/read; published v2 schema keeps v1 reference',async t=>{
  const c=await reanalysisFixture(t);const before=await bytes(c);c.reopen();await createExecutionStore(c.root).read();assert.deepEqual(await bytes(c),before);
  const schema=JSON.parse(await fs.readFile(new URL('../schemas/extraction-execution-v2.schema.json',import.meta.url)));
  assert.equal(schema.properties.schemaVersion.const,2);assert.match(JSON.stringify(schema),/extraction-execution\.schema\.json/);
});

test('reanalysis: v2 connection unknown holds reservation and stops both AI paths without retry',async t=>{
  const c=await reanalysisFixture(t);let childCalls=0;const s=c.reopen({provider:{kind:'fake',async extract(){childCalls++;throw Error('fictional-private-connection');}}});
  const child=await c.prepareChild(s);const a=await approve(c,child,s);const unknown=await s.execute(a.id,a.revision);
  assert.equal(unknown.state,'unknown');assert.equal(unknown.budget.state,'unknown');assert.ok(unknown.budget.reservedMilliYen>0);assert.equal(childCalls,1);
  const restarted=c.reopen();await assert.rejects(restarted.execute(child.id,unknown.revision));await assert.rejects(restarted.reanalysisPreview(child.id));
  await assert.rejects(c.generation.execute(c.plan,c.generation.confirmation(c.plan)),{code:'ai_in_progress'});
  assert.equal(childCalls,1);assert.ok(!JSON.stringify(await c.store.read()).includes('fictional-private-connection'));
});
test('reanalysis: v2 local import save failure/restart permits existing explicit save-only recovery without provider',async t=>{
  const c=await reanalysisFixture(t);const s=c.reopen({fault:async p=>{if(p==='before_import_save')throw Error('fictional-private-save');}});
  const child=await c.prepareChild(s);const a=await approve(c,child,s);const failed=await s.execute(a.id,a.revision);assert.equal(failed.state,'import_save_failed');assert.equal(failed.budget.reservedMilliYen,0);
  assert.equal((await c.service.status(child.id)).reviewReady,false);await assert.rejects(c.service.reanalysisPreview(child.id));assert.equal(c.attempts.length,2);
  const result=await c.reopen().recover(child.id,failed.revision,{confirm:true,operation:'save_only'});assert.equal(result.state,'succeeded');assert.equal(c.attempts.length,2);
  assert.deepEqual(await c.store.get(c.source.id),c.source);assert.equal((await createMaintenanceService(c.root).integrity()).status,'normal');
});
test('reanalysis: legitimate exhausted cap refuses preparation without modifying policy or ledgers',async t=>{
  const {fixtureBudgetPolicy}=await import('./fixtures/ai-budget.js');const c=await reanalysisFixture(t,{policy:{...fixtureBudgetPolicy,simulationStopMilliYen:273}});
  const before=await bytes(c);await assert.rejects(c.service.reanalysisPreview(c.source.id),{code:'common_budget_exceeded'});assert.deepEqual(await bytes(c),before);assert.equal(c.attempts.length,1);
});
for(const defect of ['lineage','coverage'])test(`reanalysis: backup dry-run rejects ${defect} with recomputed transport hashes`,async t=>{
  const c=await reanalysisFixture(t);await prepare(c);const m=createMaintenanceService(c.root,{now:c.now});const backup=await m.create();
  const archive=path.join(c.root,'maintenance-backups',backup.manifest.id);const filename=path.join(archive,'manifest.json');const manifest=JSON.parse(await fs.readFile(filename));
  const {hash,snapshotHash}=await import('../lib/maintenance/snapshot.js');
  if(defect==='lineage') {
    const relative='extraction-executions/ledger.json';const payload=path.join(archive,'payload',relative);const ledger=JSON.parse(await fs.readFile(payload));ledger.executions[1].revisions[0].reanalysis.sourceHash='0'.repeat(64);
    await fs.writeFile(payload,JSON.stringify(ledger));const content=await fs.readFile(payload);const entry=manifest.files.find(f=>f.path===relative);entry.size=content.length;entry.sha256=hash(content);
    manifest.totalBytes=manifest.files.reduce((n,f)=>n+f.size,0);const files={};for(const f of manifest.files)files[f.path]=await fs.readFile(path.join(archive,'payload',f.path));manifest.snapshotHash=snapshotHash({directories:manifest.directories,files});
  } else manifest.contracts.extractionExecution=1;
  const raw=JSON.stringify(manifest);await fs.writeFile(filename,raw);await fs.writeFile(path.join(archive,'manifest.sha256'),hash(raw)+'\n');
  const result=await m.dryRun(backup.manifest.id);assert.equal(result.backupValid,false);assert.equal(result.stopped,true);assert.equal(result.restored,false);assert.equal(c.attempts.length,1);
});
