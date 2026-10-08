import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server.js';
import { reflectionV2Fixture, reflectionV2Form, targetChoice, noneChoice, checkedReview } from './fixtures/reflection-v2.js';
import { projectReflectionV2, reflectionStatementId } from '../lib/offer-import/projection-v2.js';
import { projectReflection, reflectionHash, offerBusiness } from '../lib/offer-import/projection.js';
import { createCommitStore } from '../lib/offer-import/commit-store.js';
import { createReflectionService } from '../lib/offer-import/reflection-service.js';
import { createMaintenanceService } from '../lib/maintenance/backup.js';
import { reviewContentHash } from '../lib/offer-import/validation.js';
import { reflectionV2Eligibility, reflectionV2Diagnostic, v2ValidationError } from '../lib/offer-import/reflection-v2-policy.js';
import { reflectionV2Pages } from '../lib/offer-import/reflection-v2-pages.js';
import { blockedConnections } from './helpers/network-guard.js';

const change = (options, index, patch) => { const copy = structuredClone(options); Object.assign(copy.choices[index], patch); return copy; };
const bytes = c => fs.readFile(path.join(c.directory, 'offers', c.offer.id + '.json'), 'utf8');

test('reflection v2: per-candidate and explicit common conditions retain provenance and none reasons without changing review', async t => {
  const c = await reflectionV2Fixture(t); const before = await bytes(c);
  const p = await c.service.preview(c.draft.id, c.options);
  assert.equal(await bytes(c), before); assert.equal(p.plan.schemaVersion, 2);
  assert.equal(p.plan.mappings.length, 8); assert.equal(p.plan.decisions.length, 9);
  assert.equal(p.plan.excluded.find(x => x.candidateId === 'candidate-8').reason, c.options.choices[7].reason);
  assert.equal(p.plan.input.conversions[0].eligibility.length, 1); assert.equal(p.plan.input.conversions[1].eligibility.length, 1);
  assert.equal(p.plan.input.conversions[0].rejectionConditions.length, 1); assert.equal(p.plan.input.conversions[1].rejectionConditions.length, 1);
  assert.notEqual(p.plan.input.conversions[0].eligibility[0].id, p.plan.input.conversions[1].eligibility[0].id);
  assert.ok(p.plan.mappings.every(m => m.citations.length && m.sourceIds.length && m.conversionId));
  assert.equal(p.plan.input.status, 'draft'); assert.ok(p.plan.input.conversions.every(x => x.status === 'draft' && x.reward === null && x.affiliateUrl === null));
  await c.service.commit(p.token, { approve: true });
  assert.deepEqual(await c.imports.get(c.draft.id), c.draft);
  assert.deepEqual(offerBusiness(await c.offers.get(c.offer.id)), p.plan.input);
  assert.equal((await createCommitStore(c.directory).read()).events[0].plan.schemaVersion, 2);
});

for (const [label, index, patch] of [
  ['multiple names', 0, { conversionIds: ['seminar', 'membership'], commonConfirmed: true }],
  ['nonexistent target', 0, { conversionIds: ['missing'] }],
  ['duplicate target', 2, { conversionIds: ['seminar', 'seminar'] }],
  ['missing common confirmation', 2, { commonConfirmed: false }],
  ['none without reason', 5, { reason: '' }],
  ['none with target', 5, { conversionIds: ['seminar'] }],
  ['reward reflection', 5, { mode: 'conversions', conversionIds: ['seminar'], reason: '' }],
  ['unknown mode', 0, { mode: 'unknown' }],
  ['secret reason', 5, { reason: 'password=sentinel' }],
  ['single target common confirmation', 0, { commonConfirmed: true }],
]) test(`reflection v2: ${label} rejected before writes`, async t => {
  const c = await reflectionV2Fixture(t); const before = await bytes(c);
  await assert.rejects(c.service.preview(c.draft.id, change(c.options, index, patch)), { status: 400 });
  assert.equal(await bytes(c), before); assert.equal((await c.audit.read()).events.length, 0);
});

test('reflection v2: CTA single-only and unknown category stop; formal ID conflicts never overwrite', async t => {
  const c = await reflectionV2Fixture(t);
  let draft = structuredClone(c.draft);
  Object.assign(draft.candidates[0].original, { target: 'ctaLabel' });
  // Review hash must match; use the normal review operation to construct the changed snapshot.
  const edited = { ...c.draft.candidates[0].original, target: 'ctaLabel' };
  const changed = await c.imports.review(c.draft.id, 'candidate-1', c.draft.revision, { ...checkedReview, edited });
  assert.throws(() => projectReflectionV2(changed, c.offer, change(c.options, 0, { conversionIds: ['seminar', 'membership'], commonConfirmed: true })), { status: 400 });
  draft = structuredClone(c.draft); draft.candidates[2].original.category = 'unknown';
  assert.throws(() => projectReflectionV2(draft, c.offer, c.options), { status: 400 });
  const offer = structuredClone(c.offer);
  const first = projectReflectionV2(c.draft, c.offer, c.options);
  offer.conversions[0].eligibility.push(first.input.conversions[0].eligibility[0]); offer.sources = first.input.sources;
  assert.throws(() => projectReflectionV2(c.draft, offer, c.options), { status: 409 });
  assert.equal(reflectionStatementId(c.draft.id, 'candidate-3', 'seminar').length, 69);
});

test('reflection v2: unverified content cannot reflect; normal editing resets checking and invalidates approval', async t => {
  const c = await reflectionV2Fixture(t);
  const p = await c.service.preview(c.draft.id, c.options);
  const edited = { ...c.draft.candidates[2].original, conversionKey: 'human-common' };
  const draft = await c.imports.review(c.draft.id, 'candidate-3', c.draft.revision, { ...checkedReview, sourceChecked: false, edited });
  assert.equal(draft.candidates[2].review.verification, 'unverified');
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
  await assert.rejects(c.service.preview(draft.id, c.options), { status: 400 });
  assert.equal((await c.audit.read()).events.length, 0);
});

for (const kind of ['offer', 'import']) test(`reflection v2: ${kind} revision conflict preserves records`, async t => {
  const c = await reflectionV2Fixture(t); const p = await c.service.preview(c.draft.id, c.options);
  if (kind === 'offer') await c.offers.update(c.offer.id, c.offer.revision, offerBusiness(c.offer));
  else await c.imports.review(c.draft.id, 'candidate-9', c.draft.revision, checkedReview);
  const before = await bytes(c);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
  assert.equal(await bytes(c), before); assert.equal((await c.audit.read()).events.length, 0);
});

test('reflection v2: new mapping preview expires previous approval; none-only creates audit without offer revision', async t => {
  const c = await reflectionV2Fixture(t); const old = await c.service.preview(c.draft.id, c.options);
  const options = { ...c.options, choices: c.draft.candidates.map(x => noneChoice(x.id)) };
  const before = await bytes(c); const p = await c.service.preview(c.draft.id, options);
  await assert.rejects(c.service.commit(old.token, { approve: true }), { status: 409 });
  await c.service.commit(p.token, { approve: true });
  assert.equal(await bytes(c), before); assert.equal((await c.offers.get(c.offer.id)).revision, 1);
  const states = (await c.service.records(c.draft.id)).states;
  assert.equal(states[0].state, 'committed'); assert.equal(states[0].intent.plan.decisions.length, 9);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
});

test('reflection v2: content change with same revision invalidates signed snapshot hash', async t => {
  const c = await reflectionV2Fixture(t); const p = await c.service.preview(c.draft.id, c.options);
  // Pending initial copies of an unused candidate can be changed consistently without changing revision.
  const filename = path.join(c.directory, 'offer-imports', c.draft.id + '.json');
  const record = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const r of record.revisions) {
    const candidate = r.candidates[8];
    candidate.original.text = '別の架空候補本文';
    if (candidate.review.decision !== 'pending') candidate.review.confirmedHash = reviewContentHash(candidate.review.edited || candidate.original, r.documents);
  }
  await fs.writeFile(filename, JSON.stringify(record));
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 409 });
  assert.equal((await c.offers.get(c.offer.id)).revision, 1);
});

test('reflection v2: identical candidates are never automatically merged', async t => {
  const c = await reflectionV2Fixture(t);
  const options = change(c.options, 7, targetChoice('candidate-8', 'seminar', 'membership'));
  const plan = projectReflectionV2(c.draft, c.offer, options);
  assert.equal(plan.input.conversions[0].rejectionConditions.length, 2);
  assert.equal(plan.input.conversions[1].rejectionConditions.length, 2);
  assert.equal(new Set(plan.mappings.filter(m => ['candidate-7', 'candidate-8'].includes(m.candidateId)).map(m => m.officialId)).size, 4);
});

test('reflection v2: mixed v1/v2 ledger replays exact old intent; backup integrity and dry-run stay compatible', async t => {
  const c = await reflectionV2Fixture(t);
  const oldOptions = { offerId: c.offer.id, conversions: [] };
  const old = await c.service.preview(c.draft.id, oldOptions); await c.service.commit(old.token, { approve: true });
  const oldEvent = structuredClone((await c.audit.read()).events[0]);
  assert.deepEqual(oldEvent.plan, projectReflection(oldEvent.importSnapshot, oldEvent.offerSnapshot, oldOptions));
  const next = await c.service.preview(c.draft.id, c.options); await c.service.commit(next.token, { approve: true });
  const ledger = await createCommitStore(c.directory).read(); assert.deepEqual(ledger.events[0], oldEvent);
  assert.deepEqual(ledger.events.filter(e => e.type === 'intent').map(e => e.plan.schemaVersion), [1, 2]);
  const maintenance = createMaintenanceService(c.directory, { now: c.now });
  assert.equal((await maintenance.integrity()).status, 'normal');
  const backup = await maintenance.create(); assert.equal((await maintenance.dryRun(backup.manifest.id)).status, 'normal');
  await assert.rejects(c.service.preview(c.draft.id, c.options), { status: 409 });
});

for (const afterSave of [false, true]) test(`reflection v2: ${afterSave ? 'committed' : 'not-applied'} partial save recovers without resave`, async t => {
  let calls = 0;
  const c = await reflectionV2Fixture(t, { offersWrapper: offers => ({ ...offers, async update(...args) {
    calls++; if (afterSave) await offers.update(...args); throw new Error('fixture interrupted');
  } }) });
  const p = await c.service.preview(c.draft.id, c.options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 503 });
  const recovered = createReflectionService({ dataDirectory: c.directory, importStore: c.imports, offerStore: c.offers, now: c.now });
  const records = await recovered.records(c.draft.id);
  assert.equal(records.states[0].state, 'recovery_required');
  assert.equal(records.recovery.outcome, afterSave ? 'committed' : 'not_applied');
  const before = await bytes(c); await recovered.recover(records.recovery.token, { approve: true });
  assert.equal(await bytes(c), before); assert.equal(calls, 1);
  assert.equal((await createCommitStore(c.directory).read()).events.at(-1).mode, 'recovery');
});

async function httpFixture(t, size = 9, blockedDisclosure = false) {
  const c = await reflectionV2Fixture(t, { size, blockedDisclosure });
  const server = createApp({ dataDirectory: c.directory, offerImportOptions: { store: c.imports, reflection: c.service }, offerOptions: { store: c.offers } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  c.base = `http://127.0.0.1:${server.address().port}`;
  c.route = `/offer-imports/${c.draft.id}/reflection-v2`;
  c.post = (route, form, headers = { Origin: c.base }) => fetch(c.base + route, { method: 'POST', body: form, headers, redirect: 'manual' });
  return c;
}

test('reflection v2 HTTP: native forms, required explicit choices, escaped none reason and separate approval', async t => {
  const c = await httpFixture(t); const before = await bytes(c);
  let response = await fetch(c.base + c.route); let html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /name="candidate-3.common"/); assert.match(html, /name="candidate-1.target"/);
  assert.ok(!html.includes(' checked')); assert.ok(!html.includes('name="token"'));
  assert.ok(html.includes('架空の無料セミナー予約'));
  const options = change(c.options, 7, { reason: '<img src=x onerror=alert(1)>' });
  response = await c.post(c.route, reflectionV2Form(c, options)); html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /&lt;img/); assert.ok(!html.includes(options.choices[7].reason));
  assert.ok(!html.includes('data-reflection-v2-form')); // Preview is read-only; editing requires invalidating this approval.
  const token = html.match(/name="token" value="([^"]+)"/)[1];
  assert.equal(await bytes(c), before);
  const approved = await c.post(`/offer-imports/${c.draft.id}/commit`, new URLSearchParams({ token, confirm: 'yes' }));
  assert.equal(approved.status, 303);
});

test('reflection v2 HTTP: editing invalidates old confirmation, stale selection and injected fields stop', async t => {
  const c = await httpFixture(t);
  const html = await (await c.post(c.route, reflectionV2Form(c))).text(); const token = html.match(/name="token" value="([^"]+)"/)[1];
  await fetch(c.base + c.route);
  assert.equal((await c.post(`/offer-imports/${c.draft.id}/commit`, new URLSearchParams({ token, confirm: 'yes' }))).status, 409);
  for (const [key, value] of [['importRevision', '1'], ['offerRevision', '999'], ['candidate-3.common', 'no'], ['sourceChecked', 'yes']]) {
    const form = reflectionV2Form(c); form.set(key, value);
    assert.equal((await c.post(c.route, form)).status, key.endsWith('Revision') ? 409 : 400);
  }
  const duplicate = reflectionV2Form(c); duplicate.append('candidate-3.target', 'seminar');
  assert.equal((await c.post(c.route, duplicate)).status, 400);
  assert.equal((await c.post(c.route, reflectionV2Form(c), {})).status, 403);
  assert.equal((await c.offers.get(c.offer.id)).revision, 1);
});

for (const size of [26, 200]) test(`reflection v2: ${size} candidates remain explicitly represented in UI and approval`, async t => {
  const c = await httpFixture(t, size);
  const html = await (await fetch(c.base + c.route)).text();
  assert.equal((html.match(/name="candidate-\d+\.mode"/g) || []).length, size);
  const response = await c.post(c.route, reflectionV2Form(c)); assert.equal(response.status, 200);
  const preview = await response.text(); assert.ok(preview.includes('name="token"')); assert.ok(preview.includes(`candidate-${size}`));
});

test('reflection v2: no external connection attempts', () => assert.deepEqual(blockedConnections, []));

for (const auditOnly of [false, true]) test(`reflection v2: result-save failure recovers ${auditOnly ? 'audit-only' : 'formal'} exact history without another save`, async t => {
  let writes = 0;
  const c = await reflectionV2Fixture(t, { auditFileSystem: { ...fs, async rename(...args) {
    writes++; if (writes === 2) throw new Error('fixture result failure'); return fs.rename(...args);
  } } });
  const options = auditOnly ? { ...c.options, choices: c.draft.candidates.map(x => noneChoice(x.id)) } : c.options;
  const p = await c.service.preview(c.draft.id, options);
  await assert.rejects(c.service.commit(p.token, { approve: true }), { status: 503 });
  const recovered = createReflectionService({ dataDirectory: c.directory, now: c.now, importStore: c.imports, offerStore: c.offers });
  const records = await recovered.records(c.draft.id);
  assert.equal(records.recovery.outcome, 'committed');
  const before = await bytes(c);
  await assert.rejects(recovered.recover(records.recovery.token, { approve: false }), { status: 400 });
  await recovered.recover(records.recovery.token, { approve: true });
  assert.equal(await bytes(c), before);
  assert.equal((await c.offers.get(c.offer.id)).revision, auditOnly ? 1 : 2);
  assert.equal((await createMaintenanceService(c.directory, { now: c.now }).integrity()).status, 'normal');
});


test('reflection v2: selection snapshot cannot silently refresh while preparing preview', async t => {
  const c = await reflectionV2Fixture(t);
  const expected = { importRevision: c.draft.revision, offerRevision: c.offer.revision, importHash: reflectionHash(c.draft), offerHash: reflectionHash(c.offer) };
  for (const key of Object.keys(expected)) {
    await assert.rejects(c.service.preview(c.draft.id, c.options, { ...expected, [key]: key.endsWith('Revision') ? 999 : 'changed' }), { status: 409 });
  }
  assert.equal((await c.service.preview(c.draft.id, c.options, expected)).plan.schemaVersion, 2);
});

test('reflection v2: no-JS single target can be explicitly cleared before choosing none', async t => {
  const c = await httpFixture(t);
  const form = reflectionV2Form(c);
  form.set('candidate-1.mode', 'none'); form.set('candidate-1.reason', '明示的に反映なし'); form.set('candidate-1.target', '');
  assert.equal((await c.post(c.route, form)).status, 200);
  form.append('candidate-1.target', 'seminar');
  assert.equal((await c.post(c.route, form)).status, 400);
});


test('reflection v2 policy: constraint disclosure UI forbids offer but keeps human none undecided; server safely diagnoses', async t => {
  const c = await httpFixture(t, 26, true);
  const before = await bytes(c); const beforeImport = await c.imports.get(c.draft.id);
  const html = await (await fetch(c.base + c.route)).text();
  const section = html.split('id="mapping-candidate-20"')[1].split('id="mapping-candidate-21"')[0];
  assert.ok(section.includes('現在のusage/classification')); assert.ok(!section.includes('value="offer"'));
  assert.ok(section.includes('value="none"')); assert.ok(!section.includes(' selected'));
  const options = change(c.options, 19, { mode: 'offer', reason: '診断に露出してはいけない理由' });
  const response = await c.post(c.route, reflectionV2Form(c, options)); const failure = await response.text();
  assert.equal(response.status, 400); assert.ok(failure.includes('candidate-20')); assert.ok(failure.includes('入力項目：usage')); assert.ok(failure.includes('V2_SCALAR_USAGE_REQUIRED'));
  for (const secret of ['架空の効果非保証表示', options.choices[19].reason, c.draft.candidates[19].original.evidence[0].quote]) assert.ok(!failure.includes(secret));
  assert.equal(await bytes(c), before); assert.deepEqual(await c.imports.get(c.draft.id), beforeImport);
  assert.equal((await c.audit.read()).events.length, 0);
  assert.equal((await c.post(c.route, reflectionV2Form(c))).status, 200);
});

test('reflection v2 policy: every rendered positive mode agrees with projection across target, usage and checking', async t => {
  const c = await reflectionV2Fixture(t, { size: 26, blockedDisclosure: true });
  const escape = x => String(x).replaceAll('<', '&lt;');
  const html = reflectionV2Pages(escape).selection(c.draft, [c.offer], c.offer.id);
  for (const candidate of c.draft.candidates) {
    const eligibility = reflectionV2Eligibility(candidate, c.draft);
    const section = html.split(`id="mapping-${candidate.id}"`)[1].split('<details id="mapping-')[0];
    for (const mode of ['offer', 'conversions']) {
      assert.equal(section.includes(`value="${mode}"`), eligibility[mode], candidate.id + mode);
      const options = { ...c.options, choices: c.draft.candidates.map(x => noneChoice(x.id)) };
      options.choices[Number(candidate.id.split('-')[1]) - 1] = { candidateId: candidate.id, mode, conversionIds: mode === 'conversions' ? ['seminar'] : [], reason: '', commonConfirmed: false };
      if (eligibility[mode]) assert.doesNotThrow(() => projectReflectionV2(c.draft, c.offer, options));
      else assert.throws(() => projectReflectionV2(c.draft, c.offer, options), { status: 400 });
    }
  }
});

test('reflection v2 diagnostic: only fixed codes, fields and candidate IDs may render', () => {
  const escape = x => x;
  assert.ok(reflectionV2Diagnostic(v2ValidationError('candidate-20', 'usage', 'V2_SCALAR_USAGE_REQUIRED'), escape));
  for (const d of [{ candidateId: '<script>', field: 'usage', code: 'V2_SCALAR_USAGE_REQUIRED' }, { candidateId: 'candidate-20', field: 'secret-text', code: 'V2_SCALAR_USAGE_REQUIRED' }, { candidateId: 'candidate-20', field: 'usage', code: 'secret-value' }]) assert.equal(reflectionV2Diagnostic({ v2Diagnostic: d }, escape), '');
});
