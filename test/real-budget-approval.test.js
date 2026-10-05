import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createGenerationStore } from '../lib/ai/generation-store.js';
import { validateRealApproval } from '../lib/ai/real-budget-approval.js';
import { createBudgetCoordinator } from '../lib/ai/budget-coordinator.js';
import { realAmount } from '../lib/ai/budget-pages.js';
import { digest } from '../lib/ai/safety-storage.js';
import { createExtractionService } from '../lib/offer-import/extraction-service.js';
import { createGenerationService } from '../lib/ai/generation-service.js';
import { createDraftStore } from '../lib/drafts.js';
import { createFakeProvider } from '../lib/ai/fake-provider.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { capture, hash } from '../lib/maintenance/snapshot.js';
import { createApp } from '../server.js';
import { executionFixture } from './fixtures/extraction-execution.js';
import { maintenanceFixture } from './fixtures/maintenance.js';
import { fixtureBudgetPolicy } from './fixtures/ai-budget.js';
import { blockedConnections } from './helpers/network-guard.js';

const fixture = t => executionFixture(t, { policy: { ...fixtureBudgetPolicy, realStopMilliYen: null } });
const bytes = async c => Object.fromEntries(Object.entries((await capture(c.root)).files).map(([k,v]) => [k,v.toString()]));
const enable = async (c, amount = 100000) => c.coordinator.enableReal((await c.coordinator.previewRealApproval(amount)).token, { confirm: true });
const approvalPath = c => path.join(c.root, 'ai-budget/real-approval.json');

test('6-1A: preview writes no record; one-time approval preserves activation and all task ledgers', async t => {
  const c = await fixture(t); await c.run(); const before = await bytes(c);
  const p = await c.coordinator.previewRealApproval(100123); assert.deepEqual(await bytes(c), before);
  const r = await c.coordinator.enableReal(p.token, { confirm: true });
  assert.equal(r.realStopMilliYen, 100123); assert.equal(r.revision, 1); assert.equal(r.expectedRevision, 0);
  assert.equal(r.activationHash, digest(await c.coordinator.activation()));
  const after = await bytes(c); for (const [name, value] of Object.entries(before)) assert.equal(after[name], value);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 2);
  assert.equal((await c.coordinator.activation()).policy.realStopMilliYen, null);
  const state = await createBudgetCoordinator(c.root, { now: c.now }).state();
  assert.equal(state.effectivePolicy.realStopMilliYen, 100123); assert.ok(state.totals.simulation.bookedMilliYen > 0);
  await assert.rejects(c.coordinator.enableReal(p.token, { confirm: true }), { code: 'real_already_enabled' });
  await assert.rejects(c.coordinator.previewRealApproval(200000), { code: 'real_already_enabled' });
});

test('6-1A: pre-existing positive real policy cannot change or disable', async t => {
  const c = await executionFixture(t);
  for (const n of [100000, 200000]) await assert.rejects(c.coordinator.previewRealApproval(n), { code: 'real_already_enabled' });
  for (const n of [0, -1, null]) await assert.rejects(c.coordinator.previewRealApproval(n));
  await assert.rejects(fs.lstat(approvalPath(c)), { code: 'ENOENT' });
});

for (const text of ['0', '-1', '0.000', '1.0001', 'NaN', '1e2', ' 100', '100 ', '<svg>', '']) test(`6-1A: invalid yen amount ${JSON.stringify(text)} refused`, () => assert.throws(() => realAmount(text)));
test('6-1A: yen conversion is exact in milliYen without fixed 100 yen', () => {
  assert.equal(realAmount('0.001'), 1); assert.equal(realAmount('123.456'), 123456); assert.equal(realAmount('100'), 100000);
});

const generationRecord = (c, state) => ({ id: randomUUID(), planId: randomUUID(), ...(state === 'succeeded' ? { draftId: randomUUID() } : {}),
  state, month: c.now().toISOString().slice(0,7), createdAt: c.now().toISOString(), updatedAt: c.now().toISOString(),
  provider: 'openai', model: 'gpt-6-luna', simulation: false, attempted: true,
  usage: ['running','unknown'].includes(state) ? null : { inputTokens:100, outputTokens:100 },
  reservedYen: ['running','unknown'].includes(state) ? 2 : 0, estimatedYen: ['running','unknown'].includes(state) ? 0 : 3 });
for (const state of ['unknown', 'running', 'validated', 'save-failed']) test(`6-1A: ${state} generation blocks real approval`, async t => {
  const c = await fixture(t); await createGenerationStore(c.root).transaction(ledger => ledger.runs.push(generationRecord(c,state)));
  await assert.rejects(c.coordinator.previewRealApproval(100000)); await assert.rejects(fs.lstat(approvalPath(c)), { code:'ENOENT' });
});
test('6-1A: existing real costs are carried forward and small stop amount rejected', async t => {
  const c = await fixture(t); await createGenerationStore(c.root).transaction(ledger => ledger.runs.push(generationRecord(c,'succeeded')));
  const before = await bytes(c);
  await assert.rejects(c.coordinator.previewRealApproval(2999), { code:'common_budget_exceeded' });
  await enable(c,100000); const state = await c.coordinator.state(); assert.equal(state.totals.real.bookedMilliYen,3000);
  const after = await bytes(c); for (const [name,value] of Object.entries(before)) assert.equal(after[name],value);
});
test('6-1A: approval and anchor match schema fields; rehashed policy/binding tampering rejected', async t => {
  const c = await fixture(t); const r = await enable(c);
  const schema = JSON.parse(await fs.readFile(new URL('../schemas/ai-real-budget-approval.schema.json',import.meta.url)));
  const anchorSchema = JSON.parse(await fs.readFile(new URL('../schemas/ai-real-budget-approval-anchor.schema.json',import.meta.url)));
  assert.deepEqual(Object.keys(r).sort(),schema.required.slice().sort());
  const anchor = JSON.parse(await fs.readFile(path.join(c.root,'ai-budget/real-approval-anchor.json')));
  assert.deepEqual(Object.keys(anchor).sort(),anchorSchema.required.slice().sort());
  const activation = await c.coordinator.activation();
  for (const kind of ['binding','simulation','version','negative']) {
    const changed = structuredClone(r);
    if (kind === 'binding') changed.activationHash = '0'.repeat(64);
    if (kind === 'simulation') changed.effectivePolicy.simulationStopMilliYen++;
    if (kind === 'version') changed.effectivePolicy.version = 'other-policy';
    if (kind === 'negative') changed.realStopMilliYen = -1;
    changed.effectivePolicyHash = digest(changed.effectivePolicy); delete changed.recordHash; changed.recordHash = digest(changed);
    assert.throws(() => validateRealApproval(changed, activation));
  }
});

for (const phase of ['approved', 'sending', 'unknown', 'import_save_failed']) test(`6-1A: ${phase} extraction blocks approval`, async t => {
  const c = await fixture(t);
  if (phase === 'approved') await c.ready();
  else {
    const service = createExtractionService({ ...c.options, ...(phase === 'unknown' ? { provider: { kind: 'fake', async extract() { throw new Error('fictional'); } } } :
      { fault: async p => { if (p === (phase === 'sending' ? 'after_sending' : 'before_import_save')) throw new Error('fictional'); } }) });
    if (phase === 'sending') await assert.rejects(c.run(service)); else await c.run(service);
  }
  await assert.rejects(c.coordinator.previewRealApproval(100000));
  await assert.rejects(fs.lstat(approvalPath(c)), { code: 'ENOENT' });
});

for (const defect of ['activation', 'generation', 'extraction', 'offer', 'artifact', 'partial', 'unclassified', 'missing_store']) test(`6-1A: corrupt/unclassifiable ${defect} blocks approval`, async t => {
  const c = await fixture(t);
  if (defect === 'artifact') { const r = await c.service.prepare(c.value); await fs.writeFile(path.join(c.root, 'extraction-artifacts', r.inputArtifact.id + '.json'), '{}'); }
  else if (defect === 'partial') await fs.writeFile(path.join(c.root, 'ai-budget/.write-intent'), '{}');
  else if (defect === 'unclassified') await fs.writeFile(path.join(c.root, 'ai-budget/unrecognized.json'), '{}');
  else if (defect === 'missing_store') await fs.rename(path.join(c.root, 'generations/ledger.json'), path.join(c.root, 'missing-fictional-ledger'));
  else await fs.writeFile(path.join(c.root, { activation: 'ai-budget/activation.json', generation: 'generations/ledger.json', extraction: 'extraction-executions/ledger.json', offer: `offers/${c.offer.id}.json` }[defect]), '{}');
  await assert.rejects(c.coordinator.previewRealApproval(100000));
  await assert.rejects(fs.lstat(approvalPath(c)), { code: 'ENOENT' });
});

test('6-1A: concurrent coordinators save at most one approval, no task ledger mutation', async t => {
  const c = await fixture(t); const other = createBudgetCoordinator(c.root, { now: c.now });
  const p = await c.coordinator.previewRealApproval(100000); const q = await other.previewRealApproval(200000);
  const results = await Promise.allSettled([c.coordinator.enableReal(p.token, { confirm: true }), other.enableReal(q.token, { confirm: true })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok([100000, 200000].includes((await c.coordinator.state()).effectivePolicy.realStopMilliYen));
});

test('6-1A: changed snapshot, unchecked, tampered, restarted and expired confirmation stop', async t => {
  const c = await fixture(t); const p = await c.coordinator.previewRealApproval(100000);
  await assert.rejects(c.coordinator.enableReal(p.token, { confirm: false }));
  await assert.rejects(c.coordinator.enableReal(p.token + 'x', { confirm: true }));
  await assert.rejects(createBudgetCoordinator(c.root, { now: c.now }).enableReal(p.token, { confirm: true }));
  await c.service.prepare(c.value);
  await assert.rejects(c.coordinator.enableReal(p.token, { confirm: true }), { code: 'real_approval_conflict' });
  let time = c.now().getTime(); const budget = createBudgetCoordinator(c.root, { now: () => new Date(time) });
  const q = await budget.previewRealApproval(100000); time += 15 * 60 * 1000;
  await assert.rejects(budget.enableReal(q.token, { confirm: true }), { code: 'real_approval_expired' });
});

for (const failure of ['before_record', 'record_link', 'record_sync']) test(`6-1A: ${failure} partial save retains anchor and blocks after restart`, async t => {
  const c = await fixture(t); let injected = false;
  const fileSystem = { ...fs,
    async open(file, ...args) {
      if (failure === 'before_record' && file.endsWith('/.write-intent') && await fs.stat(path.join(c.root, 'ai-budget/real-approval-anchor.json')).then(() => true, () => false)) { injected = true; throw new Error('fictional'); }
      return fs.open(file, ...args);
    },
    async link(from, to) { if (failure === 'record_link' && to.endsWith('/real-approval.json')) { injected = true; throw new Error('fictional'); } return fs.link(from,to); },
    async readFile(file, ...args) { if (failure === 'record_sync' && file.endsWith('/real-approval.json')) { injected = true; throw new Error('fictional'); } return fs.readFile(file,...args); },
  };
  const budget = createBudgetCoordinator(c.root, { now: c.now, fileSystem }); const p = await budget.previewRealApproval(100000);
  await assert.rejects(budget.enableReal(p.token, { confirm: true })); assert.ok(injected);
  const restarted = createBudgetCoordinator(c.root, { now: c.now });
  await assert.rejects(restarted.state()); await assert.rejects(restarted.previewRealApproval(200000));
  await assert.rejects(c.service.prepare(c.value)); await assert.rejects(c.generation.execute(c.plan, c.generation.confirmation(c.plan)));
  assert.equal((await c.coordinator.activation().catch(() => null))?.policy.realStopMilliYen ?? null, null);
  const maintenance = createMaintenanceService(c.root, { now: c.now }); assert.ok((await maintenance.integrity()).stopped); await assert.rejects(maintenance.create());
});

for (const defect of ['record_missing', 'anchor_missing', 'hash', 'binding', 'duplicate']) test(`6-1A: ${defect} approval stops common budget and maintenance`, async t => {
  const c = await fixture(t); await enable(c);
  if (defect === 'record_missing' || defect === 'anchor_missing') await fs.rename(path.join(c.root, 'ai-budget', defect === 'record_missing' ? 'real-approval.json' : 'real-approval-anchor.json'), path.join(c.root, 'fictional-removed-approval'));
  else if (defect === 'duplicate') await fs.copyFile(approvalPath(c), path.join(c.root, 'ai-budget/real-approval-copy.json'));
  else { const r = JSON.parse(await fs.readFile(approvalPath(c))); r[defect === 'hash' ? 'realStopMilliYen' : 'activationHash'] = defect === 'hash' ? 200000 : '0'.repeat(64); await fs.writeFile(approvalPath(c), JSON.stringify(r)); }
  await assert.rejects(c.coordinator.state());
  await assert.rejects(c.service.prepare(c.value)); await assert.rejects(c.generation.execute(c.plan, c.generation.confirmation(c.plan)));
  assert.ok((await createMaintenanceService(c.root).integrity()).stopped);
});

test('6-1A: generation and extraction share effective real cap, simulation stays separate', async t => {
  const c = await fixture(t); await enable(c, 1500); let calls = 0;
  const fake = createFakeProvider();
  const generation = createGenerationService({ dataDirectory: c.root, now: c.now, draftStore: createDraftStore(c.root),
    provider: { kind: 'openai', async generate(args) { calls++; return fake.generate(args); } }, config: { provider: 'openai' } });
  await assert.rejects(generation.execute(c.plan, generation.confirmation(c.plan)), { code: 'common_budget_exceeded' }); assert.equal(calls, 0);
  await c.coordinator.transaction(common => { assert.equal(common.effectivePolicy.realStopMilliYen, 1500); assert.throws(() => common.check(1501, false), { code: 'common_budget_exceeded' }); common.check(1500, false); });
  const r = await c.run(); assert.equal(r.state, 'succeeded');
  assert.equal((await c.coordinator.state()).totals.real.bookedMilliYen, 0);
});

test('6-1A: v2 backup includes approval pair; dry-run validates binding without writes', async t => {
  const c = await fixture(t); await enable(c); const before = await bytes(c); const m = createMaintenanceService(c.root, { now: c.now });
  const b = await m.create(); assert.equal(b.manifest.schemaVersion, 2); assert.equal(b.manifest.contracts.realBudgetApproval, 1);
  assert.ok(b.manifest.files.some(f => f.path === 'ai-budget/real-approval.json')); assert.ok(b.manifest.files.some(f => f.path === 'ai-budget/real-approval-anchor.json'));
  assert.equal(b.report.realBudgetApprovalStatus, 'valid');
  const dry = await m.dryRun(b.manifest.id); assert.equal(dry.backupValid, true); assert.equal(dry.status, 'normal'); assert.equal(dry.realBudgetApprovalStatus, 'valid'); assert.equal(dry.report.effectiveRealStopMilliYen, 100000);
  assert.deepEqual(await bytes(c), before);
  await fs.writeFile(path.join(c.root, 'maintenance-backups', b.manifest.id, 'payload/ai-budget/real-approval.json'), '{}');
  assert.equal((await m.dryRun(b.manifest.id)).backupValid, false);
});

test('6-1A: existing v2 and v1 backups remain readable without claiming approval coverage', async t => {
  const c = await fixture(t); const m = createMaintenanceService(c.root, { now: c.now }); const b = await m.create();
  const dir = path.join(c.root, 'maintenance-backups', b.manifest.id); const manifest = structuredClone(b.manifest); delete manifest.contracts.realBudgetApproval;
  const raw = JSON.stringify(manifest, null, 2) + '\n'; await fs.writeFile(path.join(dir, 'manifest.json'), raw); await fs.writeFile(path.join(dir, 'manifest.sha256'), hash(raw) + '\n');
  await enable(c); const old = await m.dryRun(b.manifest.id); assert.equal(old.backupValid, true); assert.equal(old.realBudgetApprovalCoverage, 'not_covered'); assert.equal(old.realBudgetApprovalStatus, 'not_covered'); assert.equal(old.report.effectiveRealStopMilliYen, null);
  const legacy = await maintenanceFixture(t); const v1 = await legacy.maintenance.create();
  const dry = await legacy.maintenance.dryRun(v1.manifest.id); assert.equal(dry.backupValid, true); assert.equal(dry.realBudgetApprovalCoverage, 'not_covered');
});

async function httpFixture(t) {
  const c = await fixture(t); const server = createApp({ dataDirectory: c.root, generationOptions: { now: c.now } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0,'127.0.0.1',resolve); }); t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, data, headers = {}) => fetch(base + url, { method: 'POST', headers: { Origin: base, ...headers }, body: new URLSearchParams(data), redirect: 'manual' });
  return { ...c, base, post };
}
test('6-1A HTTP: two-stage explicit confirmation, shared-budget notice, CSP, no change after save', async t => {
  const c = await httpFixture(t); const before = await bytes(c);
  const get = await fetch(c.base + '/maintenance/ai-budget'); assert.match(get.headers.get('content-security-policy'), /form-action 'self'/); assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.match(await get.text(), /real-preview/); assert.deepEqual(await bytes(c), before);
  const preview = await c.post('/maintenance/ai-budget/real-preview', { realYen: '100.123' }); const html = await preview.text(); assert.equal(preview.status, 200);
  assert.match(html, /100123 milliYen/); assert.match(html, /記事生成と案件抽出の両方/); assert.match(html, /API残高そのものとは別/); assert.ok(!html.includes('checked'));
  const token = html.match(/name="token" value="([^"]+)"/)[1]; assert.deepEqual(await bytes(c), before);
  assert.equal((await c.post('/maintenance/ai-budget/enable-real', { token })).status, 400);
  assert.equal((await c.post('/maintenance/ai-budget/enable-real', { confirm: 'yes', token, realYen: '200' })).status, 400);
  assert.equal((await c.post('/maintenance/ai-budget/enable-real', { confirm: 'yes', token })).status, 303);
  assert.equal((await c.post('/maintenance/ai-budget/enable-real', { confirm: 'yes', token })).status, 409);
  const saved = await (await fetch(c.base + '/maintenance/ai-budget')).text(); assert.match(saved, /100.123円/); assert.ok(!saved.includes('action="/maintenance/ai-budget/real-preview"'));
});

for (const defect of ['origin', 'missing_origin', 'cross_site', 'duplicate', 'unknown', 'xss', 'content_type', 'oversize', 'host']) test(`6-1A HTTP: ${defect} refused without record or reflected secrets`, async t => {
  const c = await httpFixture(t); const headers = { Origin: c.base }; const data = new URLSearchParams({ realYen: '100' });
  if (defect === 'origin') headers.Origin = 'https://outside.test'; if (defect === 'missing_origin') delete headers.Origin;
  if (defect === 'cross_site') headers['Sec-Fetch-Site'] = 'cross-site'; if (defect === 'duplicate') data.append('realYen','200');
  if (defect === 'unknown') data.set('token','fictional-secret'); if (defect === 'xss') data.set('realYen','<svg onload=fictional>');
  if (defect === 'content_type') headers['Content-Type'] = 'application/json'; if (defect === 'oversize') data.set('realYen', '1'.repeat(5000));
  let response;
  if (defect === 'host') response = await new Promise((resolve,reject) => { const r = http.request(c.base + '/maintenance/ai-budget/real-preview', { method:'POST', headers:{ ...headers, Host:'outside.test', 'Content-Type':'application/x-www-form-urlencoded' } }, res => { res.resume(); res.on('end', () => resolve({status:res.statusCode,text:async()=>''})); }); r.on('error',reject); r.end(data.toString()); });
  else response = await fetch(c.base + '/maintenance/ai-budget/real-preview', { method:'POST',headers,body:data });
  assert.ok([400,403,413,415].includes(response.status)); const html = await response.text(); assert.ok(!html.includes('fictional-secret')); assert.ok(!html.includes('<svg'));
  await assert.rejects(fs.lstat(approvalPath(c)), { code:'ENOENT' });
});
test('6-1A: tests make no external connection attempts', () => assert.equal(blockedConnections.length, 0));
