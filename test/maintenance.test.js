import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { capture, hash, snapshotHash, limits } from '../lib/maintenance/snapshot.js';
import { inspectSnapshot } from '../lib/maintenance/integrity.js';
import { maintenancePages } from '../lib/maintenance/pages.js';
import { offerBusiness } from '../lib/offer-import/projection.js';
import { reviewCandidate } from '../lib/offer-import/contract.js';
import { regulationFixture } from './fixtures/regulation-import.js';
import { maintenanceFixture, storeBytes, checkedAction } from './fixtures/maintenance.js';

const archivePath = (c, backup) => path.join(c.root, 'maintenance-backups', backup.manifest.id);
async function mutateManifest(c, backup, edit, rehash = true) {
  const dir = archivePath(c, backup); const file = path.join(dir, 'manifest.json');
  const m = JSON.parse(await fs.readFile(file, 'utf8')); edit(m);
  const raw = JSON.stringify(m, null, 2) + '\n'; await fs.writeFile(file, raw);
  if (rehash) await fs.writeFile(path.join(dir, 'manifest.sha256'), hash(raw) + '\n');
}
async function editJson(filename, edit) { const v = JSON.parse(await fs.readFile(filename, 'utf8')); edit(v); await fs.writeFile(filename, JSON.stringify(v)); }

test('Step 5: consistent backup includes all three stores and complete histories with manifest and hashes', async t => {
  const c = await maintenanceFixture(t); const before = await storeBytes(c.root);
  const backup = await c.maintenance.create();
  assert.equal(backup.report.status, 'normal'); assert.equal(backup.manifest.schemaVersion, 1);
  assert.deepEqual(backup.manifest.contracts, { offer: 1, import: 1, commit: 1 });
  assert.equal(backup.manifest.files.length, 4);
  assert.deepEqual(backup.manifest.files.map(f => f.path).sort(), Object.keys(before).sort());
  for (const f of backup.manifest.files) assert.equal(hash(Buffer.from(before[f.path])), f.sha256);
  assert.deepEqual(await storeBytes(c.root), before);
  assert.equal((await c.maintenance.dryRun(backup.manifest.id)).status, 'normal');
});

test('Step 5: integrity is read-only, reports counts/capacity/time and does not change verification or offer status', async t => {
  const c = await maintenanceFixture(t); const before = await storeBytes(c.root);
  const report = await c.maintenance.integrity();
  assert.equal(report.status, 'normal'); assert.equal(report.recovery, 'normal');
  assert.equal(report.metrics.offerRevisions, 2); assert.equal(report.metrics.importRevisions, 2); assert.equal(report.metrics.commitEvents, 2);
  assert.ok(report.metrics.bytes > 0); assert.ok(report.metrics.inspectionMs >= 0);
  assert.deepEqual(await storeBytes(c.root), before); assert.equal((await c.offers.get(c.offer.id)).status, 'draft');
  assert.equal((await c.imports.get(c.draft.id)).candidates[0].review.verification, 'unverified');
});

test('Step 5: repeated dry-run creates no revision/history or restored record; no restore service exists', async t => {
  const c = await maintenanceFixture(t); const backup = await c.maintenance.create(); const before = await storeBytes(c.root);
  const backupBefore = await fs.readdir(archivePath(c, backup));
  for (let i = 0; i < 3; i++) { const r = await c.maintenance.dryRun(backup.manifest.id); assert.equal(r.restored, false); assert.equal(r.backupValid, true); }
  assert.equal(c.maintenance.restore, undefined); assert.deepEqual(Object.keys(c.maintenance).sort(), ['create', 'dryRun', 'integrity', 'list']);
  assert.deepEqual(await storeBytes(c.root), before); assert.deepEqual(await fs.readdir(archivePath(c, backup)), backupBefore);
});

for (const failure of ['payload', 'manifest', 'digest', 'rename']) test(`Step 5: partial ${failure} save failure never publishes a complete backup`, async t => {
  let failed = false;
  const fileSystem = { ...fs, async writeFile(filename, ...args) {
    const match = failure === 'payload' ? filename.includes('/payload/offers/') : failure === 'manifest' ? filename.endsWith('/manifest.json') : failure === 'digest' ? filename.endsWith('/manifest.sha256') : false;
    if (!failed && match) { failed = true; throw new Error('fixture write failure'); } return fs.writeFile(filename, ...args);
  }, async rename(from, to) { if (failure === 'rename' && from.includes('.incomplete-')) { failed = true; throw new Error('fixture rename failure'); } return fs.rename(from, to); } };
  const c = await maintenanceFixture(t, { fileSystem }); const before = await storeBytes(c.root);
  await assert.rejects(c.maintenance.create(), { status: 503 }); assert.equal(failed, true);
  const list = await c.maintenance.list(); assert.equal(list.backups.length, 0); assert.equal(list.incomplete, 1);
  assert.deepEqual(await storeBytes(c.root), before);
});

test('Step 5: source acquisition failure stops without publishing', async t => {
  const c = await maintenanceFixture(t);
  const service = createMaintenanceService(c.root, { fileSystem: { ...fs, async readFile(filename, ...args) {
    if (filename.endsWith('/ledger.json') && !filename.includes('/payload/')) throw new Error('fixture read error'); return fs.readFile(filename, ...args);
  } } });
  await assert.rejects(service.create(), { status: 503 }); assert.equal((await service.list()).backups.length, 0);
});

test('Step 5: corrupt/unknown-schema source data cannot be persisted into a complete backup', async t => {
  const c = await maintenanceFixture(t);
  await editJson(path.join(c.root, 'offers', c.offer.id + '.json'), record => { record.schemaVersion = 99; });
  const before = await storeBytes(c.root);
  await assert.rejects(c.maintenance.create(), { status: 503 });
  assert.equal((await c.maintenance.list()).backups.length, 0); assert.deepEqual(await storeBytes(c.root), before);
});

test('Step 5: known secret patterns in fictional corrupt source records are rejected before backup persistence', async t => {
  const c = await maintenanceFixture(t);
  await editJson(path.join(c.root, 'offers', c.offer.id + '.json'), r => { r.revisions[0].name = 'Cookie: fictional-fixture-only'; });
  const report = await c.maintenance.integrity(); assert.equal(report.status, 'error');
  assert.ok(!JSON.stringify(report).includes('fictional-fixture-only'));
  await assert.rejects(c.maintenance.create(), { status: 503 });
  assert.equal((await c.maintenance.list()).backups.length, 0);
});

test('Step 5: unrelated root files are outside capture and backup reads', async t => {
  const c = await maintenanceFixture(t); const ignored = path.join(c.root, 'private-fixture.txt');
  await fs.writeFile(ignored, 'fictional unrelated fixture');
  const service = createMaintenanceService(c.root, { now: c.now, fileSystem: { ...fs, async readFile(filename, ...args) {
    assert.notEqual(filename, ignored); return fs.readFile(filename, ...args);
  } } });
  assert.equal((await service.integrity()).status, 'normal'); const b = await service.create();
  assert.ok(!b.manifest.files.some(f => f.path.includes('private-fixture')));
});

test('Step 5: manifest tampering without digest update is rejected', async t => {
  const c = await maintenanceFixture(t); const b = await c.maintenance.create();
  await mutateManifest(c, b, m => { m.createdAt = '2020-01-01T00:00:00.000Z'; }, false);
  assert.equal((await c.maintenance.dryRun(b.manifest.id)).backupValid, false);
});

test('Step 5: payload hash mismatch is rejected without changing current data', async t => {
  const c = await maintenanceFixture(t); const b = await c.maintenance.create(); const before = await storeBytes(c.root);
  await fs.appendFile(path.join(archivePath(c, b), 'payload', b.manifest.files[0].path), ' ');
  const r = await c.maintenance.dryRun(b.manifest.id); assert.equal(r.backupValid, false); assert.equal(r.stopped, true);
  assert.deepEqual(await storeBytes(c.root), before);
});

for (const edit of [m => { m.schemaVersion = 2; }, m => { m.contracts.import = 2; }, m => { m.extra = true; }, m => { m.files.push(m.files[0]); }, m => { m.snapshotHash = '0'.repeat(64); }, m => { m.files[0].size = -1; }]) test('Step 5: unknown version/field, duplicate entry, aggregate digest or invalid size is rejected', async t => {
  const c = await maintenanceFixture(t); const b = await c.maintenance.create(); await mutateManifest(c, b, edit);
  assert.equal((await c.maintenance.dryRun(b.manifest.id)).backupValid, false);
});

test('Step 5: missing necessary backup file and extra payload file are both rejected', async t => {
  const c = await maintenanceFixture(t); const b = await c.maintenance.create();
  const f = path.join(archivePath(c, b), 'payload', b.manifest.files[0].path); await fs.unlink(f);
  assert.equal((await c.maintenance.dryRun(b.manifest.id)).backupValid, false);
  await fs.writeFile(f, 'unknown'); await fs.writeFile(path.join(archivePath(c, b), 'payload/offers/unknown.json'), '{}');
  assert.equal((await c.maintenance.dryRun(b.manifest.id)).backupValid, false);
});

test('Step 5: revision gap and corrupted history stop current integrity inspection', async t => {
  const c = await maintenanceFixture(t); const file = path.join(c.root, 'offers', c.offer.id + '.json');
  await editJson(file, r => { r.revisions.shift(); });
  let r = await c.maintenance.integrity(); assert.equal(r.status, 'error'); assert.ok(r.issues.some(i => i.code === 'offer_history_invalid'));
  await fs.writeFile(file, '{bad json'); r = await c.maintenance.integrity(); assert.equal(r.stopped, true);
});

test('Step 5: broken source reference and unknown source ID are errors, never repaired', async t => {
  const c = await maintenanceFixture(t); const file = path.join(c.root, 'offers', c.offer.id + '.json');
  await editJson(file, r => { r.revisions[1].facts[0].sourceIds = ['unknown-source']; });
  const before = await storeBytes(c.root); const r = await c.maintenance.integrity();
  assert.equal(r.status, 'error'); assert.deepEqual(await storeBytes(c.root), before);
});

test('Step 5: missing import revision referenced by commit stops inspection', async t => {
  const c = await maintenanceFixture(t); await editJson(path.join(c.root, 'offer-imports', c.draft.id + '.json'), r => { r.revisions.pop(); });
  const r = await c.maintenance.integrity(); assert.ok(r.issues.some(i => i.code === 'commit_import_mismatch')); assert.equal(r.stopped, true);
});

test('Step 5: target offer reference must resolve to an existing revision', async t => {
  const c = await maintenanceFixture(t, { committed: false }); await fs.unlink(path.join(c.root, 'offers', c.offer.id + '.json'));
  const r = await c.maintenance.integrity(); assert.ok(r.issues.some(i => i.code === 'target_offer_missing'));
});

test('Step 5: intent only is recoverable but requires human confirmation, including backup dry-run', async t => {
  const c = await maintenanceFixture(t, { committed: false, offerWrapper: offers => ({ ...offers, async update() { throw new Error('fixture failure'); } }) });
  await assert.rejects(c.reflection.commit((await c.reflection.preview(c.draft.id, c.options)).token, { approve: true }));
  const r = await c.maintenance.integrity(); assert.equal(r.status, 'human_review_required'); assert.equal(r.recovery, 'recoverable');
  assert.equal((await c.offers.get(c.offer.id)).revision, 1);
  const b = await c.maintenance.create(); const dry = await c.maintenance.dryRun(b.manifest.id); assert.equal(dry.stopped, true);
  assert.equal((await c.audit.read()).events.at(-1).type, 'recovery_required');
});

test('Step 5: offer saved but result missing is recoverable, and detection does not append result', async t => {
  const c = await maintenanceFixture(t); await editJson(path.join(c.root, 'offer-import-commits/ledger.json'), l => { l.events.pop(); });
  const before = await storeBytes(c.root); const r = await c.maintenance.integrity();
  assert.equal(r.recovery, 'recoverable'); assert.equal(r.status, 'human_review_required'); assert.deepEqual(await storeBytes(c.root), before);
});

test('Step 5: mismatching result/offer is error; unresolved mismatching offer is unjudgeable', async t => {
  const c = await maintenanceFixture(t); await editJson(path.join(c.root, 'offers', c.offer.id + '.json'), r => { r.revisions[1].name = '架空の別内容'; });
  let r = await c.maintenance.integrity(); assert.ok(r.issues.some(i => i.code === 'commit_result_mismatch'));
  await editJson(path.join(c.root, 'offer-import-commits/ledger.json'), l => { l.events.pop(); });
  r = await c.maintenance.integrity(); assert.equal(r.recovery, 'human_required'); assert.equal(r.stopped, true);
});

test('Step 5: unknown commit reference and missing initialized ledger are errors', async t => {
  const c = await maintenanceFixture(t); const file = path.join(c.root, 'offer-import-commits/ledger.json');
  const raw = await fs.readFile(file); await editJson(file, l => { l.events[1].commitId = randomUUID(); });
  assert.equal((await c.maintenance.integrity()).status, 'error');
  await fs.writeFile(file, raw); await fs.unlink(file); assert.equal((await c.maintenance.integrity()).status, 'error');
});

test('Step 5: completely missing audit directory cannot hide generated source provenance', async t => {
  const c = await maintenanceFixture(t); await fs.rm(path.join(c.root, 'offer-import-commits'), { recursive: true });
  const r = await c.maintenance.integrity(); assert.equal(r.status, 'human_review_required');
  assert.ok(r.issues.some(i => i.code === 'generated_provenance_missing'));
});

test('Step 5: a not-applied result contradicting an already present matching offer stops for human review', async t => {
  const c = await maintenanceFixture(t);
  await editJson(path.join(c.root, 'offer-import-commits/ledger.json'), l => Object.assign(l.events[1], { outcome: 'not_applied', mode: 'recovery', offerRevision: 1 }));
  const r = await c.maintenance.integrity(); assert.equal(r.status, 'human_review_required');
  assert.ok(r.issues.some(i => i.code === 'not_applied_ambiguous'));
});

test('Step 5: old backup validates separately but warns that current data differs; dry-run never rolls back', async t => {
  const c = await maintenanceFixture(t); const b = await c.maintenance.create(); const latest = await c.offers.get(c.offer.id);
  await c.offers.update(latest.id, latest.revision, { ...offerBusiness(latest), name: '架空の更新後' });
  const before = await storeBytes(c.root); const r = await c.maintenance.dryRun(b.manifest.id);
  assert.equal(r.backupValid, true); assert.equal(r.status, 'warning'); assert.equal(r.stopped, true); assert.equal(r.warnings[0].code, 'different_current_data');
  assert.deepEqual(await storeBytes(c.root), before);
});

test('Step 5: future backup date is an explicit warning', async t => {
  const c = await maintenanceFixture(t); const b = await c.maintenance.create(); await mutateManifest(c, b, m => { m.createdAt = '2099-01-01T00:00:00.000Z'; });
  const r = await c.maintenance.dryRun(b.manifest.id); assert.ok(r.warnings.some(w => w.code === 'future_backup'));
});

test('Step 5: path traversal in backup ID or manifest path is rejected before arbitrary file reads', async t => {
  const c = await maintenanceFixture(t); await assert.rejects(c.maintenance.dryRun('../offers'), { status: 400 });
  const b = await c.maintenance.create(); await mutateManifest(c, b, m => { m.files[0].path = '../../.env'; });
  assert.equal((await c.maintenance.dryRun(b.manifest.id)).backupValid, false);
});

test('Step 5: symlink source, backup payload and backup root are rejected', async t => {
  const c = await maintenanceFixture(t); const b = await c.maintenance.create();
  const payloadFile = path.join(archivePath(c, b), 'payload', 'offers', c.offer.id + '.json'); await fs.unlink(payloadFile);
  await fs.symlink(path.join(c.root, 'offers', c.offer.id + '.json'), payloadFile);
  assert.equal((await c.maintenance.dryRun(b.manifest.id)).backupValid, false);
  const source = path.join(c.root, 'offers', c.offer.id + '.json'); await fs.rename(source, source + '.keep'); await fs.symlink(source + '.keep', source);
  assert.equal((await c.maintenance.integrity()).stopped, true); await assert.rejects(c.maintenance.create());
  const backupRoot = path.join(c.root, 'maintenance-backups'); const moved = backupRoot + '-fixture-target';
  await fs.rename(backupRoot, moved); await fs.symlink(moved, backupRoot);
  await assert.rejects(c.maintenance.list(), { status: 503 });
});

test('Step 5: unknown/temp store files stop backup and are never read or silently deleted', async t => {
  const c = await maintenanceFixture(t); const temp = path.join(c.root, 'offers', 'fixture.tmp'); await fs.writeFile(temp, 'fictional incomplete content');
  const r = await c.maintenance.integrity(); assert.equal(r.status, 'human_review_required');
  await assert.rejects(c.maintenance.create(), { status: 503 }); assert.equal(await fs.readFile(temp, 'utf8'), 'fictional incomplete content');
});

test('Step 5: existing write locks stop reads and backups; locks are not removed by inspection', async t => {
  const c = await maintenanceFixture(t); const lock = path.join(c.root, 'offer-imports/.lock'); await fs.mkdir(lock);
  const r = await c.maintenance.integrity(); assert.equal(r.issues[0].code, 'snapshot_busy');
  await assert.rejects(c.maintenance.create(), { status: 409 }); assert.ok((await fs.stat(lock)).isDirectory());
  assert.equal((await fs.readdir(path.join(c.root, 'offer-import-commits'))).includes('.lock'), false);
});

test('Step 5: unavailable current snapshot is explicitly unjudgeable, not falsely classified as older data', async t => {
  const c = await maintenanceFixture(t); const b = await c.maintenance.create();
  await fs.mkdir(path.join(c.root, 'offers/.lock'));
  const r = await c.maintenance.dryRun(b.manifest.id);
  assert.equal(r.backupValid, true); assert.equal(r.stopped, true); assert.equal(r.current.snapshotHash, null);
  assert.ok(r.warnings.some(w => w.code === 'current_unreadable')); assert.ok(!r.warnings.some(w => w.code === 'different_current_data'));
});

test('Step 5: concurrent backups are serialized by rejection and existing offer writers cannot interleave', async t => {
  const c = await maintenanceFixture(t); let unblock; let entered;
  const gate = new Promise(resolve => { unblock = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const service = createMaintenanceService(c.root, { fileSystem: { ...fs, async writeFile(filename, ...args) {
    if (filename.includes('/payload/offers/')) { entered(); await gate; } return fs.writeFile(filename, ...args);
  } } });
  const first = service.create(); await started;
  await assert.rejects(c.maintenance.create(), { status: 409 });
  const latest = await c.offers.get(c.offer.id); await assert.rejects(c.offers.update(latest.id, latest.revision, offerBusiness(latest)), { status: 409 });
  await assert.rejects(c.imports.review(c.draft.id, 'candidate-2', c.draft.revision, checkedAction), { status: 409 });
  unblock(); await first; assert.equal((await c.maintenance.list()).backups.length, 1); assert.equal((await c.maintenance.integrity()).status, 'normal');
});

test('Step 5: read-only snapshot detects state changing between captures', async t => {
  const c = await maintenanceFixture(t); let reads = 0;
  const fileSystem = { ...fs, async readFile(filename, ...args) {
    const data = await fs.readFile(filename, ...args);
    if (filename.endsWith(c.offer.id + '.json') && ++reads === 2) return Buffer.concat([data, Buffer.from(' ')]);
    return data;
  } };
  await assert.rejects(capture(c.root, { fileSystem }), { status: 409 });
});

test('Step 5: empty absent stores can be inspected without creating store directories', async t => {
  const c = await maintenanceFixture(t, { committed: false });
  const empty = path.join(c.root, 'empty'); const service = createMaintenanceService(empty);
  assert.equal((await service.integrity()).status, 'normal'); await assert.rejects(fs.stat(empty), { code: 'ENOENT' });
  const b = await service.create(); assert.equal(b.manifest.files.length, 0); assert.equal((await service.dryRun(b.manifest.id)).status, 'normal');
  assert.deepEqual(await fs.readdir(empty), ['maintenance-backups']);
});

test('Step 5: excessive file size is stopped before reading, never compacted', async t => {
  const c = await maintenanceFixture(t); let readLarge = false;
  const service = createMaintenanceService(c.root, { fileSystem: { ...fs, async lstat(filename) {
    const s = await fs.lstat(filename); if (filename.endsWith(c.offer.id + '.json')) Object.defineProperty(s, 'size', { value: limits.fileBytes + 1 }); return s;
  }, async readFile(filename, ...args) { if (filename.endsWith(c.offer.id + '.json')) readLarge = true; return fs.readFile(filename, ...args); } } });
  assert.equal((await service.integrity()).stopped, true); assert.equal(readLarge, false);
});

test('Step 5: restart inspects unresolved intent and immutable backup with no secret/token dependencies', async t => {
  const c = await maintenanceFixture(t); await editJson(path.join(c.root, 'offer-import-commits/ledger.json'), l => { l.events.pop(); });
  const b = await c.maintenance.create(); const restarted = createMaintenanceService(c.root, { now: c.now });
  assert.equal((await restarted.integrity()).recovery, 'recoverable'); assert.equal((await restarted.dryRun(b.manifest.id)).stopped, true);
  assert.equal((await c.audit.read()).events.length, 1);
});

test('Step 5: long offer/import/commit histories expose size and time without deleting or combining records', async t => {
  const c = await maintenanceFixture(t);
  for (let i = 0; i < 20; i++) {
    let d = await c.imports.create({ targetOffer: null, ...regulationFixture() });
    d = await c.imports.review(d.id, 'candidate-2', d.revision, checkedAction);
    await c.reflection.commit((await c.reflection.preview(d.id, c.options)).token, { approve: true });
  }
  const offerFile = path.join(c.root, 'offers', c.offer.id + '.json');
  await editJson(offerFile, record => { while (record.revisions.length < 500) record.revisions.push({ ...structuredClone(record.revisions.at(-1)), revision: record.revisions.length + 1 }); });
  const importFile = path.join(c.root, 'offer-imports', c.draft.id + '.json');
  await editJson(importFile, record => { while (record.revisions.length < 150) record.revisions.push(reviewCandidate(record.revisions.at(-1), 'candidate-2', record.revisions.length,
    { ...checkedAction, at: c.now().toISOString() })); });
  const before = await storeBytes(c.root); const r = await c.maintenance.integrity();
  assert.equal(r.status, 'normal'); assert.equal(r.metrics.offerRevisions, 500); assert.equal(r.metrics.importRevisions, 190); assert.equal(r.metrics.commitEvents, 42);
  assert.ok(r.metrics.bytes > 1000000); assert.ok(r.metrics.inspectionMs < 30000);
  const b = await c.maintenance.create(); assert.equal((await c.maintenance.dryRun(b.manifest.id)).backupValid, true);
  assert.deepEqual(await storeBytes(c.root), before);
  t.diagnostic(`long-history metrics: ${JSON.stringify(r.metrics)}`);
});

test('Step 5: report UI escapes XSS text, file names and backup IDs', () => {
  const e = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pages = maintenancePages(e); const attack = '<img src=x onerror=alert(1)>';
  for (const html of [pages.home({ backups: [{ id: attack }], incomplete: 0 }), pages.integrity({ status: 'error', recovery: 'human_required', issues: [{ status: 'error', message: attack, file: attack }] })]) {
    assert.ok(!html.includes(attack)); assert.ok(html.includes('&lt;img'));
  }
});

async function app(t, c) {
  const server = createApp({ dataDirectory: c.root, maintenanceOptions: { now: c.now } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, values, headers = {}) => fetch(base + route, { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(values) });
  return { base, post };
}

test('Step 5: HTTP admin, integrity, explicit backup and repeated dry-run leave source histories unchanged', async t => {
  const c = await maintenanceFixture(t); const { base, post } = await app(t, c); const before = await storeBytes(c.root);
  assert.equal((await fetch(base + '/maintenance')).status, 200);
  assert.equal((await fetch(base + '/maintenance/integrity')).status, 200);
  assert.equal((await fetch(base + '/maintenance/backups')).status, 404);
  assert.equal((await post('/maintenance/backups', { confirm: 'yes' })).status, 200);
  const b = (await c.maintenance.list()).backups[0];
  for (let i = 0; i < 2; i++) {
    const r = await post('/maintenance/dry-run', { backupId: b.id }); assert.equal(r.status, 200);
    assert.match(await r.text(), /現在のデータは変更しません/);
  }
  for (const route of ['/maintenance/restore', '/maintenance/backups/' + b.id + '/restore']) assert.equal((await post(route, { confirm: 'yes', backupId: b.id })).status, 404);
  assert.deepEqual(await storeBytes(c.root), before);
});

test('Step 5: HTTP Origin, missing Origin, cross-site, unknown/duplicate fields and traversal are refused', async t => {
  const c = await maintenanceFixture(t); const { base, post } = await app(t, c);
  assert.equal((await post('/maintenance/backups', { confirm: 'yes' }, { origin: 'http://invalid.example' })).status, 403);
  assert.equal((await fetch(base + '/maintenance/backups', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' })).status, 403);
  assert.equal((await post('/maintenance/backups', { confirm: 'yes' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post('/maintenance/backups', { confirm: 'yes', sourceChecked: 'true' })).status, 400);
  assert.equal((await post('/maintenance/backups', [['confirm', 'yes'], ['confirm', 'yes']])).status, 400);
  assert.equal((await post('/maintenance/backups', { confirm: 'no' })).status, 400);
  assert.equal((await post('/maintenance/dry-run', { backupId: '../../.env' })).status, 400);
  assert.equal((await fetch(base + '/maintenance?path=../../.env')).status, 400);
  assert.equal((await c.maintenance.list()).backups.length, 0);
});

test('Step 5: localhost constraint and CSP remain in effect; stopped page never echoes submitted XSS', async t => {
  const c = await maintenanceFixture(t); const { base, post } = await app(t, c);
  const rejected = await new Promise((resolve, reject) => {
    const req = http.get(base + '/maintenance', { headers: { host: 'invalid.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
  }); assert.equal(rejected, 403);
  const r = await post('/maintenance/dry-run', { backupId: '<script>alert(1)</script>' });
  assert.equal(r.status, 400); assert.ok(!((await r.text()).includes('<script>alert(1)</script>')));
  assert.match(r.headers.get('content-security-policy'), /form-action 'self'/);
});
