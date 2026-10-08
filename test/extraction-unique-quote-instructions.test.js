import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { extractionProfile, profileConfiguration } from '../lib/ai/extraction-profile.js';
import { historicalExtractionProfiles, auditExtractionInput, validateProfileSnapshot } from '../lib/ai/extraction-profile-registry.js';
import { buildExtractionPayload, estimateExtractionInput } from '../lib/ai/extraction-payload.js';
import { bytesHash, digest } from '../lib/ai/safety-storage.js';
import { hashDocumentText } from '../lib/offer-import/validation.js';
import { resolveEvidence, inverseEvidenceResolution } from '../lib/offer-import/evidence-resolution-v2.js';
import { v5Fixture, v5Config, wireV3Fixture } from './fixtures/extraction-v5.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { capture, snapshotHash } from '../lib/maintenance/snapshot.js';
import { extractionPages } from '../lib/offer-import/extraction-pages.js';
import { blockedConnections } from './helpers/network-guard.js';

const prior = historicalExtractionProfiles.find(p => p.instructionsVersion === 'regulation-target-variants-v1');
function fixture(text, quote, split = 0) {
  const documents = [{ id: 'doc', format: 'text', label: '架空資料', kind: 'asp_material', versionLabel: 'fixture', text,
    textHash: hashDocumentText(text), blocks: split ? [{ id: 'before', start: 0, end: split }, { id: 'block', start: split, end: text.length }] : [{ id: 'block', start: 0, end: text.length }] }];
  const wire = { schemaVersion: 3, candidates: [{ target: 'facts', category: 'feature', conversionKey: null, purpose: 'fact', usage: 'internal_only',
    text: 'FICTIONAL_RESPONSE_ONLY_UNIQUE_SELECTION', evidence: [{ documentId: 'doc', blockId: 'block', quote }] }] };
  return { documents, wire };
}
test('unique quote instructions: every selection and safety requirement is actually sent', () => {
  const text = buildExtractionPayload({ documents: [], targetOffer: null }, extractionProfile).instructions;
  for (const clause of ['短い単語、短い定型句、繰り返し出現しやすい表現だけをquoteに選ばない',
    'evidence.quoteは指定documentの指定block内の連続した原文を完全転記', '必要なら前後の文脈を含め、quoteを十分な長さ',
    'trim / normalize / 要約 / 言い換え / 文字変更は禁止', '指定block全体の中で、重なり一致を含めてexactly one occurrence',
    '出力前に各evidenceについて、指定block全体でquoteが一度だけ出現することを自己検査',
    '0回または2回以上なら、そのquoteを使用せず、別の一意な連続原文',
    '最大quote長5000 UTF-16コード単位、block境界、documentId/blockId参照',
    '一意なquoteを安全に選べない場合に、候補を捏造・補完・正規化してはいけません']) assert.ok(text.includes(clause), clause);
});
test('unique quote profile: only instructions/version/source identity change; old and new audit independently', async () => {
  assert.equal(digest(prior), '25cd89f262b5c3983a6938bd0a41b93f7b9cddf9857f8aadde0b9ef9825b20dc');
  const rest = p => { const { instructions, instructionsVersion, profileCodeHash, ...r } = p; return r; };
  assert.deepEqual(rest(extractionProfile), rest(prior));
  assert.notEqual(digest(profileConfiguration(extractionProfile)), digest(profileConfiguration(prior)));
  const schema = JSON.parse(await fs.readFile(new URL('../schemas/extraction-profile-snapshot-v3.schema.json', import.meta.url)));
  const constants = schema.properties.profile.anyOf.filter(b => b.const).map(b => b.const);
  const registered = historicalExtractionProfiles.filter(p => p.processingContract?.wireSchemaVersion === 3);
  assert.deepEqual(new Set(constants.map(digest)), new Set(registered.map(digest)));
  const input = { targetOffer: { id: '00000000-0000-4000-8000-000000000001', revision: 1 }, documents: [] };
  for (const p of [prior, extractionProfile]) {
    const c = profileConfiguration(p), payload = buildExtractionPayload(input, p);
    const r = { schemaVersion: 5, provider: 'openai', model: p.model, configuration: { ...c, hash: digest(c) },
      profileSnapshot: { schemaVersion: 3, profile: p }, estimate: { inputTokens: estimateExtractionInput(payload, p).inputTokens } };
    assert.deepEqual(validateProfileSnapshot(r.profileSnapshot, r), r.profileSnapshot);
    assert.deepEqual(auditExtractionInput(r, input).payload, payload);
  }
});
for (const [label, text, quote, split] of [
  ['context disambiguates', '反復。前文。反復。後文。', '前文。反復。後文。', 0],
  ['UTF-16 CRLF combining and quotes', 'X😀\r\ne\u0301\t  “原文”Y', '😀\r\ne\u0301\t  “原文”', 0],
  ['nonzero block', 'abc一意な架空原文', '一意な架空原文', 3],
]) test(`unique quote instructions retain exact resolution: ${label}`, () => {
  const f = fixture(text, quote, split), before = structuredClone(f.wire);
  const resolved = resolveEvidence(f.wire, f.documents);
  assert.equal(resolved.candidates[0].evidence[0].start, text.indexOf(quote, split));
  assert.deepEqual(inverseEvidenceResolution(resolved), f.wire); assert.deepEqual(f.wire, before);
});
for (const [label, text, quote, split, code] of [
  ['multiple', '反復。前文。反復。後文。', '反復。', 0, 'validation_quote_ambiguous'],
  ['overlap', 'aaaa', 'aa', 0, 'validation_quote_ambiguous'],
  ['zero', '架空の原文', 'FICTIONAL_UNSAVED_QUOTE', 0, 'validation_quote_not_found'],
  ['no normalization', 'e\u0301', 'é', 0, 'validation_quote_not_found'],
  ['no trimming', 'ABC', ' ABC ', 0, 'validation_quote_not_found'],
  ['no cross-block extension', 'ABCXYZ', 'CXY', 3, 'validation_quote_not_found'],
]) test(`unique quote instructions retain refusal and no correction: ${label}`, () => {
  const f = fixture(text, quote, split), before = structuredClone(f.wire);
  assert.throws(() => resolveEvidence(f.wire, f.documents), { code }); assert.deepEqual(f.wire, before);
});
const optionsFor = p => ({ simulationInstructions: p.instructions, config: { ...v5Config, version: `fictional-${p.instructionsVersion}`,
  promptVersion: p.instructionsVersion, promptHash: bytesHash(p.instructions), maxInputTokens: 131072 } });
for (const [label, text, quote, code] of [
  ['multiple', '反復。前文。反復。後文。', '反復。', 'validation_quote_ambiguous'],
  ['overlap', 'aaaa', 'aa', 'validation_quote_ambiguous'],
  ['zero', '架空の原文', 'FICTIONAL_UNSAVED_QUOTE', 'validation_quote_not_found'],
]) test(`new profile fake failure remains settled, nonpersistent and terminal: ${label}`, async t => {
  const f = fixture(text, quote), c = await v5Fixture(t, { ...optionsFor(extractionProfile),
    respond: () => ({ extraction: f.wire, usage: { inputTokens: 100, outputTokens: 200 } }) });
  c.value.documents = f.documents;
  const r = await c.run(c.service);
  assert.deepEqual(r.error, { code, phase: 'validation' }); assert.equal(r.state, 'failed_after_request');
  assert.equal(r.budget.state, 'settled'); assert.equal(r.budget.reservedMilliYen, 0); assert.equal(r.budget.bookedMilliYen, 1);
  assert.equal(r.responseHash, digest({ extraction: f.wire, usage: r.budget.usage }));
  for (const k of ['resultBinding','validatedArtifact','plannedImport','savedImport','unknownReason']) assert.equal(r[k], null);
  assert.equal(r.recoveryRequired, false);
  for (const b of Object.values((await capture(c.root)).files)) {
    assert.ok(!b.toString().includes('FICTIONAL_RESPONSE_ONLY_UNIQUE_SELECTION')); assert.ok(!b.toString().includes('FICTIONAL_UNSAVED_QUOTE'));
  }
  assert.ok(!extractionPages(String).detail(await c.reopen().preview(r.id)).includes('FICTIONAL_RESPONSE_ONLY_UNIQUE_SELECTION'));
  await assert.rejects(c.reopen().execute(r.id, r.revision)); assert.equal(c.calls.length, 1);
  assert.equal((await createMaintenanceService(c.root).integrity()).status, 'normal');
});
test('unique quote old/new profile upgrade preserves source, approvals, usage, budget, review and backups', async t => {
  const bad = fixture('反復。反復。', '反復。');
  const c = await v5Fixture(t, { ...optionsFor(prior), respond: () => ({ extraction: bad.wire, usage: { inputTokens: 100, outputTokens: 200 } }) });
  c.value.documents = bad.documents;
  const source = await c.run(c.service), oldLedger = await c.store.read();
  const offer = await fs.readFile(path.join(c.root, 'offers', c.offer.id + '.json'));
  const activation = await fs.readFile(path.join(c.root, 'ai-budget/activation.json'));
  const m = createMaintenanceService(c.root), oldBackup = await m.create(); let calls = 0;
  const good = fixture('反復。反復。', '反復。反復。');
  const s = c.reopen({ ...optionsFor(extractionProfile), provider: { kind: 'fake', async extract() { calls++; return { extraction: good.wire, usage: { inputTokens: 100, outputTokens: 200 } }; } } });
  const preview = await s.upgradePreview(source.id), child = await s.prepareUpgrade(source.id, preview.token, { confirm: true });
  assert.equal(calls, 0); assert.equal(child.budget.reservedMilliYen, 0); assert.equal(child.schemaVersion, 5);
  assert.equal(child.upgrade.sourceHash, digest(source)); assert.notEqual(child.configuration.hash, source.configuration.hash);
  assert.deepEqual(child.processingContract, source.processingContract);
  const approved = await s.approve(child.id, 1, { confirm: true, requestHash: child.requestHash });
  const result = await s.execute(child.id, approved.revision); assert.equal(result.state, 'succeeded'); assert.equal(calls, 1);
  assert.deepEqual((await c.store.read()).executions[0], oldLedger.executions[0]);
  assert.deepEqual(await fs.readFile(path.join(c.root, 'offers', c.offer.id + '.json')), offer);
  assert.deepEqual(await fs.readFile(path.join(c.root, 'ai-budget/activation.json')), activation);
  const totals = await c.coordinator.transaction(common => common.totals);
  assert.equal(totals.simulation.bookedMilliYen, 2); assert.equal(totals.simulation.reservedMilliYen, 0);
  assert.ok((await c.imports.get(result.savedImport.id)).candidates.every(c => c.review.verification === 'unverified' && c.review.decision === 'pending'));
  assert.equal((await m.integrity()).status, 'normal'); const latest = await m.create();
  assert.equal(latest.manifest.schemaVersion, 5); const before = snapshotHash(await capture(c.root));
  assert.equal((await m.dryRun(latest.manifest.id)).status, 'normal'); assert.equal((await m.dryRun(oldBackup.manifest.id)).backupValid, true);
  assert.equal(snapshotHash(await capture(c.root)), before);
});
test('unique quote instructions fixtures make no external connection attempts', () => assert.deepEqual(blockedConnections, []));
