import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { validateExtraction } from '../lib/offer-import/validation.js';
import { evidenceWireSchema, validateWireExtraction, resolveEvidence, inverseEvidenceResolution, processingContract } from '../lib/offer-import/evidence-resolution-v2.js';
import { processingContract as legacyProcessing } from '../lib/offer-import/evidence-resolution.js';
import { assertProcessingContractAny, executionVersionForProcessing } from '../lib/offer-import/processing-registry.js';
import { extractionProfile, profileConfiguration } from '../lib/ai/extraction-profile.js';
import { historicalExtractionProfiles, validateProfileSnapshot } from '../lib/ai/extraction-profile-registry.js';
import { digest } from '../lib/ai/safety-storage.js';
import { regulationFixture } from './fixtures/regulation-import.js';
import { v4Fixture, wireFixture } from './fixtures/extraction-v4.js';
import { v5Fixture, wireV3Fixture, v5Config, v5Instructions } from './fixtures/extraction-v5.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { capture, snapshotHash } from '../lib/maintenance/snapshot.js';
import { blockedConnections } from './helpers/network-guard.js';

test('wire v3 exhaustively matches existing validator for 4680 candidate combinations without correction', () => {
  const internal = regulationFixture(), schema = evidenceWireSchema;
  const targets = schema.$defs.payload.anyOf.map(r => schema.$defs[r.$ref.split('/').at(-1)].properties.target.enum[0]);
  const categories = ['price','track_record','effect','feature','audience','selling_point','eligibility','approval','rejection','prohibition','reward','other'];
  let count = 0, accepted = 0;
  for (const target of targets) for (const category of categories)
    for (const purpose of ['fact','restriction','marketing_goal','conversion_condition','unmapped'])
      for (const usage of ['publishable','constraint_only','internal_only']) for (const conversionKey of [null,'fictional-group']) {
        const candidate = { ...structuredClone(internal.extraction.candidates[0]), target, category, purpose, usage, conversionKey };
        let valid = true; try { validateExtraction({ schemaVersion: 1, candidates: [candidate] }, internal.documents); } catch { valid = false; }
        const wire = wireV3Fixture({ schemaVersion: 1, candidates: [candidate] }), before = structuredClone(wire);
        let wireValid = true; try { validateWireExtraction(wire); } catch (e) { wireValid = false; assert.equal(e.code, 'validation_wire_schema'); }
        assert.equal(wireValid, valid, `${target}/${category}/${purpose}/${usage}/${conversionKey === null ? 'null' : 'group'}`);
        assert.deepEqual(wire, before); count++; if (valid) accepted++;
      }
  assert.equal(count, 4680); assert.ok(accepted > 0);
});
test('wire v3 branches are thirteen disjoint complete targets with no fallback and strict keywords only', () => {
  const schema = extractionProfile.outputSchema;
  assert.equal(schema.type, 'object'); assert.ok(!schema.anyOf);
  const branches = schema.$defs.payload.anyOf;
  assert.equal(branches.length, 13);
  const targets = branches.map(r => {
    const b = schema.$defs[r.$ref.split('/').at(-1)];
    assert.deepEqual(b.required, ['target','conversionKey','category','text','usage','purpose','evidence']);
    assert.equal(b.additionalProperties, false); assert.equal(b.properties.target.enum.length, 1);
    return b.properties.target.enum[0];
  });
  assert.equal(new Set(targets).size, 13);
  assert.deepEqual(new Set(targets), new Set(['name','conversion_name','disclosure_text','facts','targetAudience','sellingPoints','prohibitedExpressions','eligibility','approvalConditions','rejectionConditions','ctaLabel','reward_evidence','unmapped']));
  const allowed = new Set(['type','enum','$ref','$defs','anyOf','properties','required','additionalProperties','minLength','maxLength','pattern','minItems','maxItems','items','description']);
  function check(s) {
    for (const key of Object.keys(s)) assert.ok(allowed.has(key), key);
    for (const key of ['properties','$defs']) for (const child of Object.values(s[key] || {})) check(child);
    for (const child of s.anyOf || []) check(child);
    if (s.items) check(s.items);
  }
  check(schema);
});
test('wire v3 exact quoted evidence roundtrip preserves all candidate values and ordering', () => {
  const { documents, extraction } = regulationFixture(), wire = wireV3Fixture(extraction);
  const result = resolveEvidence(wire, documents);
  assert.deepEqual(result, extraction); assert.deepEqual(inverseEvidenceResolution(result), wire);
});
for (const field of ['target','category','purpose','usage','conversionKey']) {
  test(`wire v3 rejects invalid ${field} before any quote lookup without correction`, () => {
    const wire = wireV3Fixture(); wire.candidates = [wire.candidates[0]];
    wire.candidates[0].evidence[0].quote = 'FICTIONAL_NO_EXACT_MATCH';
    wire.candidates[0][field] = field === 'conversionKey' ? 'fictional-group' : field === 'target' ? 'unknown' : field === 'category' ? 'reward' : field === 'purpose' ? 'restriction' : 'unknown';
    const before = structuredClone(wire);
    assert.throws(() => resolveEvidence(wire, regulationFixture().documents), { code: 'validation_wire_schema' });
    assert.deepEqual(wire, before);
  });
}
test('wire v3 dispatch accepts only exact version/hash pairs and keeps v4 on legacy processing', () => {
  assert.equal(executionVersionForProcessing(legacyProcessing()), 4); assert.equal(executionVersionForProcessing(processingContract()), 5);
  for (const field of Object.keys(processingContract())) {
    const bad = structuredClone(processingContract()); bad[field] = typeof bad[field] === 'number' ? 99 : 'unknown';
    assert.throws(() => assertProcessingContractAny(bad), { code: 'processing_contract_invalid' });
  }
});
test('snapshot v2/v3 static public profiles match exact runtime registry ranges', async () => {
  const v2 = JSON.parse(await fs.readFile(new URL('../schemas/extraction-profile-snapshot-v2.schema.json', import.meta.url)));
  const v3 = JSON.parse(await fs.readFile(new URL('../schemas/extraction-profile-snapshot-v3.schema.json', import.meta.url)));
  for (const [schema, wireVersion, executionVersion, snapshotVersion] of [[v2,2,4,2],[v3,3,5,3]]) {
    const registered = historicalExtractionProfiles.filter(p => p.processingContract?.wireSchemaVersion === wireVersion);
    const constants = schema.properties.profile.anyOf.filter(b => b.const).map(b => b.const);
    assert.equal(constants.length, registered.length);
    for (const p of registered) {
      assert.ok(constants.some(c => isDeepStrictEqual(c,p)));
      const config = profileConfiguration(p), record = { schemaVersion: executionVersion, provider: 'openai', model: p.model, configuration: { ...config, hash: digest(config) } };
      const snapshot = { schemaVersion: snapshotVersion, profile: p };
      assert.deepEqual(validateProfileSnapshot(snapshot, record), snapshot);
      assert.throws(() => validateProfileSnapshot(snapshot, { ...record, schemaVersion: executionVersion === 4 ? 5 : 4 }), { code: 'historical_profile_invalid' });
      const tampered = structuredClone(snapshot); tampered.profile.instructions += 'unknown'; assert.throws(() => validateProfileSnapshot(tampered, record));
    }
  }
});
test('v4 to v5 upgrade preserves legacy records, two approvals, mixed backups and dry-run audit', async t => {
  const bad = wireFixture(); bad.candidates[0].category = 'reward';
  const c = await v4Fixture(t, { respond: () => ({ extraction: bad, usage: { inputTokens: 100, outputTokens: 200 } }) });
  const source = await c.run(c.service), oldLedger = await c.store.read();
  assert.equal(source.schemaVersion, 4); assert.equal(source.error.code, 'validation_candidate_reward');
  const maintenance = createMaintenanceService(c.root), oldBackup = await maintenance.create();
  assert.equal(oldBackup.manifest.schemaVersion, 4);
  let calls = 0;
  const s = c.reopen({ processing: processingContract(), config: v5Config, simulationInstructions: v5Instructions,
    provider: { kind: 'fake', async extract() { calls++; return { extraction: wireV3Fixture(), usage: { inputTokens: 100, outputTokens: 200 } }; } } });
  const preview = await s.upgradePreview(source.id); assert.equal(calls, 0);
  const child = await s.prepareUpgrade(source.id, preview.token, { confirm: true });
  assert.equal(child.schemaVersion, 5); assert.equal(child.profileSnapshot.schemaVersion, 3);
  assert.equal(child.budget.reservedMilliYen, 0); assert.equal(calls, 0);
  assert.equal(child.upgrade.sourceHash, digest(source)); assert.notEqual(child.configuration.hash, source.configuration.hash);
  const approved = await s.approve(child.id, 1, { confirm: true, requestHash: child.requestHash });
  assert.ok(approved.budget.reservedMilliYen > 0);
  const result = await s.execute(child.id, approved.revision); assert.equal(result.state, 'succeeded'); assert.equal(calls, 1);
  const mixed = await c.store.read(); assert.equal(mixed.schemaVersion, 5);
  assert.deepEqual(mixed.executions[0], oldLedger.executions[0]);
  assert.equal((await maintenance.integrity()).status, 'normal');
  const oldDry = await maintenance.dryRun(oldBackup.manifest.id); assert.equal(oldDry.backupValid, true); assert.equal(oldDry.report.status, 'normal');
  const latest = await maintenance.create(); assert.equal(latest.manifest.schemaVersion, 5);
  const before = snapshotHash(await capture(c.root)); assert.equal((await maintenance.dryRun(latest.manifest.id)).status, 'normal');
  assert.equal(snapshotHash(await capture(c.root)), before);
  await assert.rejects(s.execute(result.id, result.revision)); assert.equal(calls, 1);
});
test('wire v3 fixture makes no external connection attempts', () => assert.deepEqual(blockedConnections, []));
test('wire v3 invalid candidate stops with fixed diagnostic, settled usage and no response persistence', async t => {
  const wire = wireV3Fixture(); wire.candidates[0].category = 'reward';
  const marker = 'FICTIONAL_V5_PRIVATE_RESPONSE_CANDIDATE';
  wire.candidates[0].text = marker; wire.candidates[0].evidence[0].quote = 'FICTIONAL_V5_PRIVATE_RESPONSE_QUOTE';
  const c = await v5Fixture(t, { respond: () => ({ extraction: wire, usage: { inputTokens: 100, outputTokens: 200 } }) });
  const r = await c.run(c.service);
  assert.deepEqual(r.error, { code: 'validation_wire_schema', phase: 'validation' });
  assert.equal(r.state, 'failed_after_request'); assert.equal(r.budget.state, 'settled');
  assert.equal(r.budget.reservedMilliYen, 0); assert.equal(r.budget.bookedMilliYen, 1);
  for (const k of ['resultBinding','validatedArtifact','plannedImport','savedImport','unknownReason']) assert.equal(r[k], null);
  const snapshot = await capture(c.root);
  for (const b of Object.values(snapshot.files)) {
    assert.ok(!b.toString().includes(marker)); assert.ok(!b.toString().includes('FICTIONAL_V5_PRIVATE_RESPONSE_QUOTE'));
  }
  assert.deepEqual(await c.imports.list(), []); assert.equal(c.calls.length, 1);
  await assert.rejects(c.reopen().execute(r.id, r.revision)); assert.equal(c.calls.length, 1);
  assert.equal((await createMaintenanceService(c.root).integrity()).status, 'normal');
});
