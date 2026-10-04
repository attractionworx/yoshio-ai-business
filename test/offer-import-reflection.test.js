import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createOfferStore } from '../lib/offers/store.js';
import { newOfferInput } from '../lib/offers/form.js';
import { createOfferImportStore } from '../lib/offer-import/store.js';
import { createCommitStore } from '../lib/offer-import/commit-store.js';
import { createReflectionService } from '../lib/offer-import/reflection-service.js';
import { projectReflection, offerBusiness } from '../lib/offer-import/projection.js';
import { regulationFixture, importTime } from './fixtures/regulation-import.js';
import { createApp } from '../server.js';
import { hashDocumentText } from '../lib/offer-import/validation.js';
import http from 'node:http';
import { checkCurrentOffer } from '../lib/current-offer-check.js';
import { offerInput } from './fixtures/plan-offer.js';

const action = (sourceChecked = true) => ({ decision: 'accepted', edited: null, sourceChecked, reason: '' });
async function setup(t, { checked = [1, 2, 3, 4, 5, 7, 8], offerWrapper, auditFileSystem, fixtureChange } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'yoshio-reflection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const now = () => new Date(importTime);
  const offers = createOfferStore(directory, { now });
  const offer = await offers.create({ ...newOfferInput(), name: '架空の反映先案件', asp: { code: 'fictional', programId: null },
    conversions: [{ id: 'existing-membership', name: '架空の月額入会', status: 'draft', reward: null, eligibility: [], approvalConditions: [], rejectionConditions: [], affiliateUrl: null, ctaLabel: null }] });
  const imports = createOfferImportStore(directory, { now });
  const fixture = regulationFixture(); if (fixtureChange) fixtureChange(fixture);
  let draft = await imports.create({ targetOffer: null, ...fixture });
  for (const index of checked) draft = await imports.review(draft.id, `candidate-${index + 1}`, draft.revision, action());
  const audit = createCommitStore(directory, auditFileSystem ? { fileSystem: auditFileSystem } : {});
  const service = createReflectionService({ dataDirectory: directory, importStore: imports,
    offerStore: offerWrapper ? offerWrapper(offers, imports, draft) : offers, auditStore: audit, now });
  const options = { offerId: offer.id, conversions: [{ key: 'membership', id: 'existing-membership' }] };
  return { directory, now, offers, imports, offer, draft, audit, service, options };
}

test('Step 4: preview details and exclusions are complete, GET-equivalent reads never save', async t => {
  const c = await setup(t);
  const before = await fs.readFile(path.join(c.directory, 'offers', `${c.offer.id}.json`), 'utf8');
  const p = await c.service.preview(c.draft.id, c.options);
  assert.equal(p.plan.offerRevision, 1); assert.equal(p.plan.nextRevision, 2);
  assert.ok(p.plan.mappings.some(m => m.candidateId === 'candidate-2' && m.field === 'facts'));
  assert.ok(p.plan.mappings.every(m => m.citations.length && m.sourceIds.length));
  assert.ok(p.plan.excluded.some(m => m.candidateId === 'candidate-1' && m.reason === '保留中'));
  assert.ok(p.plan.excluded.some(m => m.candidateId === 'candidate-9'));
  assert.ok(p.plan.changes.every(change => Object.hasOwn(change, 'before') && Object.hasOwn(change, 'after')));
  assert.equal(await fs.readFile(path.join(c.directory, 'offers', `${c.offer.id}.json`), 'utf8'), before);
  assert.deepEqual(await fs.readdir(c.directory), ['offer-imports', 'offers']);
});

test('Step 4: explicit approval creates one offer revision, preserves usage and audit citation mapping', async t => {
  const c = await setup(t);
  const prepared = await c.service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(prepared.token, { approve: false }), { status: 400 });
  const result = await c.service.commit(prepared.token, { approve: true });
  const saved = await c.offers.get(c.offer.id);
  assert.equal(saved.revision, 2); assert.equal(saved.status, 'draft');
  assert.deepEqual(offerBusiness(saved), prepared.plan.input);
  assert.equal(saved.facts[0].usage, 'internal_only');
  assert.ok(saved.prohibitedExpressions.every(s => s.usage === 'constraint_only'));
  assert.equal(saved.conversions[0].approvalConditions.length, 1);
  assert.ok(!saved.conversions[0].approvalConditions.some(s => s.text.includes('最終ゴール')));
  assert.equal(saved.conversions[0].reward, null);
  const records = await c.service.records(c.draft.id);
  assert.equal(records.states[0].state, 'committed');
  assert.equal(records.states[0].intent.id, result.commitId);
  assert.equal(records.states[0].intent.plan.importRevision, c.draft.revision);
  assert.equal(records.states[0].result.offerRevision, 2);
  assert.deepEqual(records.states[0].intent.plan.mappings, prepared.plan.mappings);
  assert.deepEqual(await c.imports.get(c.draft.id), c.draft);
  assert.deepEqual((await c.offers.history(c.offer.id))[0], c.offer);
});

test('Step 4: unchecked accepted, rejected and pending never reflect, no approval token without eligible candidates', async t => {
  const c = await setup(t, { checked: [] });
  let d = await c.imports.review(c.draft.id, 'candidate-2', 1, action(false));
  d = await c.imports.review(d.id, 'candidate-3', d.revision, { ...action(false), decision: 'rejected' });
  const p = await c.service.preview(d.id, c.options);
  assert.equal(p.token, ''); assert.deepEqual(p.plan.mappings, []);
  assert.ok(p.plan.excluded.some(x => x.reason.startsWith('未確認')));
  assert.ok(p.plan.excluded.some(x => x.reason === '却下済み'));
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
  assert.equal((await c.offers.get(c.offer.id)).revision, 1);
});

test('Step 4: public/internal/constraint usage remains separate', async t => {
  const c = await setup(t, { fixtureChange: f => { f.extraction.candidates[1].usage = 'publishable'; } });
  const p = await c.service.preview(c.draft.id, c.options);
  await c.service.commit(p.token, { approve: true });
  const o = await c.offers.get(c.offer.id);
  assert.equal(o.facts[0].usage, 'publishable');
  assert.equal(o.sellingPoints[0].usage, 'internal_only');
  assert.equal(o.prohibitedExpressions[0].usage, 'constraint_only');
});

test('Step 4: duplicate tokens and already-applied candidates cannot create another revision', async t => {
  const c = await setup(t); const p = await c.service.preview(c.draft.id, c.options);
  const other = await c.service.preview(c.draft.id, c.options);
  await c.service.commit(p.token, { approve: true });
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
  await assert.rejects(c.service.commit(other.token, { approve: true }), { status: 409 });
  const next = await c.service.preview(c.draft.id, c.options);
  assert.equal(next.token, ''); assert.ok(next.plan.excluded.some(x => x.reason.includes('反映済み')));
  assert.equal((await c.offers.get(c.offer.id)).revision, 2);
});

for (const namespace of ['source', 'statement']) test(`Step 4: ${namespace} ID collision stops preview without changing existing IDs`, async t => {
  const c = await setup(t);
  const input = offerBusiness(c.offer);
  if (namespace === 'source') input.sources.push({ id: `imp-${c.draft.id}-d1`, kind: 'asp_material', label: '既存資料', publicUrl: null, checkedAt: importTime });
  else input.facts.push({ id: `imp-${c.draft.id}-candidate-2`, category: 'other', text: '既存の別情報', origin: 'editor', sourceIds: [], verification: 'unverified', usage: 'internal_only' });
  await c.offers.update(c.offer.id, 1, input);
  await assert.rejects(c.service.preview(c.draft.id, c.options), { status: 409 });
  assert.equal((await c.offers.get(c.offer.id)).revision, 2);
});

for (const kind of ['offer', 'import']) test(`Step 4: ${kind} revision conflict rejects approval before intent and save`, async t => {
  const c = await setup(t); const p = await c.service.preview(c.draft.id, c.options);
  if (kind === 'offer') await c.offers.update(c.offer.id, 1, { ...offerBusiness(c.offer), name: '別の人による変更' });
  else await c.imports.review(c.draft.id, 'candidate-1', c.draft.revision, action(false));
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
  assert.deepEqual((await c.audit.read()).events, []);
});

test('Step 4: tampered token and preview input cannot change the authorized save', async t => {
  const c = await setup(t); const p = await c.service.preview(c.draft.id, c.options);
  const [body, signature] = p.token.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString()); decoded.previewHash = 'a'.repeat(64);
  const altered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
  await assert.rejects(c.service.commit(altered, { approve: true }), { status: 409 });
  p.plan.input.name = 'caller mutated preview';
  await c.service.commit(p.token, { approve: true });
  assert.equal((await c.offers.get(c.offer.id)).name, c.offer.name);
});

test('Step 4: import review is locked for the entire offer commit', async t => {
  let blocked = false;
  const c = await setup(t, { offerWrapper: (offers, imports, draft) => ({ ...offers, async update(...args) {
    try { await imports.review(draft.id, 'candidate-1', draft.revision, action(false)); } catch (e) { blocked = e.status === 409; }
    return offers.update(...args);
  } }) });
  const p = await c.service.preview(c.draft.id, c.options); await c.service.commit(p.token, { approve: true });
  assert.equal(blocked, true);
});

test('Step 4: offer write failure leaves durable intent, requires explicit not-applied recovery without retry', async t => {
  let calls = 0;
  const c = await setup(t, { offerWrapper: offers => ({ ...offers, async update() { calls++; throw new Error('password=sentinel'); } }) });
  const p = await c.service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), e => e.status === 503 && !e.message.includes('sentinel'));
  assert.equal((await c.offers.get(c.offer.id)).revision, 1);
  await assert.rejects(c.service.preview(c.draft.id, c.options), { status: 409 });
  const records = await c.service.records(c.draft.id);
  assert.equal(records.states[0].state, 'recovery_required'); assert.equal(records.recovery.outcome, 'not_applied');
  assert.equal(await c.service.recover(records.recovery.token, { approve: true }), 'not_applied');
  assert.equal(calls, 1); assert.equal((await c.offers.get(c.offer.id)).revision, 1);
});

test('Step 4: result-save failure after offer commit recovers exact saved revision without resaving', async t => {
  let saves = 0;
  const c = await setup(t, { auditFileSystem: { ...fs, async rename(...args) {
    saves++; if (saves === 2) throw new Error('password=sentinel'); return fs.rename(...args);
  } } });
  const p = await c.service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 503 });
  assert.equal((await c.offers.get(c.offer.id)).revision, 2);
  const records = await c.service.records(c.draft.id);
  assert.equal(records.recovery.outcome, 'committed');
  await c.service.recover(records.recovery.token, { approve: true });
  assert.equal((await c.offers.history(c.offer.id)).length, 2);
  assert.equal((await c.service.records(c.draft.id)).states[0].state, 'committed');
  await assert.rejects(c.service.recover(records.recovery.token, { approve: true }), { status: 409 });
});

test('Step 4: ambiguous result error after rename never overwrites a durable result', async t => {
  let saves = 0;
  const c = await setup(t, { auditFileSystem: { ...fs, async rename(...args) {
    saves++; await fs.rename(...args); if (saves === 2) throw new Error('failure after rename');
  } } });
  const p = await c.service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 503 });
  const records = await c.service.records(c.draft.id);
  assert.equal(records.states[0].state, 'committed'); assert.equal(records.recovery, null);
  assert.equal((await c.audit.read()).events.length, 2);
  assert.equal((await c.offers.get(c.offer.id)).revision, 2);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
});

test('Step 4: failure to save intent prevents any offer update and lost initialized ledger fails closed', async t => {
  const c = await setup(t, { auditFileSystem: { ...fs, async rename() { throw new Error('sentinel'); } } });
  const p = await c.service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 503 });
  assert.equal((await c.offers.get(c.offer.id)).revision, 1);
  await assert.rejects(c.service.preview(c.draft.id, c.options), { status: 503 });
});

test('Step 4: recovery cannot guess after conflicting saved revision', async t => {
  const c = await setup(t, { offerWrapper: offers => ({ ...offers, async update(id, revision, input) {
    await offers.update(id, revision, { ...input, name: '別の保存内容' }); throw new Error('interrupted');
  } }) });
  const p = await c.service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 503 });
  const records = await c.service.records(c.draft.id);
  assert.equal(records.recovery.outcome, null); assert.equal(records.recovery.token, '');
  await assert.rejects(c.service.preview(c.draft.id, c.options), { status: 409 });
});

test('Step 4: source reuse for different candidates is audited, existing source ID is preserved', async t => {
  const c = await setup(t, { checked: [1] });
  const p = await c.service.preview(c.draft.id, c.options); await c.service.commit(p.token, { approve: true });
  const source = (await c.offers.get(c.offer.id)).sources[0];
  const latest = await c.imports.get(c.draft.id);
  await c.imports.review(latest.id, 'candidate-3', latest.revision, action());
  const next = await c.service.preview(c.draft.id, c.options); await c.service.commit(next.token, { approve: true });
  assert.deepEqual((await c.offers.get(c.offer.id)).sources, [source]);
  assert.equal((await c.service.records(c.draft.id)).states.length, 2);
});

test('Step 4: checked scalar name change shows before/after and requires publishable usage', async t => {
  const c = await setup(t, { checked: [0], fixtureChange: f => { f.extraction.candidates[0].usage = 'publishable'; f.extraction.candidates[0].text = '架空の正式名称'; } });
  const p = await c.service.preview(c.draft.id, c.options);
  const change = p.plan.changes.find(x => x.field === 'name');
  assert.equal(change.before, c.offer.name); assert.equal(change.after, '架空の正式名称');
  await c.service.commit(p.token, { approve: true });
  assert.equal((await c.offers.get(c.offer.id)).name, '架空の正式名称');
});

test('Step 4: checked CTA/disclosure/conversion name replacements preserve disclosure policy and conversion ID', async t => {
  const c = await setup(t, { checked: [0, 1, 2], fixtureChange: f => {
    const text = '行動案内は「架空会員に登録する」です。広告表示は「広告：架空案件」です。成果地点の名称は「架空の紙工作会員登録」です。';
    const doc = f.documents[0]; Object.assign(doc, { text, textHash: hashDocumentText(text), blocks: [{ id: 'p1', start: 0, end: text.length }] });
    const evidence = [{ documentId: doc.id, blockId: 'p1', start: 0, end: text.length, quote: text }];
    f.extraction.candidates = [
      { target: 'ctaLabel', conversionKey: 'membership', category: 'other', text: '架空会員に登録する', usage: 'publishable', purpose: 'fact', evidence },
      { target: 'disclosure_text', conversionKey: null, category: 'other', text: '広告：架空案件', usage: 'publishable', purpose: 'fact', evidence },
      { target: 'conversion_name', conversionKey: 'membership', category: 'other', text: '架空の紙工作会員登録', usage: 'publishable', purpose: 'fact', evidence },
    ];
  } });
  const p = await c.service.preview(c.draft.id, c.options);
  await c.service.commit(p.token, { approve: true });
  const o = await c.offers.get(c.offer.id);
  assert.equal(o.conversions[0].id, 'existing-membership');
  assert.equal(o.conversions[0].name, '架空の紙工作会員登録');
  assert.equal(o.conversions[0].ctaLabel.text, '架空会員に登録する');
  assert.equal(o.disclosure.required, true); assert.deepEqual(o.disclosure.placements, c.offer.disclosure.placements);
  assert.equal(o.disclosure.text, '広告：架空案件');
});

test('Step 4: existing active validation rejects internal-only mandatory conditions without downgrading offer', async t => {
  const c = await setup(t); const active = await c.offers.create(offerInput());
  await assert.rejects(c.service.preview(c.draft.id, { offerId: active.id, conversions: [{ key: 'membership', id: 'consultation' }] }), { status: 400 });
  assert.deepEqual(await c.offers.get(active.id), active);
});

test('Step 4: unknown mapping fields or guessed conversion groups are rejected', async t => {
  const c = await setup(t);
  for (const options of [{ ...c.options, status: 'active' }, { offerId: c.offer.id, conversions: [{ key: 'password=sentinel', id: 'existing-membership' }] },
    { offerId: c.offer.id, conversions: [...c.options.conversions, ...c.options.conversions] }]) {
    assert.throws(() => projectReflection(c.draft, c.offer, options), { status: 400 });
  }
});

test('Step 4: expired confirmation and another service secret reject without writing', async t => {
  const c = await setup(t);
  let clock = new Date(importTime);
  const service = createReflectionService({ dataDirectory: c.directory, importStore: c.imports, offerStore: c.offers, auditStore: c.audit, now: () => clock });
  const p = await service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
  clock = new Date(clock.getTime() + 16 * 60_000);
  await assert.rejects(service.commit(p.token, { approve: true }), { status: 409 });
  assert.deepEqual((await c.audit.read()).events, []);
});

test('Step 4: full import snapshot change with unchanged revision invalidates old confirmation', async t => {
  const c = await setup(t); const p = await c.service.preview(c.draft.id, c.options);
  const file = path.join(c.directory, 'offer-imports', `${c.draft.id}.json`);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const revision of record.revisions) revision.candidates[6].original.text = '別の未採用候補';
  await fs.writeFile(file, JSON.stringify(record));
  assert.equal((await c.imports.get(c.draft.id)).revision, c.draft.revision);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
  assert.equal((await c.offers.get(c.offer.id)).revision, 1);
});

test('Step 4: concurrent confirmations across services permit only one formal commit', async t => {
  const c = await setup(t);
  const other = createReflectionService({ dataDirectory: c.directory, importStore: c.imports, offerStore: c.offers, now: c.now });
  const a = await c.service.preview(c.draft.id, c.options); const b = await other.preview(c.draft.id, c.options);
  const results = await Promise.allSettled([c.service.commit(a.token, { approve: true }), other.commit(b.token, { approve: true })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await c.offers.history(c.offer.id)).length, 2);
});

test('Step 4: unresolved intent survives restart and explicit recovery can match historical revision after later edit', async t => {
  let saves = 0;
  const c = await setup(t, { auditFileSystem: { ...fs, async rename(...args) { saves++; if (saves === 2) throw new Error('fixture failure'); return fs.rename(...args); } } });
  const p = await c.service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 503 });
  const saved = await c.offers.get(c.offer.id);
  await c.offers.update(saved.id, saved.revision, { ...offerBusiness(saved), name: '後から行った人間の編集' });
  const restarted = createReflectionService({ dataDirectory: c.directory, importStore: c.imports, offerStore: c.offers, now: c.now });
  await assert.rejects(restarted.preview(c.draft.id, c.options), { status: 409 });
  const records = await restarted.records(c.draft.id); assert.equal(records.recovery.outcome, 'committed');
  await restarted.recover(records.recovery.token, { approve: true });
  assert.equal((await c.offers.get(c.offer.id)).revision, 3);
  assert.equal((await c.offers.get(c.offer.id)).name, '後から行った人間の編集');
});

test('Step 4: corrupt audit or disappearing initialized ledger stops without resetting duplicate protection', async t => {
  const c = await setup(t); const p = await c.service.preview(c.draft.id, c.options);
  await c.service.commit(p.token, { approve: true });
  const file = path.join(c.directory, 'offer-import-commits', 'ledger.json');
  const before = await fs.readFile(file, 'utf8');
  const ledger = JSON.parse(before); ledger.events[0].plan.input.name = 'password=sentinel';
  await fs.writeFile(file, JSON.stringify(ledger));
  await assert.rejects(c.service.preview(c.draft.id, c.options), e => e.status === 503 && !e.message.includes('sentinel'));
  await fs.unlink(file);
  await assert.rejects(c.service.preview(c.draft.id, c.options), { status: 503 });
  assert.equal((await c.offers.get(c.offer.id)).revision, 2);
});

test('Step 4: explicit conversion mapping is required and mixed origins are excluded', async t => {
  const c = await setup(t);
  const p = await c.service.preview(c.draft.id, { offerId: c.offer.id, conversions: [] });
  assert.ok(p.plan.excluded.some(x => x.candidateId === 'candidate-5' && x.reason.includes('選択')));
  const draft = structuredClone(c.draft);
  const doc = { ...structuredClone(draft.documents[0]), id: 'another-document', kind: 'advertiser_material' };
  draft.documents.push(doc);
  // A fresh pending import can represent multi-origin evidence, but projection never picks an origin automatically.
  const fixture = regulationFixture(); fixture.documents.push(doc);
  fixture.extraction.candidates[1].evidence.push({ ...fixture.extraction.candidates[1].evidence[0], documentId: doc.id });
  let d = await c.imports.create({ targetOffer: null, ...fixture });
  d = await c.imports.review(d.id, 'candidate-2', d.revision, action());
  const mixed = await c.service.preview(d.id, { offerId: c.offer.id, conversions: [] });
  assert.equal(mixed.token, ''); assert.ok(mixed.plan.excluded.some(x => x.reason.includes('提供元')));
});

test('Step 4: active status is preserved and existing fixed article is blocked by revision mismatch', async t => {
  const c = await setup(t);
  const active = await c.offers.create(offerInput());
  const p = await c.service.preview(c.draft.id, { offerId: active.id, conversions: [] });
  await c.service.commit(p.token, { approve: true });
  assert.equal((await c.offers.get(active.id)).status, 'active');
  const check = await checkCurrentOffer({ affiliateContext: { offerId: active.id, offerRevision: active.revision, conversionId: 'consultation' } }, c.offers, new Date(importTime));
  assert.equal(check.result, 'blocked'); assert.equal(check.reasonCode, 'revision-mismatch');
});

test('Step 4: unrelated existing files remain byte-identical', async t => {
  const c = await setup(t);
  const files = ['unrelated-plan.json', 'drafts/unrelated.json', 'generations/ledger.json'];
  for (const file of files) { await fs.mkdir(path.dirname(path.join(c.directory, file)), { recursive: true }); await fs.writeFile(path.join(c.directory, file), 'untouched fixture'); }
  const p = await c.service.preview(c.draft.id, c.options); await c.service.commit(p.token, { approve: true });
  for (const file of files) assert.equal(await fs.readFile(path.join(c.directory, file), 'utf8'), 'untouched fixture');
});

async function web(t) {
  const c = await setup(t);
  const server = createApp({ dataDirectory: c.directory, offerImportOptions: { store: c.imports, reflection: c.service } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...c, base, route: `/offer-imports/${c.draft.id}`,
    get: url => fetch(base + url), post: (url, body, headers = { Origin: base }) => fetch(base + url, { method: 'POST', body, headers, redirect: 'manual' }) };
}

test('Step 4 HTTP: preview GET no writes, signed approval adds revision and audit page', async t => {
  const c = await web(t);
  const response = await c.get(`${c.route}/reflection?offerId=${c.offer.id}&conversion.0=existing-membership`);
  const html = await response.text(); assert.equal(response.status, 200);
  for (const word of ['対象offer ID', '追加・変更内容', '変更前', '変更後', '反映しない候補', 'source IDs', 'internal_only', 'constraint_only']) assert.ok(html.includes(word));
  assert.equal((await c.offers.get(c.offer.id)).revision, 1);
  const prepared = await c.service.preview(c.draft.id, c.options);
  assert.equal((await c.post(`${c.route}/commit`, new URLSearchParams({ token: prepared.token, confirm: 'yes' }))).status, 303);
  assert.match(await (await c.get(`${c.route}/commits`)).text(), /committed/);
  assert.equal((await c.offers.get(c.offer.id)).revision, 2);
});

test('Step 4 HTTP: Origin, Host, unknown/duplicate fields and unchecked approval blocked', async t => {
  const c = await web(t); const p = await c.service.preview(c.draft.id, c.options);
  const body = () => new URLSearchParams({ token: p.token, confirm: 'yes' });
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://example.test' }, { Origin: c.base, 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await c.post(`${c.route}/commit`, body(), headers)).status, 403);
  }
  for (const variant of [new URLSearchParams({ token: p.token }), new URLSearchParams({ token: p.token, confirm: 'yes', input: 'sentinel' }), new URLSearchParams([['token', p.token], ['confirm', 'yes'], ['confirm', 'yes']])]) {
    assert.equal((await c.post(`${c.route}/commit`, variant)).status, 400);
  }
  const status = await new Promise((resolve, reject) => { const request = http.get(c.base + c.route + '/reflection', { headers: { Host: 'example.test' } }, r => { r.resume(); resolve(r.statusCode); }); request.on('error', reject); });
  assert.equal(status, 403); assert.equal((await c.offers.get(c.offer.id)).revision, 1);
});

test('Step 4 HTTP: XSS is escaped and stale preview gives safe stop/rebuild links', async t => {
  const c = await web(t); const draft = await c.imports.get(c.draft.id);
  const edited = { ...draft.candidates[1].original, text: '<img src=x onerror="alert(1)">' };
  await c.imports.review(draft.id, 'candidate-2', draft.revision, { ...action(), edited });
  const p = await c.service.preview(c.draft.id, c.options);
  const html = await (await c.get(`${c.route}/reflection?offerId=${c.offer.id}`)).text();
  assert.ok(!html.includes(edited.text)); assert.match(html, /&lt;img/);
  await c.offers.update(c.offer.id, 1, offerBusiness(c.offer));
  const response = await c.post(`${c.route}/commit`, new URLSearchParams({ token: p.token, confirm: 'yes' }));
  assert.equal(response.status, 409); const failure = await response.text();
  assert.ok(!failure.includes('<form')); assert.match(failure, /プレビューを作り直す/);
});

test('Step 4 HTTP: recovery GET never finalizes and explicit approval records outcome without offer write', async t => {
  let failed = true;
  const c = await setup(t, { offerWrapper: offers => ({ ...offers, async update(...args) { if (failed) throw new Error('fixture failure'); return offers.update(...args); } }) });
  const server = createApp({ dataDirectory: c.directory, offerImportOptions: { store: c.imports, reflection: c.service } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, route = `/offer-imports/${c.draft.id}`;
  const p = await c.service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 503 });
  const html = await (await fetch(`${base}${route}/commits`)).text();
  assert.match(html, /recovery_required/); assert.match(html, /案件を再保存せず/);
  const recovery = (await c.service.records(c.draft.id)).recovery;
  const noApproval = await fetch(`${base}${route}/recover`, { method: 'POST', body: new URLSearchParams({ token: recovery.token }), headers: { Origin: base } });
  assert.equal(noApproval.status, 400);
  assert.equal((await c.service.records(c.draft.id)).states[0].state, 'recovery_required');
  failed = false;
  const result = await fetch(`${base}${route}/recover`, { method: 'POST', body: new URLSearchParams({ token: recovery.token, confirm: 'yes' }), headers: { Origin: base }, redirect: 'manual' });
  assert.equal(result.status, 303); assert.equal((await c.offers.get(c.offer.id)).revision, 1);
  assert.equal((await c.service.records(c.draft.id)).states[0].state, 'not_applied');
});
