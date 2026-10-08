import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { upgradeFixture, upgradeConfig, upgradeInstructions } from './fixtures/extraction-upgrade.js';
import { executionFixture } from './fixtures/extraction-execution.js';
import { createExecutionStore } from '../lib/offer-import/execution-store.js';
import { createArtifactStore } from '../lib/offer-import/extraction-artifacts.js';
import { createExtractionService, fakeExtractionConfig } from '../lib/offer-import/extraction-service.js';
import { validateExecutionLedger, requestDigest } from '../lib/offer-import/execution-contract.js';
import { validateExecutionLedgerAny as ledgerV2 } from '../lib/offer-import/execution-v2-contract.js';
import { validateExecutionLedgerAny, eligibleUpgradeSource, sendBindingHash } from '../lib/offer-import/execution-v3-contract.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { capture, snapshotHash, hash } from '../lib/maintenance/snapshot.js';
import { digest, bytesHash } from '../lib/ai/safety-storage.js';
import { extractionProfile, profileConfiguration } from '../lib/ai/extraction-profile.js';
import { historicalExtractionProfiles, auditExtractionInput, validateProfileSnapshot } from '../lib/ai/extraction-profile-registry.js';
import { buildExtractionPayload, estimateExtractionInput } from '../lib/ai/extraction-payload.js';
import { blockedConnections } from './helpers/network-guard.js';

const ledgerPath = c => path.join(c.root, 'extraction-executions/ledger.json');
const snapshot = async c => snapshotHash(await capture(c.root));
const approve = (c, child, s = c.service) => s.approve(child.id, child.revision, { confirm: true, requestHash: child.requestHash });

test('upgrade: new configuration, exact materials, immutable parent, separate bound send and accounting', async t => {
  const c = await upgradeFixture(t);
  const parent = (await c.store.read()).executions[0];
  const activation = await fs.readFile(path.join(c.root, 'ai-budget/activation.json'));
  const before = await c.coordinator.transaction(common => common.totals);
  const v = await c.service.preview(c.source.id);
  assert.equal(v.currentConfiguration, false); assert.equal(v.token, null); assert.equal(v.upgradeAvailable, true); assert.equal(v.reanalysisAvailable, false);
  const child = await c.prepareChild();
  assert.equal(child.schemaVersion, 3); assert.equal(child.state, 'prepared'); assert.equal(child.budget.reservedMilliYen, 0);
  assert.notEqual(child.configuration.hash, c.source.configuration.hash);
  assert.notEqual(child.requestHash, c.source.requestHash);
  assert.notEqual(child.estimate.maximumReservedMilliYen, c.source.estimate.maximumReservedMilliYen);
  assert.equal(child.inputArtifact.hash, c.source.inputArtifact.hash); assert.notEqual(child.inputArtifact.id, c.source.inputArtifact.id);
  const content = await createArtifactStore(c.root).read(child.inputArtifact, child.id, 'input');
  assert.deepEqual(content.content, c.value);
  assert.deepEqual(child.targetOffer, c.source.targetOffer); assert.deepEqual(child.documents, c.source.documents);
  assert.equal(child.upgrade.sourceHash, digest(c.source)); assert.equal(child.upgrade.sourceConfigurationHash, c.source.configuration.hash);
  assert.equal(child.upgrade.destinationConfigurationHash, child.configuration.hash);
  assert.equal(child.profileSnapshot.profile.instructions, upgradeInstructions);
  assert.deepEqual(await c.coordinator.transaction(common => common.totals), before);
  assert.equal(c.attempts.length, 1);
  const a = await approve(c, child); assert.equal(a.approval.bindingHash, sendBindingHash(child));
  const reserved = await c.coordinator.transaction(common => common.totals);
  assert.equal(reserved.simulation.bookedMilliYen, c.source.budget.bookedMilliYen);
  assert.equal(reserved.simulation.reservedMilliYen, child.estimate.maximumReservedMilliYen);
  const result = await c.service.execute(child.id, a.revision); assert.equal(result.state, 'succeeded');
  assert.equal(c.attempts.length, 2); assert.deepEqual(c.attempts[1].configuration, child.configuration);
  assert.equal(c.upgradeCalls[0].prompt, upgradeInstructions);
  assert.deepEqual((await c.store.read()).executions[0], parent);
  assert.deepEqual(await fs.readFile(path.join(c.root, 'ai-budget/activation.json')), activation);
  assert.ok((await c.imports.get(result.savedImport.id)).candidates.every(x => x.review.decision === 'pending' && x.review.verification === 'unverified'));
  const totals = await c.coordinator.transaction(common => common.totals);
  assert.equal(totals.simulation.bookedMilliYen, c.source.budget.bookedMilliYen + result.budget.bookedMilliYen);
  assert.equal(totals.simulation.reservedMilliYen, 0); assert.equal(totals.real.bookedMilliYen, 0);
  assert.equal((await createMaintenanceService(c.root).integrity()).status, 'normal');
});

test('upgrade: verified historical profiles audit with their own request instructions and estimator', () => {
  const input = { targetOffer: { id: randomUUID(), revision: 1 }, documents: [] };
  const old = historicalExtractionProfiles[0];
  assert.equal(digest(profileConfiguration(old)), '1e7dfc3566e9e310e296aa6187159629ce31467a69f5b021c349a608dc953d1e');
  for (const p of historicalExtractionProfiles) {
    const config = profileConfiguration(p);
    const payload = buildExtractionPayload(input, p);
    const record = { provider: 'openai', model: p.model, configuration: { ...config, hash: digest(config) },
      estimate: { inputTokens: estimateExtractionInput(payload, p).inputTokens } };
    assert.deepEqual(auditExtractionInput(record, input).payload, payload);
    assert.equal(auditExtractionInput(record, input).profile.instructions, p.instructions);
    const captured = { schemaVersion: p.processingContract?.wireSchemaVersion === 3 ? 3 : p.processingContract ? 2 : 1, profile: p };
    assert.deepEqual(validateProfileSnapshot(captured, record), captured);
    const unknown = structuredClone(record); unknown.configuration.version += '-unregistered';
    assert.throws(() => auditExtractionInput(unknown, input), { code: 'historical_profile_unknown' });
    const bad = structuredClone(captured); bad.profile.instructions += 'fictional tampering';
    assert.throws(() => validateProfileSnapshot(bad, record));
  }
  assert.notEqual(old.instructions, extractionProfile.instructions);
});

for (const state of ['prepared','approved','sending','response_received','validated','import_saving','import_save_failed','succeeded','failed_before_request','unknown','recovery_required']) {
  test(`upgrade: source ${state} ineligible`, async t => {
    const c = await upgradeFixture(t); const invalid = structuredClone(c.source); invalid.state = state;
    assert.throws(() => eligibleUpgradeSource(invalid));
  });
}
for (const defect of ['usage','reservation','recovery','unknown','validated','planned','saved','phase']) {
  test(`upgrade: source ${defect} ineligible`, async t => {
    const c = await upgradeFixture(t); const r = structuredClone(c.source);
    if (defect === 'usage') r.budget.usage = null;
    if (defect === 'reservation') r.budget.reservedMilliYen = 1;
    if (defect === 'recovery') r.recoveryRequired = true;
    if (defect === 'unknown') r.unknownReason = 'unknown';
    if (defect === 'validated') r.validatedArtifact = {};
    if (defect === 'planned') r.plannedImport = {};
    if (defect === 'saved') r.savedImport = {};
    if (defect === 'phase') r.error.phase = 'request';
    assert.throws(() => eligibleUpgradeSource(r));
  });
}

test('upgrade: same configuration refused, normal duplicate refused, only failed leaf can prepare', async t => {
  const c = await upgradeFixture(t);
  await assert.rejects(c.oldService.upgradePreview(c.source.id), { code: 'upgrade_same_configuration' });
  await assert.rejects(c.service.prepare(c.value), { code: 'duplicate_request' });
  const child = await c.prepareChild();
  await assert.rejects(c.service.upgradePreview(c.source.id), { code: 'upgrade_child_exists' });
  await assert.rejects(c.service.reanalysisPreview(c.source.id));
  await assert.rejects(c.service.upgradePreview(child.id));
  await assert.rejects(c.store.create(child), { code: 'reanalysis_dedicated_only' });
});

test('upgrade: preparation approval cannot send; sending approval cannot prepare; source/restart/expiry bound', async t => {
  const c = await upgradeFixture(t); const v = await c.service.upgradePreview(c.source.id);
  await assert.rejects(c.service.prepareUpgrade(c.source.id, v.token, { confirm: false }));
  await assert.rejects(c.service.prepareUpgrade(randomUUID(), v.token, { confirm: true }));
  await assert.rejects(c.service.prepareUpgrade(c.source.id, v.token + 'x', { confirm: true }));
  await assert.rejects(c.reopen().prepareUpgrade(c.source.id, v.token, { confirm: true }));
  await assert.rejects(c.service.prepareReanalysis(c.source.id, v.token, { confirm: true }));
  const legacy = await c.oldService.reanalysisPreview(c.source.id);
  await assert.rejects(c.service.prepareUpgrade(c.source.id, legacy.token, { confirm: true }));
  const child = await c.service.prepareUpgrade(c.source.id, v.token, { confirm: true });
  await assert.rejects(c.service.execute(child.id, 1));
  await assert.rejects(c.service.approveAndExecute(child.id, v.token, { confirm: true }));
  const s = c.reopen(); const send = await s.preview(child.id); assert.ok(send.token);
  await assert.rejects(s.prepareUpgrade(c.source.id, send.token, { confirm: true }));
  await assert.rejects(s.approveAndExecute(child.id, send.token, { confirm: false }));
  const result = await s.approveAndExecute(child.id, send.token, { confirm: true }); assert.equal(result.state, 'succeeded');
  await assert.rejects(s.approveAndExecute(child.id, send.token, { confirm: true })); assert.equal(c.attempts.length, 2);
});

test('upgrade: idempotent prepared result only; different operation cannot create another child', async t => {
  const c = await upgradeFixture(t); const v = await c.service.upgradePreview(c.source.id); const other = await c.service.upgradePreview(c.source.id);
  const child = await c.service.prepareUpgrade(c.source.id, v.token, { confirm: true });
  assert.deepEqual(await c.service.prepareUpgrade(c.source.id, v.token, { confirm: true }), child);
  await assert.rejects(c.service.prepareUpgrade(c.source.id, other.token, { confirm: true }), { code: 'upgrade_child_exists' });
  const a = await approve(c, child);
  await assert.rejects(c.service.prepareUpgrade(c.source.id, v.token, { confirm: true }), { code: 'upgrade_already_prepared' });
  assert.equal(c.attempts.length, 1); assert.equal(a.budget.reservedMilliYen, child.estimate.maximumReservedMilliYen);
});
for (const same of [true, false]) test(`upgrade: concurrent ${same ? 'same' : 'different'} preparation creates at most one child`, async t => {
  const c = await upgradeFixture(t); const v = await c.service.upgradePreview(c.source.id); const w = same ? v : await c.service.upgradePreview(c.source.id);
  const results = await Promise.allSettled([v, w].map(p => c.service.prepareUpgrade(c.source.id, p.token, { confirm: true })));
  assert.equal((await c.store.read()).executions.length, 2); assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.equal((await fs.readdir(path.join(c.root, 'extraction-artifacts'))).length, 2); assert.equal(c.attempts.length, 1);
});

test('upgrade: concurrent sending has one durable sending owner and one provider call', async t => {
  const c = await upgradeFixture(t); const child = await c.prepareChild(); const a = await approve(c, child);
  const results = await Promise.allSettled([1,2].map(() => c.service.execute(a.id, a.revision)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(c.attempts.length, 2);
});

for (const stage of ['after_upgrade_input','before_upgrade_persist','after_upgrade_persist']) test(`upgrade: partial ${stage} never resumes or repairs`, async t => {
  const c = await upgradeFixture(t); const s = c.reopen({ fault: async p => { if (p === stage) throw Error('FICTIONAL_PRIVATE_FAILURE'); } });
  const v = await s.upgradePreview(c.source.id);
  await assert.rejects(s.prepareUpgrade(c.source.id, v.token, { confirm: true }), { preparePersistence: 'uncertain' });
  const restarted = c.reopen();
  if (stage === 'after_upgrade_persist') {
    assert.equal((await c.store.read()).executions.length, 2);
    await assert.rejects(restarted.upgradePreview(c.source.id), { code: 'upgrade_child_exists' });
    const child = (await c.store.read()).executions[1].revisions[0]; assert.ok((await restarted.preview(child.id)).token);
  } else {
    assert.equal((await c.store.read()).executions.length, 1);
    await assert.rejects(restarted.upgradePreview(c.source.id), { code: 'reanalysis_integrity' });
  }
  assert.equal(c.attempts.length, 1); assert.ok(!JSON.stringify(await c.store.read()).includes('FICTIONAL_PRIVATE_FAILURE'));
});

test('upgrade: durable sending interruption preserves reservation and explicit unknown never resends', async t => {
  const c = await upgradeFixture(t); const s = c.reopen({ fault: async p => { if (p === 'after_sending') throw Error('fictional interruption'); } });
  const child = await c.prepareChild(s); const a = await approve(c, child, s); await assert.rejects(s.execute(a.id, a.revision));
  const latest = await c.store.get(a.id); assert.equal(latest.state, 'sending'); assert.equal(c.attempts.length, 1);
  const restarted = c.reopen(); await assert.rejects(restarted.execute(a.id, latest.revision));
  const unknown = await restarted.recover(a.id, latest.revision, { confirm: true, operation: 'mark_interrupted' });
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.budget.reservedMilliYen, child.estimate.maximumReservedMilliYen);
  await assert.rejects(restarted.upgradePreview(a.id)); await assert.rejects(c.generation.execute(c.plan, c.generation.confirmation(c.plan)), { code: 'ai_in_progress' });
});

test('upgrade: provider unknown holds new reservation and old settled cost unchanged', async t => {
  const c = await upgradeFixture(t); let calls = 0; const s = c.reopen({ provider: { kind: 'fake', async extract() { calls++; throw Error('FICTIONAL_UNSAVED_RESPONSE'); } } });
  const child = await c.prepareChild(s); const a = await approve(c, child, s); const r = await s.execute(a.id, a.revision);
  assert.equal(r.state, 'unknown'); assert.equal(calls, 1); assert.equal(r.budget.reservedMilliYen, child.estimate.maximumReservedMilliYen);
  assert.deepEqual(await c.store.get(c.source.id), c.source); await assert.rejects(s.execute(r.id, r.revision));
  assert.ok(!JSON.stringify(await c.store.read()).includes('FICTIONAL_UNSAVED_RESPONSE'));
});

test('upgrade: invalid child response saves only fixed reason, not response body or exception', async t => {
  const c = await upgradeFixture(t); const marker = 'FICTIONAL_UNSAVED_RESPONSE';
  const s = c.reopen({ provider: { kind: 'fake', async extract({ input }) {
    const d = input.documents[0];
    return { extraction: { schemaVersion: 1, candidates: [{ target: 'facts', category: 'feature', conversionKey: 'group',
      purpose: 'fact', usage: 'publishable', text: marker, evidence: [{ documentId: d.id, blockId: d.blocks[0].id, start: 0, end: 1, quote: marker }] }] },
      usage: { inputTokens: 10, outputTokens: 20 } };
  } } });
  const child = await c.prepareChild(s); const a = await approve(c, child, s); const r = await s.execute(a.id, a.revision);
  assert.equal(r.error.code, 'validation_candidate_conversion_key'); assert.equal(r.state, 'failed_after_request');
  const files = (await capture(c.root)).files; for (const content of Object.values(files)) assert.ok(!content.toString().includes(marker));
  assert.equal((await c.imports.list()).length, 0); assert.deepEqual(await c.store.get(c.source.id), c.source);
});

for (const issue of ['activation','artifact','partial','lock','target','budget']) test(`upgrade: ${issue} blocks before child preparation`, async t => {
  const c = await upgradeFixture(t); const count = (await fs.readdir(path.join(c.root, 'extraction-artifacts'))).length;
  if (issue === 'activation') await fs.rename(path.join(c.root, 'ai-budget/activation.json'), path.join(c.root, 'removed-activation.json'));
  if (issue === 'artifact') await fs.writeFile(path.join(c.root, 'extraction-artifacts', c.source.inputArtifact.id + '.json'), '{}');
  if (issue === 'partial') await fs.writeFile(path.join(c.root, 'extraction-artifacts/.write-intent'), 'fictional');
  if (issue === 'lock') await fs.mkdir(path.join(c.root, 'ai-budget/.lock'));
  if (issue === 'target') { const current = await c.offers.get(c.offer.id); const { schemaVersion,id,revision,createdAt,updatedAt,...input } = current; await c.offers.update(id,revision,{...input,name:'架空の変更'}); }
  if (issue === 'budget') { const distinct = structuredClone(c.value); distinct.documents[0].label += 'other'; const r = await c.service.prepare(distinct); await approve(c, r); }
  await assert.rejects(c.service.upgradePreview(c.source.id));
  assert.equal((await fs.readdir(path.join(c.root, 'extraction-artifacts'))).length, count + (issue === 'partial' || issue === 'budget' ? 1 : 0));
  assert.equal(c.attempts.length, 1);
});

for (const field of ['sourceHash','sourceRevision','sourceConfigurationHash','sourceRequestHash','destinationConfigurationHash','destinationRequestHash','lineageHash','kind','reasonCode','operationId','snapshot','binding']) test(`upgrade: tampered ${field} fails ledger/maintenance`, async t => {
  const c = await upgradeFixture(t); const child = await c.prepareChild(); await approve(c, child);
  const ledger = await c.store.read();
  for (const r of ledger.executions[1].revisions) {
    if (field === 'snapshot') r.profileSnapshot.profile.instructions += 'fictional alteration';
    else if (field === 'binding') { if (r.approval) r.approval.bindingHash = '0'.repeat(64); }
    else r.upgrade[field] = field === 'sourceRevision' ? 999 : field === 'operationId' ? randomUUID() : field === 'kind' || field === 'reasonCode' ? 'unapproved' : '0'.repeat(64);
  }
  await fs.writeFile(ledgerPath(c), JSON.stringify(ledger));
  assert.equal((await createMaintenanceService(c.root).integrity()).status, 'error');
});

test('upgrade: mixed v1/v2/v3 preserves v2 semantics and reads without startup writes', async t => {
  const c = await upgradeFixture(t);
  const v2provider = { kind: 'fake', async extract() { return { extraction: {}, usage: { inputTokens: 10, outputTokens: 20 } }; } };
  const old = createExtractionService({ ...c.options, provider: v2provider });
  const prep = await old.reanalysisPreview(c.source.id); const child2 = await old.prepareReanalysis(c.source.id, prep.token, { confirm: true });
  const a2 = await approve(c, child2, old); const failed = await old.execute(a2.id, a2.revision);
  const v3 = await c.prepareChild(c.service, failed); const ledger = await c.store.read();
  assert.equal(ledger.schemaVersion, 3); assert.deepEqual(ledger.executions.map(e => e.revisions[0].schemaVersion), [1,2,3]);
  assert.deepEqual(validateExecutionLedgerAny(ledger), ledger); assert.throws(() => ledgerV2(ledger)); assert.throws(() => validateExecutionLedger(ledger));
  const before = await snapshot(c); c.reopen(); await createExecutionStore(c.root).read(); assert.equal(await snapshot(c), before);
  assert.equal((await createMaintenanceService(c.root).integrity()).status, 'normal');
  assert.equal(v3.upgrade.sourceExecutionId, failed.id);
});

test('upgrade: failed v3 child may use unchanged same-configuration v2; rollback upgrade forbidden', async t => {
  const c = await upgradeFixture(t); const s = c.reopen({ provider: { kind: 'fake', async extract() { return { extraction: {}, usage: { inputTokens: 10, outputTokens: 20 } }; } } });
  const child = await c.prepareChild(s); const a = await approve(c, child, s); const failed = await s.execute(a.id, a.revision);
  const rollback = createExtractionService({ ...c.options, provider: c.provider });
  await assert.rejects(rollback.upgradePreview(failed.id), { code: 'upgrade_configuration_repeated' });
  const v = await s.reanalysisPreview(failed.id); const same = await s.prepareReanalysis(failed.id, v.token, { confirm: true });
  assert.equal(same.schemaVersion, 2); assert.deepEqual(same.configuration, failed.configuration);
  assert.equal(same.requestHash, failed.requestHash); assert.deepEqual(same.estimate, failed.estimate);
  assert.equal((await c.store.read()).schemaVersion, 3);
  assert.equal((await createMaintenanceService(c.root).integrity()).status, 'normal');
});

test('upgrade: new backup manifest v3 and old v1/v2 execution backups remain readable; dry-run changes nothing', async t => {
  const c = await upgradeFixture(t); const m = createMaintenanceService(c.root, { now: c.now });
  const old = await m.create(); assert.equal(old.manifest.schemaVersion, 2); assert.equal(old.manifest.contracts.extractionExecution, 1);
  await c.prepareChild(); const backup = await m.create(); assert.equal(backup.manifest.schemaVersion, 3); assert.equal(backup.manifest.contracts.extractionExecution, 3); assert.equal(backup.manifest.contracts.extractionProfileSnapshot, 1);
  const before = await snapshot(c); const check = await m.dryRun(backup.manifest.id);
  assert.equal(check.status, 'normal'); assert.equal(check.upgradeCoverage, 'covered'); assert.equal(check.reanalysisCoverage, 'covered');
  assert.equal(check.restored, false); assert.equal(await snapshot(c), before);
  const legacy = await m.dryRun(old.manifest.id); assert.equal(legacy.backupValid, true); assert.equal(legacy.upgradeCoverage, 'not_covered');
});

test('upgrade: published v3 schema retains v1/v2 references and immutable snapshot schema', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../schemas/extraction-execution-v3.schema.json', import.meta.url)));
  const refs = schema.properties.executions.items.properties.revisions.items.anyOf.map(r => r.$ref);
  assert.ok(refs.includes('extraction-execution.schema.json#/$defs/execution')); assert.ok(refs.includes('extraction-execution-v2.schema.json#/$defs/execution'));
  assert.equal(schema.$defs.execution.properties.profileSnapshot.$ref, 'extraction-profile-snapshot.schema.json');
});
test('upgrade: no outward connection attempts', () => assert.equal(blockedConnections.length, 0));

for (const stage of ['prepare','sending']) test(`upgrade: actual ${stage} durable-save acknowledgement loss stops without resend`, async t => {
  const c = await upgradeFixture(t); let injection = true;
  const fileSystem = { ...fs, async rename(from,to) {
    if (injection && to === ledgerPath(c)) { await fs.rename(from,to); injection = false; throw Error('FICTIONAL_SAVE_ACK_FAILURE'); }
    return fs.rename(from,to);
  } };
  if (stage === 'prepare') {
    const store = createExecutionStore(c.root, { fileSystem, now: c.now }); const s = c.reopen({ store }); const v = await s.upgradePreview(c.source.id);
    await assert.rejects(s.prepareUpgrade(c.source.id,v.token,{confirm:true})); await assert.rejects(c.reopen().upgradePreview(c.source.id));
  } else {
    const child = await c.prepareChild(); const a = await approve(c,child);
    const store = createExecutionStore(c.root,{fileSystem,now:c.now}); const s = c.reopen({store});
    await assert.rejects(s.execute(a.id,a.revision)); await assert.rejects(c.reopen().execute(a.id,a.revision));
  }
  assert.equal(c.attempts.length,1);
});

for (const corruption of ['same_configuration','second_child','missing_parent','cycle','repeated_destination','changed_target','changed_documents','changed_input','changed_provider']) test(`upgrade: recomputed digests cannot hide ${corruption}`, async t => {
  const c = await upgradeFixture(t); await c.prepareChild(); const ledger = await c.store.read(); const r = ledger.executions[1].revisions[0];
  if (corruption === 'same_configuration') { r.configuration = structuredClone(c.source.configuration); r.profileSnapshot.profile.configuration = structuredClone(r.configuration); r.profileSnapshot.profile.instructions = c.oldService ? (await c.oldService.preview(c.source.id)).payload.prompt : ''; }
  if (corruption === 'second_child') { const clone = structuredClone(ledger.executions[1]); clone.revisions[0].id = randomUUID(); clone.revisions[0].inputArtifact.id = randomUUID(); clone.revisions[0].upgrade.operationId = randomUUID(); ledger.executions.push(clone); }
  if (corruption === 'missing_parent') ledger.executions.shift();
  if (corruption === 'cycle') r.upgrade.sourceExecutionId = r.id;
  if (corruption === 'repeated_destination') r.upgrade.destinationConfigurationHash = c.source.configuration.hash;
  if (corruption === 'changed_target') r.targetOffer.revision++;
  if (corruption === 'changed_documents') r.documents[0].label += 'changed';
  if (corruption === 'changed_input') r.inputArtifact.hash = '0'.repeat(64);
  if (corruption === 'changed_provider') r.provider = 'openai';
  r.requestHash = requestDigest(r.inputArtifact.hash,r.configuration,r.provider,r.model);
  for (const e of ledger.executions.filter(e => e.revisions[0].upgrade)) {
    const first = e.revisions[0]; const a = first.upgrade;
    if (corruption !== 'repeated_destination') a.destinationConfigurationHash = first.configuration.hash;
    a.destinationRequestHash = first.requestHash; const {lineageHash,...fields} = a; a.lineageHash = digest(fields);
  }
  assert.throws(() => validateExecutionLedgerAny(ledger));
});

for (const defect of ['coverage','snapshot','source']) test(`upgrade: backup dry-run rejects ${defect} despite recomputed transport hashes`, async t => {
  const c = await upgradeFixture(t); await c.prepareChild(); const m = createMaintenanceService(c.root,{now:c.now}); const b = await m.create();
  const archive = path.join(c.root,'maintenance-backups',b.manifest.id); const manifestPath = path.join(archive,'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  if (defect === 'coverage') { manifest.schemaVersion = 2; manifest.contracts.extractionExecution = 2; delete manifest.contracts.extractionProfileSnapshot; }
  else {
    const relative = 'extraction-executions/ledger.json'; const file = path.join(archive,'payload',relative); const ledger = JSON.parse(await fs.readFile(file));
    if (defect === 'snapshot') delete ledger.executions[1].revisions[0].profileSnapshot;
    else { ledger.executions[1].revisions[0].upgrade.sourceConfigurationHash = '0'.repeat(64); const a = ledger.executions[1].revisions[0].upgrade; const {lineageHash,...fields} = a; a.lineageHash = digest(fields); }
    const bytes = Buffer.from(JSON.stringify(ledger)); await fs.writeFile(file,bytes);
    const f = manifest.files.find(f=>f.path===relative); manifest.totalBytes += bytes.length-f.size; f.size=bytes.length; f.sha256=hash(bytes);
    const snapshot = {directories:manifest.directories,files:{},notes:[]};
    for (const entry of manifest.files) snapshot.files[entry.path]=await fs.readFile(path.join(archive,'payload',entry.path));
    manifest.snapshotHash=snapshotHash(snapshot);
  }
  const raw=Buffer.from(JSON.stringify(manifest)); await fs.writeFile(manifestPath,raw); await fs.writeFile(path.join(archive,'manifest.sha256'),hash(raw)+'\n');
  const before=await snapshot(c); const result=await m.dryRun(b.manifest.id); assert.equal(result.backupValid,false); assert.equal(result.status,'error'); assert.equal(await snapshot(c),before);
});

test('upgrade: expired preparation/send tokens and target/config change after preparation do not send', async t => {
  const c = await upgradeFixture(t); let instant = c.now(); const s = c.reopen({now:()=>instant});
  const v = await s.upgradePreview(c.source.id); instant = new Date(instant.getTime()+16*60*1000);
  await assert.rejects(s.prepareUpgrade(c.source.id,v.token,{confirm:true})); assert.equal((await c.store.read()).executions.length,1);
  instant=c.now(); const child=await c.prepareChild(s); const send=await s.preview(child.id); instant=new Date(instant.getTime()+16*60*1000);
  await assert.rejects(s.approveAndExecute(child.id,send.token,{confirm:true}));
  const changed=c.reopen({config:{...upgradeConfig,version:'fictional-next-profile'}});
  assert.equal((await changed.preview(child.id)).token,null); await assert.rejects(changed.approve(child.id,1,{confirm:true,requestHash:child.requestHash}));
  const o=await c.offers.get(c.offer.id);const {schemaVersion,id,revision,createdAt,updatedAt,...input}=o;await c.offers.update(id,revision,input);
  await assert.rejects(c.service.approve(child.id,1,{confirm:true,requestHash:child.requestHash})); assert.equal(c.attempts.length,1);
  assert.equal((await c.store.get(child.id)).budget.reservedMilliYen,0);
});

test('upgrade: exhausted simulation budget uses destination estimate without policy reset', async t => {
  const c = await upgradeFixture(t, {policy:{schemaVersion:1,version:'fictional-small-cap',realStopMilliYen:null,simulationStopMilliYen:280}});
  // Original reservation is 273; the upgraded reservation is 283 and cannot fit.
  const before=await snapshot(c);await assert.rejects(c.service.upgradePreview(c.source.id),{code:'common_budget_exceeded'});
  assert.equal(await snapshot(c),before);assert.equal(c.attempts.length,1);
});

test('upgrade: local import save recovery stays local and cannot become an upgrade source', async t => {
  const c=await upgradeFixture(t);const s=c.reopen({fault:async p=>{if(p==='before_import_save')throw Error('FICTIONAL_PRIVATE_SAVE');}});
  const child=await c.prepareChild(s);const a=await approve(c,child,s);const failed=await s.execute(a.id,a.revision);assert.equal(failed.state,'import_save_failed');
  await assert.rejects(c.service.upgradePreview(failed.id));const result=await c.service.recover(failed.id,failed.revision,{confirm:true,operation:'save_only'});
  assert.equal(result.state,'succeeded');assert.equal(c.attempts.length,2);assert.deepEqual(await c.store.get(c.source.id),c.source);
});

test('upgrade: snapshot secrets stop before child artifact and are never persisted', async t => {
  const c=await upgradeFixture(t);const instructions='Cookie: FICTIONAL_PRIVATE_COOKIE';
  const s=c.reopen({simulationInstructions:instructions,config:{...upgradeConfig,promptHash:bytesHash(instructions)}});
  const before=await snapshot(c);await assert.rejects(s.upgradePreview(c.source.id));assert.equal(await snapshot(c),before);assert.equal(c.attempts.length,1);
});

for (const field of ['reanalysis','unknownExtra','missingSnapshot']) test(`upgrade: strict record contract rejects ${field}`,async t=>{
  const c=await upgradeFixture(t);await c.prepareChild();const ledger=await c.store.read();const r=ledger.executions[1].revisions[0];
  if(field==='missingSnapshot')delete r.profileSnapshot;else r[field]={};assert.throws(()=>validateExecutionLedgerAny(ledger));
});

test('upgrade: stale source target after preparation token stops without child/artifact',async t=>{
  const c=await upgradeFixture(t);const v=await c.service.upgradePreview(c.source.id);
  const o=await c.offers.get(c.offer.id);const {schemaVersion,id,revision,createdAt,updatedAt,...input}=o;await c.offers.update(id,revision,input);
  const before=await snapshot(c);await assert.rejects(c.service.prepareUpgrade(c.source.id,v.token,{confirm:true}),{code:'target_revision_conflict'});
  assert.equal(await snapshot(c),before);assert.equal((await c.store.read()).executions.length,1);assert.equal(c.attempts.length,1);
});

for(const otherState of ['approved','unknown','recovery_required','import_save_failed'])test(`upgrade: other ${otherState} globally blocks new preparation and approval`,async t=>{
  const c=await upgradeFixture(t);const child=await c.prepareChild();const other=structuredClone(c.value);other.documents[0].label+='fictional other';
  const provider={kind:'fake',async extract(){if(otherState==='unknown')throw Error('FICTIONAL_PRIVATE_OTHER');return c.provider.extract({input:c.value,configuration:{}});}};
  const otherService=c.reopen({provider,fault:async p=>{if(otherState==='recovery_required'&&p==='before_validated_artifact'||otherState==='import_save_failed'&&p==='before_import_save')throw Error('FICTIONAL_PRIVATE_OTHER');}});
  const prepared=await otherService.prepare(other);const approved=await approve(c,prepared,otherService);
  if(otherState!=='approved')assert.equal((await otherService.execute(approved.id,approved.revision)).state,otherState);
  const before=await snapshot(c);await assert.rejects(c.service.approve(child.id,child.revision,{confirm:true,requestHash:child.requestHash}));assert.equal(await snapshot(c),before);
  assert.equal((await c.store.get(child.id)).budget.reservedMilliYen,0);
});

test('upgrade: readonly audit of fictional old OpenAI history stays normal after current profile change',async t=>{
  const c=await upgradeFixture(t);const ledger=await c.store.read();const p=historicalExtractionProfiles[0];const conf=profileConfiguration(p);const configuration={...conf,hash:digest(conf)};
  const input=(await createArtifactStore(c.root).read(c.source.inputArtifact,c.source.id,'input')).content;
  const tokens=estimateExtractionInput(buildExtractionPayload(input,p),p).inputTokens;
  const {costMilliYen}=await import('../lib/ai/budget-coordinator.js');
  for(const r of ledger.executions[0].revisions){
    r.provider='openai';r.model=p.model;r.configuration=configuration;r.requestHash=requestDigest(r.inputArtifact.hash,configuration,r.provider,r.model);
    r.estimate={inputBytes:r.inputArtifact.bytes,inputTokens:tokens,estimatedMilliYen:costMilliYen({inputTokens:tokens,outputTokens:configuration.maxOutputTokens},configuration),maximumReservedMilliYen:costMilliYen({inputTokens:configuration.maxInputTokens,outputTokens:configuration.maxOutputTokens},configuration)};
    if(r.approval)r.approval.hash=r.requestHash;
    if(r.budget.state==='reserved')r.budget.reservedMilliYen=r.estimate.maximumReservedMilliYen;
    if(r.budget.usage){r.budget.bookedMilliYen=costMilliYen(r.budget.usage,configuration);r.responseHash=digest({extraction:{},usage:r.budget.usage});}
  }
  await fs.writeFile(ledgerPath(c),JSON.stringify(ledger));const before=await snapshot(c);
  const m=createMaintenanceService(c.root,{now:c.now});assert.equal((await m.integrity()).status,'normal');assert.equal(await snapshot(c),before);
  const b=await m.create();assert.equal((await m.dryRun(b.manifest.id)).status,'normal');assert.equal(await snapshot(c),before);
  const r=ledger.executions[0].revisions[0];r.configuration.version+='-unknown';const {hash:ignored,...cfg}=r.configuration;r.configuration.hash=digest(cfg);
  assert.throws(()=>auditExtractionInput(r,input),{code:'historical_profile_unknown'});
});
