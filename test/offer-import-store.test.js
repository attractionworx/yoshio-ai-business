import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createOfferImportStore } from '../lib/offer-import/store.js';
import { approvedCandidatePreview } from '../lib/offer-import/contract.js';
import { regulationFixture, importTime } from './fixtures/regulation-import.js';

const id = '20000000-0000-4000-8000-000000000001';
const input = () => ({ targetOffer: null, ...regulationFixture() });
const action = overrides => ({ decision: 'accepted', edited: null, sourceChecked: false, reason: '', ...overrides });
async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'yoshio-import-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = { now: () => new Date(importTime), ...overrides };
  return { directory, settings, store: createOfferImportStore(directory, settings), file: path.join(directory, 'offer-imports', `${id}.json`) };
}

test('Step 2: isolated create/review/history/restart, pending initial state and detached returns', async t => {
  const c = await setup(t);
  const payload = input();
  const first = await c.store.create(payload, { id });
  payload.documents[0].label = 'caller changed';
  assert.equal(first.revision, 1);
  assert.equal(first.candidates[1].review.verification, 'unverified');
  const accepted = await c.store.review(id, 'candidate-2', 1, action());
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.candidates[1].review.verification, 'unverified');
  await c.store.review(id, 'candidate-2', 2, action({ sourceChecked: true }));
  const edited = { ...structuredClone(first.candidates[1].original), text: '料金は月額1,000円（税込1,100円）。' };
  await c.store.review(id, 'candidate-2', 3, action({ edited }));
  await c.store.review(id, 'candidate-2', 4, action({ decision: 'rejected', reason: '再確認' }));
  const restarted = createOfferImportStore(c.directory, c.settings);
  const history = await restarted.history(id);
  assert.deepEqual(history.map(d => d.revision), [1, 2, 3, 4, 5]);
  assert.equal(history[2].candidates[1].review.verification, 'source_checked');
  assert.equal(history[3].candidates[1].review.verification, 'unverified');
  assert.deepEqual(history[3].candidates[1].original, first.candidates[1].original);
  assert.deepEqual(approvedCandidatePreview(history.at(-1)), []);
  history[0].documents[0].label = 'modified return';
  assert.notEqual((await restarted.get(id)).documents[0].label, 'modified return');
  assert.equal((await fs.stat(c.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(c.file))).mode & 0o777, 0o700);
});

test('Step 2: list/get/history are read-only including empty store', async t => {
  const c = await setup(t);
  assert.deepEqual(await c.store.list(), []);
  await assert.rejects(c.store.get(id), { status: 404 });
  assert.deepEqual(await fs.readdir(c.directory), []);
  await c.store.create(input(), { id });
  const before = await fs.readFile(c.file, 'utf8');
  assert.equal((await c.store.list())[0].id, id);
  await c.store.get(id); await c.store.history(id);
  assert.equal(await fs.readFile(c.file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.dirname(c.file)), [`${id}.json`]);
});

test('Step 2: no offer/plan/draft/publication or generation files changed or created', async t => {
  const c = await setup(t);
  const sentinels = ['offers/existing.json', 'drafts/existing.json', 'generations/ledger.json', 'plan.json'];
  for (const name of sentinels) {
    await fs.mkdir(path.dirname(path.join(c.directory, name)), { recursive: true });
    await fs.writeFile(path.join(c.directory, name), 'untouched fixture');
  }
  await c.store.create(input(), { id });
  await c.store.review(id, 'candidate-2', 1, action({ sourceChecked: true }));
  for (const name of sentinels) assert.equal(await fs.readFile(path.join(c.directory, name), 'utf8'), 'untouched fixture');
  assert.deepEqual((await fs.readdir(c.directory)).sort(), ['drafts', 'generations', 'offer-imports', 'offers', 'plan.json']);
  assert.equal(Object.hasOwn(c.store, 'update'), false);
  assert.equal(Object.hasOwn(c.store, 'delete'), false);
});

test('Step 2: duplicate creation/stale revision cannot overwrite history', async t => {
  const c = await setup(t);
  await c.store.create(input(), { id });
  await assert.rejects(c.store.create(input(), { id }), { status: 409 });
  await c.store.review(id, 'candidate-2', 1, action());
  const before = await fs.readFile(c.file, 'utf8');
  await assert.rejects(c.store.review(id, 'candidate-2', 1, action()), { status: 409 });
  assert.equal(await fs.readFile(c.file, 'utf8'), before);
});

test('Step 2: concurrent reviews within one store and across stores allow only one write', async t => {
  for (const crossStore of [false, true]) {
    const c = await setup(t);
    await c.store.create(input(), { id });
    const other = crossStore ? createOfferImportStore(c.directory, c.settings) : c.store;
    const results = await Promise.allSettled([
      c.store.review(id, 'candidate-2', 1, action()), other.review(id, 'candidate-3', 1, action()),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    assert.equal((await c.store.get(id)).revision, 2);
  }
});

test('Step 2: residual lock rejects writes but permits read, never clears lock', async t => {
  const c = await setup(t);
  await c.store.create(input(), { id });
  const lock = path.join(path.dirname(c.file), '.lock');
  await fs.mkdir(lock);
  const before = await fs.readFile(c.file, 'utf8');
  await assert.rejects(c.store.review(id, 'candidate-2', 1, action()), { status: 409 });
  assert.equal((await c.store.get(id)).revision, 1);
  assert.equal(await fs.readFile(c.file, 'utf8'), before);
  assert.ok((await fs.stat(lock)).isDirectory());
});

test('Step 2: secret create is rejected before filesystem changes; bad review never persists', async t => {
  const c = await setup(t);
  const bad = input(); bad.documents[0].label = 'password=sentinel';
  await assert.rejects(c.store.create(bad, { id }), e => e.status === 400 && !e.message.includes('sentinel'));
  assert.deepEqual(await fs.readdir(c.directory), []);
  await c.store.create(input(), { id });
  const before = await fs.readFile(c.file, 'utf8');
  for (const badAction of [action({ reason: 'Cookie: sentinel' }), action({ at: importTime }),
    action({ status: 'active' }), action({ decision: 'rejected', sourceChecked: true })]) {
    await assert.rejects(c.store.review(id, 'candidate-2', 1, badAction), e => e.status === 400 && !e.message.includes('sentinel'));
  }
  assert.equal(await fs.readFile(c.file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.dirname(c.file)), [`${id}.json`]);
});

test('Step 2: caller cannot create reviewed draft or control system metadata', async t => {
  const c = await setup(t);
  for (const key of ['id', 'revision', 'createdAt', 'updatedAt', 'candidates', 'status']) {
    await assert.rejects(c.store.create({ ...input(), [key]: 'sentinel' }, { id }), { status: 400 });
  }
  await assert.rejects(c.store.create(input(), { id: '../sentinel' }), { status: 400 });
  await assert.rejects(c.store.create(input(), { id, revision: 2 }), { status: 400 });
  assert.deepEqual(await fs.readdir(c.directory), []);
});

const corruptions = [
  ['broken JSON', () => '{password=sentinel'],
  ['unknown envelope', r => { r.extra = 'sentinel'; return JSON.stringify(r); }],
  ['missing first revision', r => { r.revisions.shift(); return JSON.stringify(r); }],
  ['changed document metadata', r => { r.revisions[1].documents[0].label = 'changed'; return JSON.stringify(r); }],
  ['changed original candidate', r => { r.revisions[1].candidates[0].original.text = 'changed'; return JSON.stringify(r); }],
  ['changed target offer', r => { r.revisions[1].targetOffer = { id, revision: 1 }; return JSON.stringify(r); }],
  ['secret in historical review', r => { r.revisions[0].candidates[0].review.reason = 'password=sentinel'; return JSON.stringify(r); }],
  ['invalid revision chain', r => { r.revisions[1].revision = 3; return JSON.stringify(r); }],
];
for (const [name, corrupt] of corruptions) test(`Step 2 fails closed without overwriting: ${name}`, async t => {
  const c = await setup(t);
  await c.store.create(input(), { id });
  await c.store.review(id, 'candidate-2', 1, action());
  const raw = corrupt(JSON.parse(await fs.readFile(c.file, 'utf8')));
  await fs.writeFile(c.file, raw);
  for (const operation of [() => c.store.get(id), () => c.store.list(), () => c.store.history(id),
    () => c.store.review(id, 'candidate-2', 2, action()), () => c.store.create(input(), { id })]) {
    await assert.rejects(operation(), e => e.status === 503 && !e.message.includes('sentinel'));
  }
  assert.equal(await fs.readFile(c.file, 'utf8'), raw);
});

for (const stage of ['writeFile', 'rename']) test(`Step 2 atomic save failure at ${stage} keeps previous bytes and permits explicit retry`, async t => {
  let fail = false;
  const fileSystem = { ...fs, async [stage](...args) {
    if (fail) throw new Error('password=sentinel');
    return fs[stage](...args);
  } };
  const c = await setup(t, { fileSystem });
  await c.store.create(input(), { id });
  const before = await fs.readFile(c.file, 'utf8');
  fail = true;
  await assert.rejects(c.store.review(id, 'candidate-2', 1, action()), e => e.status === 503 && !e.message.includes('sentinel'));
  assert.equal(await fs.readFile(c.file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.dirname(c.file)), [`${id}.json`]);
  fail = false;
  assert.equal((await c.store.review(id, 'candidate-2', 1, action())).revision, 2);
});

test('Step 2: leftover temp file is ignored on restart, never promoted or deleted by reads', async t => {
  const c = await setup(t);
  await c.store.create(input(), { id });
  const temp = path.join(path.dirname(c.file), 'interrupted.tmp');
  await fs.writeFile(temp, 'incomplete fixture');
  const restarted = createOfferImportStore(c.directory, c.settings);
  assert.equal((await restarted.list()).length, 1);
  assert.equal((await restarted.get(id)).revision, 1);
  assert.equal(await fs.readFile(temp, 'utf8'), 'incomplete fixture');
});

test('Step 2: identical review and return to pending remain valid history', async t => {
  const c = await setup(t);
  await c.store.create(input(), { id });
  await c.store.review(id, 'candidate-2', 1, action());
  await c.store.review(id, 'candidate-2', 2, action());
  await c.store.review(id, 'candidate-2', 3, action({ decision: 'pending' }));
  assert.equal((await c.store.history(id)).length, 4);
  assert.equal((await c.store.get(id)).candidates[1].review.confirmedHash, null);
});

test('Step 2: backwards clock rejects review without modifying history', async t => {
  let clock = importTime;
  const c = await setup(t, { now: () => new Date(clock) });
  await c.store.create(input(), { id });
  clock = '2026-10-03T00:00:00Z';
  await assert.rejects(c.store.review(id, 'candidate-2', 1, action()), { status: 400 });
  assert.equal((await c.store.get(id)).revision, 1);
});

test('Step 2: symlink record is rejected without reading or overwriting its target', async t => {
  const c = await setup(t);
  await fs.mkdir(path.dirname(c.file));
  const target = path.join(c.directory, 'protected-fixture');
  await fs.writeFile(target, 'untouched');
  await fs.symlink(target, c.file);
  await assert.rejects(c.store.get(id), { status: 503 });
  await assert.rejects(c.store.create(input(), { id }), { status: 503 });
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
});

test('Step 2: multiple candidate changes cannot masquerade as one review revision', async t => {
  const c = await setup(t);
  await c.store.create(input(), { id });
  await c.store.review(id, 'candidate-2', 1, action());
  await c.store.review(id, 'candidate-3', 2, action());
  const record = JSON.parse(await fs.readFile(c.file, 'utf8'));
  record.revisions.splice(1, 1);
  record.revisions[1].revision = 2;
  await fs.writeFile(c.file, JSON.stringify(record));
  await assert.rejects(c.store.get(id), { status: 503 });
});

test('Step 2: symlink directory is rejected by reads and writes', async t => {
  const c = await setup(t);
  const target = await fs.mkdtemp(path.join(tmpdir(), 'yoshio-import-link-'));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  await fs.symlink(target, path.dirname(c.file));
  await assert.rejects(c.store.list(), { status: 503 });
  await assert.rejects(c.store.get(id), { status: 503 });
  await assert.rejects(c.store.create(input(), { id }), { status: 503 });
  assert.deepEqual(await fs.readdir(target), []);
});
