import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server.js';
import { reflectionV2Fixture, reflectionV2Form, noneChoice, targetChoice } from './fixtures/reflection-v2.js';
import { createMappingDraftStore, mappingDraftBinding, mappingDraftMatches, mappingDraftProgress } from '../lib/offer-import/reflection-mapping-draft.js';
import { createReflectionService } from '../lib/offer-import/reflection-service.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { blockedConnections } from './helpers/network-guard.js';
const blank = candidateId => ({ candidateId, mode: '', conversionIds: [], reason: '', commonConfirmed: false });
const draftStore = (c, extra = {}) => createMappingDraftStore({ dataDirectory: c.directory, importStore: c.imports, offerStore: c.offers, now: c.now, ...extra });
const partial = c => c.draft.candidates.map((x, i) => i === 0 ? targetChoice(x.id, 'seminar') : blank(x.id));
const save = (s, c, revision = 0, choices = partial(c)) => s.save(c.draft.id, c.offer.id, revision, mappingDraftBinding(c.draft, c.offer), choices);
const recordPath = c => path.join(c.directory, 'reflection-mapping-drafts', `${c.draft.id}--${c.offer.id}.json`);
function form(c, choices, revision) {
  const f = reflectionV2Form(c, { ...c.options, choices });
  f.set('draftAction', 'save'); f.set('draftRevision', String(revision));
  const b = mappingDraftBinding(c.draft, c.offer); f.set('importHash', b.importHash); f.set('offerHash', b.offerHash);
  return f;
}
async function http(t, c) {
  const server = createApp({ dataDirectory: c.directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.listening ? new Promise(resolve => server.close(resolve)) : undefined);
  const base = `http://127.0.0.1:${server.address().port}`, route = `/offer-imports/${c.draft.id}/reflection-v2`;
  return { server, base, route, post: f => fetch(base + route, { method: 'POST', body: f, headers: { Origin: base }, redirect: 'manual' }) };
}

test('mapping draft: 26 partial choices persist through reload, store restart and edits without formal writes', async t => {
  const c = await reflectionV2Fixture(t, { size: 26, blockedDisclosure: true }); const s = draftStore(c);
  const imp = await fs.readFile(path.join(c.directory, 'offer-imports', c.draft.id + '.json')); const offer = await fs.readFile(path.join(c.directory, 'offers', c.offer.id + '.json'));
  const choices = partial(c); choices[2] = { ...targetChoice('candidate-3', 'seminar', 'membership'), commonConfirmed: false }; choices[5] = { ...noneChoice('candidate-6'), reason: '' }; choices[19].reason = '後日判断する';
  const first = await save(s, c, 0, choices); assert.equal(first.revision, 1); assert.deepEqual(first.choices, choices);
  assert.deepEqual(await draftStore(c).get(c.draft.id, c.offer.id), first);
  assert.deepEqual(mappingDraftProgress(first, c.draft, c.offer), { complete: 1, incomplete: 25 });
  choices[2].commonConfirmed = true; choices[5].reason = '報酬優先ルール'; choices[0] = targetChoice('candidate-1', 'membership');
  const edited = await save(draftStore(c), c, 1, choices); assert.equal(edited.revision, 2); assert.deepEqual(edited.choices, choices);
  assert.equal((await s.history(c.draft.id, c.offer.id)).length, 2);
  assert.deepEqual(await fs.readFile(path.join(c.directory, 'offer-imports', c.draft.id + '.json')), imp);
  assert.deepEqual(await fs.readFile(path.join(c.directory, 'offers', c.offer.id + '.json')), offer);
  assert.deepEqual((await c.audit.read()).events, []); assert.equal((await c.offers.get(c.offer.id)).revision, 1);
});

for (const size of [26, 200]) test(`mapping draft HTTP: ${size} partial choices round-trip and survive app restart using native forms`, async t => {
  const c = await reflectionV2Fixture(t, { size, blockedDisclosure: true }); let h = await http(t, c);
  const first = await h.post(form(c, partial(c), 0)); assert.equal(first.status, 303);
  let html = await (await fetch(h.base + h.route)).text(); assert.ok(html.includes('下書きから再開')); assert.ok(html.includes('入力済み 1件')); assert.ok(html.includes(`未入力・未完了 ${size - 1}件`));
  assert.ok(html.includes('value="conversions" selected')); assert.ok(html.includes('value="seminar" checked')); assert.ok(html.includes('formnovalidate'));
  await new Promise(resolve => h.server.close(resolve)); h = await http(t, c);
  html = await (await fetch(h.base + h.route)).text(); assert.ok(html.includes('下書きrevision 1'));
  const choices = partial(c); choices[0] = targetChoice('candidate-1', 'membership');
  assert.equal((await h.post(form(c, choices, 1))).status, 303);
  html = await (await fetch(h.base + h.route)).text(); assert.ok(html.includes('下書きrevision 2')); assert.ok(html.includes('value="membership" checked'));
  assert.equal((await h.post(form(c, choices, 1))).status, 409);
});

for (const kind of ['offer', 'import']) test(`mapping draft: ${kind} revision change stops resume, overwrite and preview`, async t => {
  const c = await reflectionV2Fixture(t, { size: 26, blockedDisclosure: true }); const s = draftStore(c); await save(s, c);
  const before = await fs.readFile(recordPath(c));
  if (kind === 'offer') { const { id, schemaVersion, revision, createdAt, updatedAt, ...input } = c.offer; await c.offers.update(id, revision, { ...input, name: '架空の変更後案件' }); }
  else await c.imports.review(c.draft.id, 'candidate-1', c.draft.revision, { decision: 'accepted', edited: null, sourceChecked: false, reason: '' });
  const h = await http(t, c); const response = await fetch(h.base + h.route); assert.equal(response.status, 409); const html = await response.text(); assert.ok(html.includes('stale')); assert.ok(!html.includes('data-reflection-v2-form'));
  assert.equal((await h.post(form(c, partial(c), 1))).status, 409);
  const previewForm = form(c, c.options.choices, 1); previewForm.delete('draftAction'); assert.equal((await h.post(previewForm)).status, 409);
  await assert.rejects(save(s, c, 1), { status: 409 }); assert.deepEqual(await fs.readFile(recordPath(c)), before);
  const report = await createMaintenanceService(c.directory, { now: c.now }).integrity(); assert.ok(report.issues.some(x => x.code === 'mapping_draft_stale'));
});

for (const field of ['text', 'category', 'usage', 'evidence']) test(`mapping draft: same-revision ${field} snapshot change is stale without rewriting saved judgment`, async t => {
  const c = await reflectionV2Fixture(t, { size: 26, blockedDisclosure: true }); await save(draftStore(c), c);
  const before = await fs.readFile(recordPath(c)); const changed = structuredClone(c.draft);
  if (field === 'evidence') changed.candidates[0].original.evidence[0].quote += '変更'; else changed.candidates[0].original[field] = 'changed';
  const saved = await draftStore(c).get(c.draft.id, c.offer.id); assert.equal(mappingDraftMatches(saved, changed, c.offer), false);
  const s = draftStore(c, { importStore: { ...c.imports, get: async () => changed } });
  await assert.rejects(s.save(c.draft.id, c.offer.id, 1, mappingDraftBinding(c.draft, c.offer), partial(c)), { status: 409 });
  assert.deepEqual(await fs.readFile(recordPath(c)), before);
});

test('mapping draft: policy violation, duplicate and nonexistent destinations never persist or coerce', async t => {
  const c = await reflectionV2Fixture(t, { size: 26, blockedDisclosure: true }); const s = draftStore(c);
  for (const [index, choice] of [[19, { ...noneChoice('candidate-20'), mode: 'offer' }], [0, targetChoice('candidate-1', 'missing')], [2, targetChoice('candidate-3', 'seminar', 'seminar')], [0, targetChoice('candidate-1', 'seminar', 'membership')]]) {
    const choices = partial(c); choices[index] = choice; await assert.rejects(save(s, c, 0, choices), { status: 400 });
    assert.equal(await s.get(c.draft.id, c.offer.id), null);
  }
  const choices = partial(c); choices[19] = { ...blank('candidate-20'), reason: '<img src=x onerror=alert(1)>' };
  await save(s, c, 0, choices); assert.deepEqual((await s.get(c.draft.id, c.offer.id)).choices[19], choices[19]);
});

test('mapping draft: simultaneous saves and existing locks reject without automatic retry', async t => {
  const c = await reflectionV2Fixture(t, { size: 26 });
  const results = await Promise.allSettled([save(draftStore(c), c), save(draftStore(c), c)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(results.find(x => x.status === 'rejected').reason.status, 409);
  for (const dir of ['reflection-mapping-drafts', 'offer-imports', 'offers']) {
    await fs.mkdir(path.join(c.directory, dir, '.lock')); await assert.rejects(save(draftStore(c), c, 1), { status: 409 });
    assert.equal((await fs.stat(path.join(c.directory, dir, '.lock'))).isDirectory(), true); await fs.rmdir(path.join(c.directory, dir, '.lock'));
  }
});

for (const afterRename of [false, true]) test(`mapping draft: atomic failure ${afterRename ? 'after' : 'before'} rename never retries or rolls back`, async t => {
  const c = await reflectionV2Fixture(t, { size: 26 }); await save(draftStore(c), c);
  let calls = 0; const fileSystem = { ...fs, async rename(...args) { calls++; if (afterRename) await fs.rename(...args); throw new Error('fixture failure'); } };
  const choices = partial(c); choices[0] = targetChoice('candidate-1', 'membership');
  await assert.rejects(save(draftStore(c, { fileSystem }), c, 1, choices), { status: 503 }); assert.equal(calls, 1);
  const latest = await draftStore(c).get(c.draft.id, c.offer.id); assert.equal(latest.revision, afterRename ? 2 : 1); assert.equal(latest.choices[0].conversionIds[0], afterRename ? 'membership' : 'seminar');
});

test('mapping draft: backup v6 preserves drafts; old manifests remain readable; corrupt records stop maintenance', async t => {
  const c = await reflectionV2Fixture(t, { size: 26 }); const maintenance = createMaintenanceService(c.directory, { now: c.now });
  const old = await maintenance.create(); assert.equal(old.manifest.schemaVersion, 1); await save(draftStore(c), c);
  assert.equal((await maintenance.integrity()).status, 'normal');
  const backup = await maintenance.create(); assert.equal(backup.manifest.schemaVersion, 6); assert.equal(backup.manifest.contracts.reflectionMappingDraft, 1);
  assert.ok(backup.manifest.files.some(x => x.path.startsWith('reflection-mapping-drafts/'))); assert.equal((await maintenance.dryRun(backup.manifest.id)).backupValid, true); assert.equal((await maintenance.dryRun(old.manifest.id)).backupValid, true);
  const record = JSON.parse(await fs.readFile(recordPath(c), 'utf8')); record.revisions[0].choices[19].mode = 'offer';
  await fs.writeFile(recordPath(c), JSON.stringify(record)); assert.equal((await maintenance.integrity()).status, 'error'); await assert.rejects(maintenance.create(), { status: 503 });
});

test('mapping draft: editing or saving draft cannot resurrect stale approval after app restart', async t => {
  const c = await reflectionV2Fixture(t, { size: 26 }); const s = draftStore(c); await save(s, c, 0, c.options.choices);
  const expected = { ...mappingDraftBinding(c.draft, c.offer), draftRevision: 1 };
  const p = await c.service.preview(c.draft.id, c.options, expected);
  await save(s, c, 1, c.options.choices); await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
  const restarted = createReflectionService({ dataDirectory: c.directory, importStore: c.imports, offerStore: c.offers, now: c.now });
  await assert.rejects(restarted.commit(p.token, { approve: true }), { status: 409 }); assert.deepEqual((await c.audit.read()).events, []);
});

test('mapping draft: invalid HTTP policy has safe diagnostics, secret reasons do not save, and stale form remains stopped', async t => {
  const c = await reflectionV2Fixture(t, { size: 26, blockedDisclosure: true }); const h = await http(t, c);
  const choices = partial(c); choices[19] = { ...noneChoice('candidate-20'), mode: 'offer' };
  const response = await h.post(form(c, choices, 0)); assert.equal(response.status, 400); const html = await response.text(); assert.ok(html.includes('V2_SCALAR_USAGE_REQUIRED')); assert.ok(!html.includes('架空の効果非保証表示'));
  choices[19] = { ...blank('candidate-20'), reason: 'password=fixture-secret' }; assert.equal((await h.post(form(c, choices, 0))).status, 400);
  const f = form(c, partial(c), 0); f.set('importHash', '0'.repeat(64)); assert.equal((await h.post(f)).status, 409);
  assert.equal(await draftStore(c).get(c.draft.id, c.offer.id), null);
});

test('mapping draft: external communication attempts remain zero', () => assert.deepEqual(blockedConnections, []));


test('mapping draft: valid choice mutation at the same draft revision invalidates prior approval hash', async t => {
  const c = await reflectionV2Fixture(t, { size: 26 }); await save(draftStore(c), c, 0, c.options.choices);
  const p = await c.service.preview(c.draft.id, c.options, { ...mappingDraftBinding(c.draft, c.offer), draftRevision: 1 });
  const raw = JSON.parse(await fs.readFile(recordPath(c), 'utf8')); raw.revisions[0].choices[7].reason = '別の人間判断';
  await fs.writeFile(recordPath(c), JSON.stringify(raw));
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 }); assert.deepEqual((await c.audit.read()).events, []);
});

for (const version of [1, 2, 3, 4, 5]) test(`mapping draft: backup v6 retains AI execution contract ${version} without touching activation`, async t => {
  const c = await reflectionV2Fixture(t, { size: 26 });
  const dir = path.join(c.directory, 'extraction-executions'); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify({ schemaVersion: version, executions: [] })); await fs.writeFile(path.join(dir, 'initialized'), '1\n');
  const m = createMaintenanceService(c.directory, { now: c.now }); const old = await m.create();
  await save(draftStore(c), c); const report = await m.integrity(); assert.equal(report.status, old.report.status);
  const backup = await m.create(); assert.equal(backup.manifest.schemaVersion, 6); assert.equal(backup.manifest.contracts.extractionExecution, version);
  assert.equal((await m.dryRun(backup.manifest.id)).backupValid, true); assert.equal((await m.dryRun(old.manifest.id)).backupValid, true);
  await assert.rejects(fs.stat(path.join(c.directory, 'ai-budget', 'activation.json')), { code: 'ENOENT' });
});
