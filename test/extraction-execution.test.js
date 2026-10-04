import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createExtractionService, fakeExtractionConfig, initialImportHash } from '../lib/offer-import/extraction-service.js';
import { createExecutionStore } from '../lib/offer-import/execution-store.js';
import { createArtifactStore } from '../lib/offer-import/extraction-artifacts.js';
import { validateExecutionLedger, transitions, requestDigest } from '../lib/offer-import/execution-contract.js';
import { createBudgetCoordinator, milliYen, costMilliYen, aggregateBudget } from '../lib/ai/budget-coordinator.js';
import { createGenerationStore } from '../lib/ai/generation-store.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { hash, snapshotHash, capture } from '../lib/maintenance/snapshot.js';
import { digest } from '../lib/ai/safety-storage.js';
import { hashDocumentText } from '../lib/offer-import/validation.js';
import { blockedConnections } from './helpers/network-guard.js';
import { executionFixture } from './fixtures/extraction-execution.js';
import { maintenanceFixture, storeBytes } from './fixtures/maintenance.js';
import { fixtureBudgetPolicy } from './fixtures/ai-budget.js';

const openService = (c, overrides = {}) => createExtractionService({ ...c.options, ...overrides });
const ledgerFile = c => path.join(c.root, 'extraction-executions/ledger.json');
async function edit(file, change) { const v = JSON.parse(await fs.readFile(file, 'utf8')); change(v); await fs.writeFile(file, JSON.stringify(v)); }
async function allBytes(root) { const s = await capture(root); return Object.fromEntries(Object.entries(s.files).map(([k, v]) => [k, v.toString()])); }
const terminalGeneration = (now, extra = {}) => ({ id: randomUUID(), planId: randomUUID(), draftId: randomUUID(), state: 'succeeded', month: now().toISOString().slice(0, 7),
  createdAt: now().toISOString(), updatedAt: now().toISOString(), provider: 'fake', model: 'fake-paper-v1', simulation: true, attempted: true,
  usage: { inputTokens: 100, outputTokens: 100 }, estimatedYen: 3, reservedYen: 0, ...extra });

test('6-0A: explicit activation is required for both paths; no fallback or external attempt', async t => {
  const c = await executionFixture(t, { activate: false });
  await assert.rejects(c.service.prepare(c.value), { code: 'activation_required' });
  await assert.rejects(c.generation.execute(c.plan, c.generation.confirmation(c.plan)), { code: 'activation_required' });
  assert.equal(c.calls.length, 0); assert.equal((await createGenerationStore(c.root).read()).runs.length, 0);
});
test('6-0A: successful extraction saves pending/unverified import and preserves offer/history', async t => {
  const c = await executionFixture(t); const before = await storeBytes(c.root);
  const r = await c.run(); assert.equal(r.state, 'succeeded'); assert.equal(c.calls.length, 1);
  const first = (await c.imports.history(r.savedImport.id))[0];
  assert.equal(r.savedImport.hash, digest(first)); assert.equal(r.plannedImport.contentHash, initialImportHash(first));
  for (const candidate of first.candidates) { assert.equal(candidate.review.decision, 'pending'); assert.equal(candidate.review.verification, 'unverified'); }
  assert.equal((await c.offers.get(c.offer.id)).status, 'draft'); assert.equal((await c.offers.history(c.offer.id)).length, 1);
  assert.equal((await storeBytes(c.root))[`offers/${c.offer.id}.json`], before[`offers/${c.offer.id}.json`]);
  const history = (await c.store.read()).executions[0].revisions;
  assert.deepEqual(history.map(r => r.state), ['prepared', 'approved', 'sending', 'response_received', 'validated', 'import_saving', 'succeeded']);
  assert.ok(!JSON.stringify(history).includes(c.value.documents[0].text));
  assert.equal(r.budget.reservedMilliYen, 0); assert.equal(r.budget.state, 'settled'); assert.ok(r.budget.bookedMilliYen > 0);
});
test('6-0A: prepare never calls provider or creates an import, immutable input exists once', async t => {
  const c = await executionFixture(t); const r = await c.service.prepare(c.value);
  assert.equal(r.state, 'prepared'); assert.equal(r.attempt, 'not_started'); assert.equal(c.calls.length, 0); assert.deepEqual(await c.imports.list(), []);
  const artifacts = await fs.readdir(path.join(c.root, 'extraction-artifacts')); assert.equal(artifacts.length, 1);
  const a = await createArtifactStore(c.root).read(r.inputArtifact, r.id, 'input'); assert.deepEqual(a.content, c.value);
});
test('6-0A: approval binds hash and saved revision; false approval and altered hash rejected', async t => {
  const c = await executionFixture(t); const r = await c.service.prepare(c.value);
  await assert.rejects(c.service.approve(r.id, 1, { confirm: false, requestHash: r.requestHash }), { status: 400 });
  await assert.rejects(c.service.approve(r.id, 1, { confirm: true, requestHash: '0'.repeat(64) }), { status: 409 });
  const approved = await c.service.approve(r.id, 1, { confirm: true, requestHash: r.requestHash });
  assert.equal(approved.approval.revision, 1); assert.equal(approved.budget.state, 'reserved'); assert.equal(c.calls.length, 0);
});
test('6-0A: same execution double click invokes provider at most once', async t => {
  const c = await executionFixture(t); const r = await c.ready();
  const results = await Promise.allSettled([c.service.execute(r.id, r.revision), c.service.execute(r.id, r.revision)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(c.calls.length, 1);
  await assert.rejects(c.service.execute(r.id, (await c.store.get(r.id)).revision), { status: 409 }); assert.equal(c.calls.length, 1);
});
test('6-0A: fingerprint blocks same materials even when regenerated document/block IDs change', async t => {
  const c = await executionFixture(t); await c.service.prepare(c.value);
  const changed = structuredClone(c.value); changed.documents[0].id = 'renamed-document'; changed.documents[0].blocks.forEach((b, i) => b.id = `renamed-${i}`);
  await assert.rejects(c.service.prepare(changed), { code: 'duplicate_request' });
  await assert.rejects(c.service.prepare(c.value), { code: 'duplicate_request' });
  assert.equal((await c.store.read()).executions.length, 1);
});
for (const phase of ['before_request', 'after_sending', 'after_response', 'before_validated_artifact', 'before_import_intent', 'before_import_save', 'before_result']) {
  test(`6-0A: injected ${phase} failure stops without automatic provider retry`, async t => {
    const c = await executionFixture(t); const s = openService(c, { fault: async p => { if (p === phase) throw new Error('FICTIONAL_PRIVATE_ERROR'); } });
    const r = await c.ready(s); await s.execute(r.id, r.revision).catch(() => {});
    const last = await c.store.get(r.id);
    const expected = { before_request: 'failed_before_request', after_sending: 'sending', after_response: 'sending', before_validated_artifact: 'recovery_required', before_import_intent: 'recovery_required', before_import_save: 'import_save_failed', before_result: 'recovery_required' }[phase];
    assert.equal(last.state, expected); assert.equal(c.calls.length, ['before_request', 'after_sending'].includes(phase) ? 0 : 1);
    await assert.rejects(s.execute(r.id, last.revision), { status: 409 });
    assert.ok(!JSON.stringify(await c.store.read()).includes('FICTIONAL_PRIVATE_ERROR'));
    if (last.state === 'failed_before_request') assert.equal(last.budget.reservedMilliYen, 0);
    else if (last.state === 'sending') assert.equal(last.budget.reservedMilliYen, last.estimate.maximumReservedMilliYen);
  });
}
for (const kind of ['connection', 'timeout', 'invalid_usage']) test(`6-0A: ${kind} becomes unknown; both AI paths stop, reservation survives restart`, async t => {
  const c = await executionFixture(t); let calls = 0;
  const provider = { kind: 'fake', async extract() { calls++; if (kind === 'timeout') return new Promise(() => {}); if (kind === 'connection') throw new Error('PRIVATE_FAKE_FAILURE'); return { usage: null, extraction: {} }; } };
  const s = openService(c, { provider, config: { ...fakeExtractionConfig, timeoutMs: 10 } });
  const r = await c.run(s); assert.equal(r.state, 'unknown'); assert.equal(calls, 1); assert.equal(r.budget.state, 'unknown'); assert.ok(r.budget.reservedMilliYen > 0);
  const restarted = createExecutionStore(c.root); assert.equal((await restarted.get(r.id)).state, 'unknown');
  await assert.rejects(c.generation.execute(c.plan, c.generation.confirmation(c.plan)), { code: 'ai_in_progress' });
  const changed = structuredClone(c.value); changed.documents[0].label = '別版の架空資料'; const next = await c.service.prepare(changed);
  await assert.rejects(c.service.approve(next.id, 1, { confirm: true, requestHash: next.requestHash }), { code: 'ai_in_progress' });
  await assert.rejects(s.recover(r.id, r.revision, { confirm: true, operation: 'save_only' }), { status: 409 });
});
test('6-0A: restart in sending is human-review-required, explicit interruption marks unknown only', async t => {
  const c = await executionFixture(t); const s = openService(c, { fault: async phase => { if (phase === 'after_sending') throw new Error('process stop'); } });
  const r = await c.ready(s); await assert.rejects(s.execute(r.id, r.revision));
  const restart = openService(c, { store: createExecutionStore(c.root, { now: c.now }) }); const status = await restart.status(r.id);
  assert.equal(status.humanReviewRequired, true); assert.equal(status.externalRetryAllowed, false);
  const unknown = await restart.recover(r.id, status.record.revision, { confirm: true, operation: 'mark_interrupted' });
  assert.equal(unknown.state, 'unknown'); assert.equal(c.calls.length, 0);
});
for (const defect of ['malformed', 'quote', 'source_checked', 'secret']) test(`6-0A: ${defect} response fails validation, books known usage, creates no import`, async t => {
  const c = await executionFixture(t); const provider = { kind: 'fake', async extract(args) {
    const response = await c.provider.extract(args);
    if (defect === 'malformed') response.extraction = { bad: true };
    if (defect === 'quote') response.extraction.candidates[0].evidence[0].quote = '架空の一致しない引用';
    if (defect === 'source_checked') response.extraction.candidates[0].verification = 'source_checked';
    if (defect === 'secret') response.extraction.candidates[0].text = 'password=fictional_rejected_value';
    return response;
  } };
  const r = await c.run(openService(c, { provider })); assert.equal(r.state, 'failed_after_request');
  assert.ok(r.budget.bookedMilliYen > 0); assert.equal(r.budget.reservedMilliYen, 0); assert.deepEqual(await c.imports.list(), []);
  assert.ok(!JSON.stringify(await c.store.read()).includes('fictional_rejected_value'));
});
test('6-0A: local save retry retains planned ID and does not call provider again', async t => {
  const c = await executionFixture(t); const s = openService(c, { importStore: { ...c.imports, async create() { throw new Error('disk'); } } });
  const r = await c.run(s); assert.equal(r.state, 'import_save_failed'); const planned = r.plannedImport;
  await assert.rejects(c.service.recover(r.id, r.revision, { confirm: false, operation: 'save_only' }), { status: 400 });
  const saved = await c.service.recover(r.id, r.revision, { confirm: true, operation: 'save_only' });
  assert.equal(saved.state, 'succeeded'); assert.deepEqual(saved.plannedImport, planned); assert.equal(c.calls.length, 1);
});
test('6-0A: result failure requires explicit result-only finalization matching initial revision even after review', async t => {
  const c = await executionFixture(t); const s = openService(c, { fault: async p => { if (p === 'before_result') throw new Error('disk'); } });
  const r = await c.run(s); assert.equal(r.state, 'recovery_required'); const before = await c.imports.get(r.plannedImport.id);
  await c.imports.review(before.id, 'candidate-2', 1, { decision: 'accepted', edited: null, sourceChecked: false, reason: '' });
  await assert.rejects(c.service.recover(r.id, r.revision, { confirm: true, operation: 'save_only' }), { code: 'import_exists' });
  const saved = await c.service.recover(r.id, r.revision, { confirm: true, operation: 'finalize_result' });
  assert.equal(saved.state, 'succeeded'); assert.equal(saved.savedImport.hash, digest(before)); assert.equal((await c.imports.history(before.id)).length, 2); assert.equal(c.calls.length, 1);
});
test('6-0A: import save acknowledges then throws; no second save or provider call until result-only human check', async t => {
  const c = await executionFixture(t); const s = openService(c, { importStore: { ...c.imports, async create(...args) { await c.imports.create(...args); throw new Error('uncertain ack'); } } });
  const r = await c.run(s); assert.equal(r.state, 'recovery_required'); assert.equal((await c.imports.history(r.plannedImport.id)).length, 1);
  const saved = await c.service.recover(r.id, r.revision, { confirm: true, operation: 'finalize_result' }); assert.equal(saved.state, 'succeeded'); assert.equal(c.calls.length, 1);
});
test('6-0A: wrong initial import content stops finalization; no overwrite', async t => {
  const c = await executionFixture(t); const s = openService(c, { fault: async p => { if (p === 'before_import_save') throw new Error('disk'); } });
  const r = await c.run(s); const extraction = { schemaVersion: 1, candidates: [] };
  await c.imports.create({ ...c.value, extraction }, { id: r.plannedImport.id }); const before = await storeBytes(c.root);
  await assert.rejects(c.service.recover(r.id, r.revision, { confirm: true, operation: 'finalize_result' })); assert.deepEqual(await storeBytes(c.root), before);
});
for (const failure of ['revision', 'state', 'unknown_field', 'history_gap', 'immutable', 'approval']) test(`6-0A: ${failure} corruption is rejected by execution history validation`, async t => {
  const c = await executionFixture(t); const r = await c.ready();
  if (failure === 'revision') { await assert.rejects(c.store.transition(r.id, 1, 'sending', {}), { status: 409 }); return; }
  await edit(ledgerFile(c), ledger => {
    const row = ledger.executions[0].revisions.at(-1);
    if (failure === 'state') row.state = 'made_up';
    if (failure === 'unknown_field') row.source_checked = true;
    if (failure === 'history_gap') ledger.executions[0].revisions.shift();
    if (failure === 'immutable') row.documents[0].bodyHash = '0'.repeat(64);
    if (failure === 'approval') row.approval.hash = '0'.repeat(64);
  });
  await assert.rejects(createExecutionStore(c.root).read()); assert.equal(c.calls.length, 0);
});
test('6-0A: every terminal state forbids external re-entry by transition contract', () => {
  for (const state of ['succeeded', 'failed_before_request', 'failed_after_request', 'unknown']) assert.deepEqual(transitions[state], []);
  assert.ok(!transitions.recovery_required.includes('sending')); assert.ok(!transitions.import_save_failed.includes('sending'));
});
test('6-0A: corrupt input artifact prevents provider call and releases proven-unsent reservation', async t => {
  const c = await executionFixture(t); const r = await c.ready();
  await edit(path.join(c.root, 'extraction-artifacts', `${r.inputArtifact.id}.json`), a => { a.content.documents[0].text += '改変'; });
  const last = await c.service.execute(r.id, r.revision); assert.equal(last.state, 'failed_before_request'); assert.equal(c.calls.length, 0);
  assert.equal((await createMaintenanceService(c.root).integrity()).status, 'error');
});
test('6-0A: validated artifact tampering blocks local save retry and keeps import absent', async t => {
  const c = await executionFixture(t); const s = openService(c, { fault: async p => { if (p === 'before_import_save') throw new Error('disk'); } }); const r = await c.run(s);
  await edit(path.join(c.root, 'extraction-artifacts', `${r.validatedArtifact.id}.json`), a => { a.content.extraction.candidates[0].text += '改変'; });
  await assert.rejects(c.service.recover(r.id, r.revision, { confirm: true, operation: 'save_only' })); assert.equal(c.calls.length, 1); assert.deepEqual(await c.imports.list(), []);
});
test('6-0A: target offer revision conflict stops before provider and never merges', async t => {
  const c = await executionFixture(t); const r = await c.ready(); const business = { ...c.offer }; for (const k of ['schemaVersion', 'id', 'revision', 'createdAt', 'updatedAt']) delete business[k];
  await c.offers.update(c.offer.id, 1, business);
  const last = await c.service.execute(r.id, r.revision); assert.equal(last.state, 'failed_before_request'); assert.equal(c.calls.length, 0); assert.equal((await c.offers.get(c.offer.id)).revision, 2);
});
test('6-0A: same-root concurrent generation/extraction has only one external owner', async t => {
  let release; let entered; const started = new Promise(r => { entered = r; }); const pending = new Promise(r => { release = r; });
  const c = await executionFixture(t); const s = openService(c, { provider: { kind: 'fake', async extract(args) { entered(); await pending; return c.provider.extract(args); } } });
  const r = await c.ready(s); const work = s.execute(r.id, r.revision); await started;
  await assert.rejects(c.generation.execute(c.plan, c.generation.confirmation(c.plan)), { code: 'ai_in_progress' });
  release(); assert.equal((await work).state, 'succeeded'); assert.equal(c.calls.length, 1);
});
test('6-0A: generation and extraction booked costs share simulation cap', async t => {
  const c = await executionFixture(t, { policy: { ...fixtureBudgetPolicy, simulationStopMilliYen: 10000 } });
  await c.run(); // 1 milli-yen booked leaves less than the generation 10,000 milli-yen reservation.
  await assert.rejects(c.generation.execute(c.plan, c.generation.confirmation(c.plan)), { code: 'common_budget_exceeded' });
  const totals = await c.coordinator.transaction(c => c.totals); assert.equal(totals.simulation.bookedMilliYen, 1);
});
test('6-0A: fake cost never consumes real bucket and no real extraction provider is accepted', async t => {
  const c = await executionFixture(t, { policy: { ...fixtureBudgetPolicy, realStopMilliYen: null } }); await c.run();
  const totals = await c.coordinator.transaction(c => c.totals); assert.equal(totals.real.bookedMilliYen, 0); assert.equal(totals.real.reservedMilliYen, 0);
  assert.throws(() => openService(c, { provider: { kind: 'openai', extract() {} } }), { code: 'fake_only' });
});
test('6-0A: activation explicitly retains legacy current-month fees and old-month records', async t => {
  const c = await executionFixture(t, { activate: false }); const g = createGenerationStore(c.root);
  const old = terminalGeneration(() => new Date('2026-09-01T00:00:00Z')); const current = terminalGeneration(c.now);
  await g.transaction(ledger => { ledger.runs.push(old, current); }); const before = await fs.readFile(path.join(c.root, 'generations/ledger.json'), 'utf8');
  const a = await c.coordinator.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 });
  assert.equal(a.initialBudget.simulation.bookedMilliYen, 3000); assert.equal(a.initialGeneration.length, 2);
  assert.equal(await fs.readFile(path.join(c.root, 'generations/ledger.json'), 'utf8'), before);
});
for (const unsafe of ['unknown', 'running', 'corrupt', 'fee_unknown', 'terminal_reserved', 'missing_ledger']) test(`6-0A: ${unsafe} legacy ledger refuses activation without zero/reset`, async t => {
  const c = await executionFixture(t, { activate: false }); const g = createGenerationStore(c.root);
  await g.transaction(ledger => { ledger.runs.push(terminalGeneration(c.now)); });
  const file = path.join(c.root, 'generations/ledger.json');
  if (unsafe === 'missing_ledger') await fs.unlink(file);
  else await edit(file, ledger => { const r = ledger.runs[0]; if (['unknown', 'running'].includes(unsafe)) { r.state = unsafe; r.reservedYen = 10; r.usage = null; r.estimatedYen = 0; }
    if (unsafe === 'corrupt') ledger.schemaVersion = 22;
    if (unsafe === 'fee_unknown') r.usage = null;
    if (unsafe === 'terminal_reserved') r.reservedYen = 5;
  });
  await assert.rejects(c.coordinator.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 }));
  await assert.rejects(fs.lstat(path.join(c.root, 'ai-budget/activation.json')), { code: 'ENOENT' });
});
test('6-0A: activation confirmation/revision/hash are strict and cannot reactivate', async t => {
  const c = await executionFixture(t, { activate: false });
  await assert.rejects(c.coordinator.activate(fixtureBudgetPolicy, { confirm: false, expectedRevision: 0 }), { status: 400 });
  await assert.rejects(c.coordinator.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 1 }), { status: 400 });
  await c.coordinator.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 });
  await assert.rejects(c.coordinator.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 }), { status: 409 });
  await edit(path.join(c.root, 'ai-budget/activation.json'), a => { a.policy.simulationStopMilliYen++; });
  await assert.rejects(c.coordinator.transaction(() => null), { code: 'activation_required' });
});
test('6-0A: partial activation publication never falls back; second activation refused', async t => {
  const c = await executionFixture(t, { activate: false }); const fileSystem = { ...fs, async link(from, to) { if (to.endsWith('/activation.json')) throw new Error('disk'); return fs.link(from, to); } };
  const broken = createBudgetCoordinator(c.root, { fileSystem, now: c.now });
  await assert.rejects(broken.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 }));
  await assert.rejects(c.coordinator.transaction(() => null)); await assert.rejects(c.coordinator.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 }));
  assert.equal((await createMaintenanceService(c.root).integrity()).stopped, true);
});
test('6-0A: concurrent activation rejects one caller rather than merging policy', async t => {
  const c = await executionFixture(t, { activate: false }); const second = createBudgetCoordinator(c.root, { now: c.now });
  const results = await Promise.allSettled([c.coordinator.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 }), second.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('6-0A: deletion of an anchored task store is never treated as zero usage', async t => {
  const c = await executionFixture(t); await fs.rm(path.join(c.root, 'generations'), { recursive: true });
  await assert.rejects(c.coordinator.transaction(() => null)); assert.equal((await createMaintenanceService(c.root).integrity()).stopped, true);
});
test('6-0A: integer decimal/exponent conversion and costs avoid floating point budget undercounts', () => {
  assert.equal(milliYen(0.1), 100); assert.equal(milliYen(0.0001), 1); assert.equal(milliYen(1e-7), 1); assert.equal(milliYen(1.001), 1001);
  assert.equal(costMilliYen({ inputTokens: 3, outputTokens: 0 }, { inputMilliYenPerMillion: 100000, outputMilliYenPerMillion: 0 }), 1);
});
test('6-0A: old-month unknown reservations remain held; rollover does not unblock', async t => {
  let clock = new Date('2026-10-31T23:59:00Z'); const c = await executionFixture(t, { now: () => clock });
  const s = openService(c, { provider: { kind: 'fake', async extract() { throw new Error('unknown'); } } }); const r = await c.run(s);
  clock = new Date('2026-11-01T00:01:00Z'); const totals = await c.coordinator.transaction(c => c.totals);
  assert.equal(totals.simulation.reservedMilliYen, r.estimate.maximumReservedMilliYen);
  await assert.rejects(c.generation.execute(c.plan, c.generation.confirmation(c.plan)), { code: 'ai_in_progress' });
});
test('6-0A: sending after month rollover books cost in execution-start month', async t => {
  let clock = new Date('2026-10-31T23:59:00Z'); const c = await executionFixture(t, { now: () => clock }); const r = await c.ready();
  clock = new Date('2026-11-01T00:00:10Z'); const saved = await c.service.execute(r.id, r.revision);
  assert.equal(saved.budget.month, '2026-11'); assert.equal((await c.coordinator.transaction(c => c.totals)).simulation.bookedMilliYen, saved.budget.bookedMilliYen);
});
test('6-0A: durable sending save failure/uncertain acknowledgement never calls provider', async t => {
  const c = await executionFixture(t); const r = await c.ready(); let failure = false;
  const fileSystem = { ...fs, async rename(from, to) { if (to === ledgerFile(c)) { failure = true; await fs.rename(from, to); throw new Error('uncertain ack'); } return fs.rename(from, to); } };
  const s = openService(c, { store: createExecutionStore(c.root, { fileSystem, now: c.now }) });
  await assert.rejects(s.execute(r.id, r.revision)); assert.equal(failure, true); assert.equal(c.calls.length, 0);
  await assert.rejects(c.store.read()); assert.equal((await createMaintenanceService(c.root).integrity()).stopped, true);
});
test('6-0A: actual artifact save failure leaves human-review marker and never creates import', async t => {
  const c = await executionFixture(t); const fileSystem = { ...fs, async link(from, to) { if (to.includes('/extraction-artifacts/')) throw new Error('disk'); return fs.link(from, to); } };
  await assert.rejects(openService(c, { artifacts: createArtifactStore(c.root, { fileSystem, now: c.now }) }).prepare(c.value));
  assert.equal(c.calls.length, 0); assert.equal((await createMaintenanceService(c.root).integrity()).stopped, true);
});
test('6-0A: secrets and input over-limit are rejected before artifacts/provider', async t => {
  const c = await executionFixture(t); const value = structuredClone(c.value); value.documents[0].text = 'Cookie=fictional_cookie'; value.documents[0].textHash = hashDocumentText(value.documents[0].text); value.documents[0].blocks = [{ id: 'b', start: 0, end: value.documents[0].text.length }];
  await assert.rejects(c.service.prepare(value)); await assert.rejects(openService(c, { config: { ...fakeExtractionConfig, maxInputTokens: 10 } }).prepare(c.value), { code: 'input_limit' });
  assert.equal(c.calls.length, 0); await assert.rejects(fs.lstat(path.join(c.root, 'extraction-artifacts')), { code: 'ENOENT' });
});
test('6-0A: maintenance v2 includes all seven stores and repeated dry-run changes no data', async t => {
  const c = await executionFixture(t); await c.run(); const maintenance = createMaintenanceService(c.root, { now: c.now }); const before = await allBytes(c.root);
  const backup = await maintenance.create(); assert.equal(backup.manifest.schemaVersion, 2); assert.equal(backup.manifest.directories.length, 7);
  assert.equal(backup.report.status, 'normal'); assert.equal(backup.report.commonBudgetActive, true);
  assert.ok(backup.manifest.files.some(f => f.path === 'ai-budget/activation.json')); assert.equal(backup.report.metrics.artifacts, 2);
  for (let i = 0; i < 3; i++) { const r = await maintenance.dryRun(backup.manifest.id); assert.equal(r.status, 'normal'); assert.equal(r.restored, false); assert.equal(r.aiCoverage, 'complete'); }
  assert.deepEqual(await allBytes(c.root), before); assert.equal(maintenance.restore, undefined);
});
test('6-0A: maintenance v1 remains immutable and explicitly lacks AI/activation coverage', async t => {
  const c = await maintenanceFixture(t); const b = await c.maintenance.create(); assert.equal(b.manifest.schemaVersion, 1);
  const first = await c.maintenance.dryRun(b.manifest.id); assert.equal(first.status, 'normal'); assert.equal(first.aiCoverage, 'legacy_only'); assert.equal(first.commonBudgetActive, false);
  assert.equal(Object.hasOwn(first.report.metrics, 'extractionExecutions'), false); // v1 cannot claim an inspected empty execution ledger.
  await createBudgetCoordinator(c.root, { now: c.now }).activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 });
  const second = await c.maintenance.dryRun(b.manifest.id); assert.equal(second.backupValid, true); assert.equal(second.commonBudgetActive, false); assert.equal(second.manifest.schemaVersion, 1);
});
test('6-0A: unresolved intent is preserved in v2 backup and remains stopped after restart/dry-run', async t => {
  const c = await executionFixture(t); const s = openService(c, { fault: async p => { if (p === 'before_result') throw new Error('disk'); } }); await c.run(s);
  const maintenance = createMaintenanceService(c.root, { now: c.now }); const b = await maintenance.create(); assert.equal(b.report.status, 'human_review_required');
  const read = await createMaintenanceService(c.root, { now: c.now }).dryRun(b.manifest.id); assert.equal(read.backupValid, true); assert.equal(read.stopped, true);
});
for (const corrupt of ['execution', 'artifact', 'activation']) test(`6-0A: v2 integrity/dry-run rejects corrupt ${corrupt} even with recomputed transport hashes`, async t => {
  const c = await executionFixture(t); const r = await c.run(); const m = createMaintenanceService(c.root, { now: c.now }); const backup = await m.create();
  const relative = corrupt === 'execution' ? 'extraction-executions/ledger.json' : corrupt === 'activation' ? 'ai-budget/activation.json' : `extraction-artifacts/${r.inputArtifact.id}.json`;
  const archive = path.join(c.root, 'maintenance-backups', backup.manifest.id); const payload = path.join(archive, 'payload', relative);
  await edit(payload, v => { if (corrupt === 'execution') v.executions[0].revisions[1].approval.hash = '0'.repeat(64); if (corrupt === 'activation') v.policyHash = '0'.repeat(64); if (corrupt === 'artifact') v.contentHash = '0'.repeat(64); });
  const manifest = JSON.parse(await fs.readFile(path.join(archive, 'manifest.json'), 'utf8')); const entry = manifest.files.find(f => f.path === relative); const bytes = await fs.readFile(payload); entry.size = bytes.length; entry.sha256 = hash(bytes);
  manifest.totalBytes = manifest.files.reduce((n, f) => n + f.size, 0); const files = {}; for (const f of manifest.files) files[f.path] = await fs.readFile(path.join(archive, 'payload', f.path)); manifest.snapshotHash = snapshotHash({ directories: manifest.directories, files });
  const raw = JSON.stringify(manifest); await fs.writeFile(path.join(archive, 'manifest.json'), raw); await fs.writeFile(path.join(archive, 'manifest.sha256'), hash(raw) + '\n');
  const result = await m.dryRun(backup.manifest.id); assert.equal(result.stopped, true); assert.equal(result.backupValid, false);
});
test('6-0A: all fixture checks make zero external connection attempts', () => { assert.equal(blockedConnections.length, 0); });

for (const failure of ['import_saving', 'succeeded']) test(`6-0A: actual ${failure} ledger failure is detected after restart and never resends`, async t => {
  const c = await executionFixture(t); let failed = false;
  const fileSystem = { ...fs, async rename(from, to) {
    if (to === ledgerFile(c)) {
      const staged = JSON.parse(await fs.readFile(from, 'utf8'));
      if (staged.executions[0].revisions.at(-1).state === failure) { failed = true; throw new Error('PRIVATE_SYNTHETIC_DISK_FAILURE'); }
    }
    return fs.rename(from, to);
  } };
  const s = openService(c, { store: createExecutionStore(c.root, { fileSystem, now: c.now }) });
  const r = await c.ready(s); await assert.rejects(s.execute(r.id, r.revision)); assert.equal(failed, true); assert.equal(c.calls.length, 1);
  await assert.rejects(createExecutionStore(c.root).read());
  const imports = await c.imports.list(); assert.equal(imports.length, failure === 'succeeded' ? 1 : 0);
  const report = await createMaintenanceService(c.root).integrity(); assert.equal(report.stopped, true);
  await assert.rejects(c.generation.execute(c.plan, c.generation.confirmation(c.plan))); assert.equal(c.calls.length, 1);
});
test('6-0A: validated artifact filesystem failure retains known usage and requires human review', async t => {
  const c = await executionFixture(t); let failed = false;
  const fileSystem = { ...fs, async link(from, to) {
    if (to.includes('/extraction-artifacts/') && JSON.parse(await fs.readFile(from, 'utf8')).type === 'validated_extraction') { failed = true; throw new Error('disk'); }
    return fs.link(from, to);
  } };
  const s = openService(c, { artifacts: createArtifactStore(c.root, { fileSystem, now: c.now }) });
  const r = await c.run(s); assert.equal(failed, true); assert.equal(r.state, 'recovery_required'); assert.ok(r.budget.bookedMilliYen > 0);
  assert.equal(c.calls.length, 1); assert.deepEqual(await c.imports.list(), []); assert.equal((await createMaintenanceService(c.root).integrity()).stopped, true);
});
test('6-0A: no common/task/artifact filesystem lock is retained during provider call', async t => {
  const c = await executionFixture(t); const s = openService(c, { provider: { kind: 'fake', async extract(args) {
    for (const dir of ['ai-budget', 'generations', 'extraction-executions', 'extraction-artifacts', 'offer-imports', 'offers'])
      await assert.rejects(fs.lstat(path.join(c.root, dir, '.lock')), { code: 'ENOENT' });
    return c.provider.extract(args);
  } } });
  assert.equal((await c.run(s)).state, 'succeeded'); assert.equal(c.calls.length, 1);
});
test('6-0A: concurrent local save retry makes one import and never calls provider again', async t => {
  const c = await executionFixture(t); const s = openService(c, { fault: async p => { if (p === 'before_import_save') throw new Error('disk'); } }); const r = await c.run(s);
  const results = await Promise.allSettled([1, 2].map(() => c.service.recover(r.id, r.revision, { confirm: true, operation: 'save_only' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await c.imports.history(r.plannedImport.id)).length, 1); assert.equal(c.calls.length, 1);
});
test('6-0A: receipt unknown fields fail validation without leaking them into ledger/artifacts', async t => {
  const c = await executionFixture(t); const s = openService(c, { provider: { kind: 'fake', async extract(args) { return { ...await c.provider.extract(args), password: 'FICTIONAL_UNSAVED_RESPONSE' }; } } });
  const r = await c.run(s); assert.equal(r.state, 'failed_after_request'); assert.ok(!JSON.stringify(await c.store.read()).includes('FICTIONAL_UNSAVED_RESPONSE')); assert.deepEqual(await c.imports.list(), []);
});
test('6-0A: anchor ledger fee changes are refused rather than silently resetting initial budget', async t => {
  const c = await executionFixture(t, { activate: false }); const g = createGenerationStore(c.root); await g.transaction(l => l.runs.push(terminalGeneration(c.now)));
  await c.coordinator.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 });
  await edit(path.join(c.root, 'generations/ledger.json'), l => l.runs[0].estimatedYen = 2);
  await assert.rejects(c.coordinator.transaction(() => null), { code: 'activation_baseline_mismatch' }); assert.equal((await createMaintenanceService(c.root).integrity()).stopped, true);
});
test('6-0A: artifact symlink and traversal IDs stop before reading arbitrary files', async t => {
  const c = await executionFixture(t); const r = await c.service.prepare(c.value); const store = createArtifactStore(c.root);
  await assert.rejects(store.read({ ...r.inputArtifact, id: '../outside' }, r.id, 'input'));
  const file = path.join(c.root, 'extraction-artifacts', `${r.inputArtifact.id}.json`); const other = path.join(c.root, 'fictional-outside.json');
  await fs.rename(file, other); await fs.symlink(other, file);
  await assert.rejects(store.read(r.inputArtifact, r.id, 'input')); assert.equal(c.calls.length, 0);
});
test('6-0A: published schema inventories match strict v1 contract and leave old schemas untouched', async t => {
  const c = await executionFixture(t); const r = await c.service.prepare(c.value);
  const executionSchema = JSON.parse(await fs.readFile(new URL('../schemas/extraction-execution.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(r).sort(), executionSchema.$defs.execution.required.sort()); assert.equal(executionSchema.$defs.execution.additionalProperties, false);
  const artifactSchema = JSON.parse(await fs.readFile(new URL('../schemas/extraction-artifact.schema.json', import.meta.url), 'utf8'));
  const a = JSON.parse(await fs.readFile(path.join(c.root, 'extraction-artifacts', `${r.inputArtifact.id}.json`), 'utf8')); assert.deepEqual(Object.keys(a).sort(), artifactSchema.required.sort());
  const activationSchema = JSON.parse(await fs.readFile(new URL('../schemas/ai-budget-activation.schema.json', import.meta.url), 'utf8')); assert.deepEqual(Object.keys(await c.coordinator.activation()).sort(), activationSchema.required.sort());
});
test('6-0A: changed model/configuration after approval cannot use the old sending approval or reservation', async t => {
  const c = await executionFixture(t); const r = await c.ready();
  const changed = openService(c, { config: { ...fakeExtractionConfig, maxOutputTokens: 20000 } });
  const result = await changed.execute(r.id, r.revision); assert.equal(result.state, 'failed_before_request'); assert.equal(c.calls.length, 0);
  assert.equal(result.budget.reservedMilliYen, 0);
});
test('6-0A: changed configuration before approval requires a new prepared confirmation', async t => {
  const c = await executionFixture(t); const r = await c.service.prepare(c.value);
  await assert.rejects(openService(c, { config: { ...fakeExtractionConfig, maxOutputTokens: 20000 } }).approve(r.id, 1, { confirm: true, requestHash: r.requestHash }), { code: 'configuration_conflict' });
  assert.equal((await c.store.get(r.id)).state, 'prepared'); assert.equal(c.calls.length, 0);
});
test('6-0A: preparing freezes caller input before filesystem waits', async t => {
  const c = await executionFixture(t); const original = structuredClone(c.value); const promise = c.service.prepare(c.value);
  c.value.documents[0].label = '呼出し側が後から変更した架空資料'; const r = await promise;
  const a = await createArtifactStore(c.root).read(r.inputArtifact, r.id, 'input'); assert.deepEqual(a.content, original); assert.equal(r.documents[0].label, original.documents[0].label);
});
test('6-0A: future provider identity is metadata and cannot authorize real execution through fake service', async t => {
  const c = await executionFixture(t); const r = await c.service.prepare(c.value);
  await edit(ledgerFile(c), ledger => { const row = ledger.executions[0].revisions[0]; row.provider = 'openai'; row.model = 'fictional-future-model'; row.requestHash = requestDigest(row.inputArtifact.hash, row.configuration, row.provider, row.model); });
  const row = await c.store.get(r.id);
  await assert.rejects(c.service.approve(row.id, row.revision, { confirm: true, requestHash: row.requestHash }), { code: 'fake_only' }); assert.equal(c.calls.length, 0);
});
test('6-0A: archival real-provider accounting stays separate from simulation costs without any real request', async t => {
  const c = await executionFixture(t); const saved = await c.run(); const original = await c.store.read();
  const mockArchive = structuredClone(original);
  for (const r of mockArchive.executions[0].revisions) { r.provider = 'openai'; r.model = 'fictional-future-model'; r.requestHash = requestDigest(r.inputArtifact.hash, r.configuration, r.provider, r.model); if (r.approval) r.approval.hash = r.requestHash; }
  validateExecutionLedger(mockArchive);
  const totals = aggregateBudget({ schemaVersion: 1, runs: [] }, mockArchive, c.now());
  assert.equal(totals.real.bookedMilliYen, saved.budget.bookedMilliYen); assert.equal(totals.simulation.bookedMilliYen, 0);
  assert.deepEqual(await c.store.read(), original); assert.equal(c.calls.length, 1); // Cloned fictional accounting, never real billing or persistence.
});
test('6-0A: credential property in legacy ledger blocks activation without persisting it again', async t => {
  const c = await executionFixture(t, { activate: false }); const g = createGenerationStore(c.root); await g.transaction(l => l.runs.push(terminalGeneration(c.now)));
  await edit(path.join(c.root, 'generations/ledger.json'), l => l.runs[0].password = 'FICTIONAL_REJECTED_LEGACY_VALUE');
  await assert.rejects(c.coordinator.activate(fixtureBudgetPolicy, { confirm: true, expectedRevision: 0 }), { code: 'secret_rejected' });
  await assert.rejects(fs.lstat(path.join(c.root, 'ai-budget/activation.json')), { code: 'ENOENT' });
});
