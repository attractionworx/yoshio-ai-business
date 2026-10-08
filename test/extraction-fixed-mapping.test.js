import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { extractionProfile, profileConfiguration } from '../lib/ai/extraction-profile.js';
import { historicalExtractionProfiles, validateProfileSnapshot, auditExtractionInput } from '../lib/ai/extraction-profile-registry.js';
import { buildExtractionPayload, estimateExtractionInput } from '../lib/ai/extraction-payload.js';
import { digest, bytesHash } from '../lib/ai/safety-storage.js';
import { resolveEvidence, inverseEvidenceResolution, processingContract } from '../lib/offer-import/evidence-resolution.js';
import { validateExtraction } from '../lib/offer-import/validation.js';
import { v4Fixture, wireFixture, v4Config } from './fixtures/extraction-v4.js';
import { regulationFixture } from './fixtures/regulation-import.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { capture, snapshotHash } from '../lib/maintenance/snapshot.js';
import { extractionPages } from '../lib/offer-import/extraction-pages.js';
import { blockedConnections } from './helpers/network-guard.js';

const mappings = [
  ['targetAudience', 'audience', null, 'fact', 'publishable'],
  ['sellingPoints', 'selling_point', null, 'fact', 'publishable'],
  ['prohibitedExpressions', 'prohibition', null, 'restriction', 'constraint_only'],
  ['eligibility', 'eligibility', 'fictional-group', 'conversion_condition', 'publishable'],
  ['approvalConditions', 'approval', 'fictional-group', 'conversion_condition', 'constraint_only'],
  ['rejectionConditions', 'rejection', 'fictional-group', 'conversion_condition', 'constraint_only'],
  ['reward_evidence', 'reward', 'fictional-group', 'fact', 'internal_only'],
];
function candidateWire([target, category, conversionKey, purpose, usage]) {
  const wire = wireFixture();
  wire.candidates = [{ ...wire.candidates[0], target, category, conversionKey, purpose, usage }];
  return wire;
}
for (const mapping of mappings) {
  test(`fixed mapping: ${mapping[0]} preserves exact v4 resolution and candidate acceptance`, () => {
    const wire = candidateWire(mapping), { documents } = regulationFixture();
    const internal = resolveEvidence(wire, documents);
    assert.deepEqual(inverseEvidenceResolution(internal), wire);
    assert.deepEqual(validateExtraction(internal, documents), internal);
    assert.equal(internal.candidates[0].category, mapping[1]);
  });
  test(`fixed mapping: ${mapping[0]} wrong category remains rejected without rewriting`, () => {
    const wire = candidateWire(mapping), { documents } = regulationFixture();
    wire.candidates[0].category = 'other';
    const before = structuredClone(wire);
    assert.throws(() => resolveEvidence(wire, documents), { code: 'validation_candidate_target_category' });
    assert.deepEqual(wire, before);
  });
}
test('fixed mapping: outbound instructions make all mappings mandatory with reverse and existing conditions', () => {
  const text = buildExtractionPayload(regulationFixture(), extractionProfile).instructions;
  for (const [target, category] of mappings) assert.ok(text.includes(`${target}=${category}`));
  for (const clause of ['分類の参考ではなく固定mapping', 'categoryを候補内容から独立して判断してはいけません',
    'categoryは対応表から機械的に決定', '全candidate', '固定mappingと逆方向条件を自己検査',
    'category=rewardはtarget=reward_evidenceかつusage=internal_onlyに限ります',
    'category=prohibitionはtarget=prohibitedExpressionsだけ', 'conversionKey・purpose・usageの既存条件もすべて維持']) assert.ok(text.includes(clause), clause);
});
test('fixed mapping: old/new registered profiles retain wire/processing identity and audit their own instructions', () => {
  const old = historicalExtractionProfiles.find(p => p.instructionsVersion === 'regulation-quote-local-resolution-v1');
  const current = historicalExtractionProfiles.find(p => p.instructionsVersion === 'regulation-quote-fixed-mapping-v1');
  assert.equal(digest(old), 'ba821e7ed4e0267a47b50ea3d5b068adce686f9d2ad0149b92d92cf24f7f1f49');
  assert.equal(current.instructionsVersion, 'regulation-quote-fixed-mapping-v1');
  assert.notEqual(digest(current), digest(extractionProfile));
  const stripped = p => { const { instructions, instructionsVersion, profileCodeHash, ...rest } = p; return rest; };
  assert.deepEqual(stripped(old), stripped(current));
  assert.notEqual(digest(profileConfiguration(old)), digest(profileConfiguration(current)));
  const input = { targetOffer: { id: '00000000-0000-4000-8000-000000000001', revision: 1 }, documents: [] };
  for (const p of [old, current]) {
    const config = profileConfiguration(p), payload = buildExtractionPayload(input, p);
    const record = { schemaVersion: 4, provider: 'openai', model: p.model, configuration: { ...config, hash: digest(config) },
      estimate: { inputTokens: estimateExtractionInput(payload, p).inputTokens }, profileSnapshot: { schemaVersion: 2, profile: p } };
    assert.deepEqual(validateProfileSnapshot(record.profileSnapshot, record), record.profileSnapshot);
    assert.deepEqual(auditExtractionInput(record, input).payload, payload);
  }
});
const profileOptions = p => ({ simulationInstructions: p.instructions,
  config: { ...v4Config, version: `fictional-mapping-${p.instructionsVersion}`, promptVersion: p.instructionsVersion,
    promptHash: bytesHash(p.instructions), maxInputTokens: 131072 } });
test('fixed mapping: fake v4 candidate failure settles usage, releases reservation and saves no response content', async t => {
  const marker = 'FICTIONAL_RESPONSE_ONLY_MAPPING_FAILURE';
  const wire = candidateWire(mappings[0]); wire.candidates[0].category = 'other'; wire.candidates[0].text = marker;
  const c = await v4Fixture(t, { ...profileOptions(extractionProfile), respond: () => ({ extraction: wire, usage: { inputTokens: 100, outputTokens: 200 } }) });
  const r = await c.run(c.service);
  assert.deepEqual(r.error, { code: 'validation_candidate_target_category', phase: 'validation' });
  assert.equal(r.state, 'failed_after_request'); assert.equal(r.budget.state, 'settled');
  assert.equal(r.budget.reservedMilliYen, 0); assert.equal(r.budget.bookedMilliYen, 1);
  assert.deepEqual(r.budget.usage, { inputTokens: 100, outputTokens: 200 });
  assert.equal(r.responseHash, digest({ extraction: wire, usage: r.budget.usage }));
  for (const k of ['resultBinding', 'validatedArtifact', 'plannedImport', 'savedImport', 'unknownReason']) assert.equal(r[k], null);
  assert.equal(r.recoveryRequired, false); assert.deepEqual(await c.imports.list(), []);
  const snapshot = await capture(c.root);
  for (const b of Object.values(snapshot.files)) assert.ok(!b.toString().includes(marker));
  const preview = await c.reopen().preview(r.id);
  assert.ok(!extractionPages(String).detail(preview).includes(marker));
  await assert.rejects(c.reopen().execute(r.id, r.revision)); assert.equal(c.calls.length, 1);
  assert.equal((await createMaintenanceService(c.root).integrity()).status, 'normal');
});
test('fixed mapping: old-to-new instructions upgrade preserves source, lineage, approvals, budget and backup', async t => {
  const old = historicalExtractionProfiles.find(p => p.instructionsVersion === 'regulation-quote-local-resolution-v1');
  const bad = candidateWire(mappings[0]); bad.candidates[0].category = 'other';
  const c = await v4Fixture(t, { ...profileOptions(old), respond: () => ({ extraction: bad, usage: { inputTokens: 100, outputTokens: 200 } }) });
  const source = await c.run(c.service), sourceHistory = (await c.store.read()).executions.find(e => e.revisions[0].id === source.id);
  const activation = await fs.readFile(path.join(c.root, 'ai-budget/activation.json'));
  const offer = await fs.readFile(path.join(c.root, 'offers', c.offer.id + '.json'));
  const s = c.reopen({ ...profileOptions(extractionProfile), provider: { kind: 'fake', async extract() { return { extraction: wireFixture(), usage: { inputTokens: 100, outputTokens: 200 } }; } } });
  const preview = await s.upgradePreview(source.id);
  const child = await s.prepareUpgrade(source.id, preview.token, { confirm: true });
  assert.equal(child.schemaVersion, 4); assert.equal(child.state, 'prepared'); assert.equal(child.budget.reservedMilliYen, 0);
  assert.equal(child.upgrade.sourceConfigurationHash, source.configuration.hash);
  assert.equal(child.upgrade.destinationConfigurationHash, child.configuration.hash);
  assert.notEqual(child.configuration.hash, source.configuration.hash); assert.deepEqual(child.processingContract, processingContract());
  const approved = await s.approve(child.id, 1, { confirm: true, requestHash: child.requestHash });
  const result = await s.execute(child.id, approved.revision); assert.equal(result.state, 'succeeded');
  assert.deepEqual((await c.store.read()).executions.find(e => e.revisions[0].id === source.id), sourceHistory);
  assert.deepEqual(await fs.readFile(path.join(c.root, 'ai-budget/activation.json')), activation);
  assert.deepEqual(await fs.readFile(path.join(c.root, 'offers', c.offer.id + '.json')), offer);
  const totals = await c.coordinator.transaction(common => common.totals);
  assert.equal(totals.simulation.bookedMilliYen, 2); assert.equal(totals.simulation.reservedMilliYen, 0);
  assert.ok((await c.imports.get(result.savedImport.id)).candidates.every(x => x.review.decision === 'pending' && x.review.verification === 'unverified'));
  const m = createMaintenanceService(c.root); assert.equal((await m.integrity()).status, 'normal');
  const b = await m.create(), before = snapshotHash(await capture(c.root));
  assert.equal(b.manifest.schemaVersion, 4); assert.equal((await m.dryRun(b.manifest.id)).status, 'normal');
  assert.equal(snapshotHash(await capture(c.root)), before);
});
test('fixed mapping: no external connection attempts', () => assert.deepEqual(blockedConnections, []));
