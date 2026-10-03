import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { affiliateDraftFixture } from './fixtures/affiliate-draft.js';
import { publicationInput } from './fixtures/affiliate-publication.js';
import { createApp } from '../server.js';
import { createDraftStore } from '../lib/drafts.js';
import { createImprovementStore, validateImprovementWork, buildImprovementPrompt, AFFILIATE_IMPROVEMENT_VERSION } from '../lib/improvements.js';
import { affiliateContextHash, contentHash } from '../lib/affiliate-validation.js';
import { affiliateValidationState } from '../lib/affiliate-validation-lifecycle.js';
import { contextHash } from '../lib/ai/affiliate-context.js';
import { blockedConnections } from './helpers/network-guard.js';

const settings = { options: ['readability'], mode: 'rewrite', instructions: '条件と広告明示を保つ' };
async function setup(t, changes = {}) {
  const c = await affiliateDraftFixture(t, changes);
  await writeFile(path.join(c.directory, `${c.plan.id}.json`), JSON.stringify(c.plan));
  const improvements = createImprovementStore(c.directory);
  const request = await improvements.create(c.plan, c.draft, settings);
  const requestFile = path.join(c.directory, 'improvements', `${request.id}.json`);
  const server = createApp({ dataDirectory: c.directory });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, form, origin = base) => fetch(base + route, { method: 'POST', headers: { Origin: origin }, body: form instanceof URLSearchParams ? form : new URLSearchParams(form), redirect: 'manual' });
  return { ...c, improvements, request, requestFile, base, post, route: `/improvements/${request.id}` };
}
const answer = (c, changes = {}) => JSON.stringify({ planId: c.plan.id, promptVersion: c.request.promptVersion,
  requestId: c.request.id, parentDraftId: c.draft.id, generatedAt: null, content: { ...c.content, ...changes } });
const rehash = r => { const { prompt, requestHash, ...data } = r; r.requestHash = contextHash(data); };
async function persistRequest(c, r) { await writeFile(c.requestFile, JSON.stringify(r)); }
async function rejectedEverywhere(c) {
  const count = (await c.drafts.list(c.plan.id)).length;
  const r = await fetch(c.base + c.route); assert.equal(r.status, 409);
  const html = await r.text(); assert.ok(!html.includes(c.content.body)); assert.ok(!html.includes('data-copy'));
  assert.equal((await c.post(c.route, { result: answer(c) })).status, 409);
  await assert.rejects(c.drafts.createImproved(c.request.id, answer(c)), { status: 409 });
  assert.equal((await c.drafts.list(c.plan.id)).length, count);
}

test('Step 5.6: work contract, safe snapshot and prompt integrity without any permission persistence', async t => {
  const c = await setup(t);
  const r = c.request;
  assert.equal(r.schemaVersion, 2); assert.equal(r.promptVersion, AFFILIATE_IMPROVEMENT_VERSION);
  assert.equal(r.purpose, 'affiliate-improvement-work'); assert.equal(r.parentRevision, c.draft.revision);
  assert.deepEqual(r.sourceContent, c.draft.edited); assert.equal(r.sourceContentHash, contentHash(c.draft.edited));
  assert.deepEqual(r.affiliateContext, c.draft.affiliateContext); assert.equal(r.affiliateContextHash, affiliateContextHash(c.draft.affiliateContext));
  assert.equal(r.offerId, c.offer.id); assert.equal(r.offerRevision, 1); assert.equal(r.conversionId, 'consultation');
  assert.deepEqual(r.planSnapshot, { id: c.plan.id }); assert.equal(r.prompt, buildImprovementPrompt(r));
  const before = await readFile(c.requestFile, 'utf8'); const parentBefore = await readFile(c.file, 'utf8');
  for (let i = 0; i < 2; i++) assert.equal((await fetch(c.base + c.route)).status, 200);
  assert.equal(await readFile(c.requestFile, 'utf8'), before); assert.equal(await readFile(c.file, 'utf8'), parentBefore);
  const html = await (await fetch(c.base + c.route)).text(); assert.match(html, /公開許可ではありません/);
  for (const value of ['非公開情報専用目印', '報酬管理専用目印', 'management-only', c.offer.conversions[0].affiliateUrl, c.offer.sources[0].publicUrl, 'internal_only']) {
    assert.ok(!r.prompt.includes(value)); assert.ok(!html.includes(value)); assert.ok(!before.includes(value));
  }
});

for (const state of ['block', 'unconfirmed', 'failed', 'stale']) test(`Step 5.6: ${state} parent can request work without final permission`, async t => {
  const c = await setup(t, state === 'block' ? { summary: '絶対成功' } : {});
  if (state === 'unconfirmed') { c.draft.status = '未確認'; c.draft.reviewedAt = null; }
  if (state === 'failed') { delete c.draft.affiliateValidation; c.draft.affiliateValidationFailure = { code: 'validation-unavailable' }; }
  if (state === 'stale') c.draft.edited.summary += '変更';
  await writeFile(c.file, JSON.stringify(c.draft));
  const response = await c.post(`/drafts/${c.draft.id}/improve`, { revision: String(c.draft.revision), mode: 'rewrite' });
  assert.equal(response.status, 303); assert.equal((await fetch(c.base + response.headers.get('location'))).status, 200);
  assert.equal((await c.drafts.copy(c.draft.id, new URLSearchParams({ revision: String(c.draft.revision), field: 'body' }))).result, 'blocked');
});

for (const state of ['paused', 'ended', 'revised', 'removed-conversion']) test(`Step 5.6: current offer ${state} never changes improvement binding`, async t => {
  const c = await setup(t);
  const input = { ...c.input, name: '最新版だけの案件名', facts: c.input.facts.map(s => ({ ...s, text: '最新版だけの案件情報' })) };
  if (state === 'paused' || state === 'ended') input.status = state;
  if (state === 'removed-conversion') input.conversions = input.conversions.slice(1);
  await c.offers.update(c.offer.id, 1, input);
  c.plan.notes = 'password=PLAN_SECRET'; c.plan.offerBinding = { ...c.plan.offerBinding, offerRevision: 2, conversionId: 'contract' };
  await writeFile(path.join(c.directory, `${c.plan.id}.json`), JSON.stringify(c.plan));
  const created = await c.post(`/drafts/${c.draft.id}/improve`, { revision: String(c.draft.revision), mode: 'rewrite' });
  assert.equal(created.status, 303); const html = await (await fetch(c.base + created.headers.get('location'))).text();
  for (const text of ['最新版だけ', 'PLAN_SECRET', 'offerBinding']) assert.ok(!html.includes(text));
  const child = await c.drafts.createImproved(c.request.id, answer(c));
  assert.deepEqual(child.affiliateContext, c.draft.affiliateContext); assert.equal(affiliateValidationState(child).state, 'current');
  assert.equal((await c.drafts.copy(child.id, new URLSearchParams({ revision: '1', field: 'body' }))).result, 'blocked');
});

test('Step 5.6: parent editing after request preserves request snapshot and immutable parent', async t => {
  const c = await setup(t); const source = structuredClone(c.request.sourceContent);
  c.draft = await c.drafts.update(c.draft.id, c.draft.revision, { ...c.draft.edited, body: c.draft.edited.body + '\n親の新しい編集' }, 'save');
  const parentBefore = await readFile(c.file, 'utf8');
  const html = await (await fetch(c.base + c.route)).text(); assert.ok(!html.includes('親の新しい編集'));
  const child = await c.drafts.createImproved(c.request.id, answer(c, { summary: '改稿' }));
  assert.deepEqual(child.improvement.sourceContent, source); assert.equal(child.improvement.parentRevision, c.request.parentRevision);
  assert.equal(await readFile(c.file, 'utf8'), parentBefore);
});

test('Step 5.6: identical child content gets fresh execution and no parent permissions', async t => {
  const c = await setup(t);
  c.draft = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
  c.draft.humanConfirmation = { allowed: true }; c.draft.currentOfferCheck = { result: 'pass' }; c.draft.finalExportCheck = { result: 'pass' };
  await writeFile(c.file, JSON.stringify(c.draft)); const parentBefore = await readFile(c.file, 'utf8');
  const child = await c.drafts.createImproved(c.request.id, answer(c));
  assert.equal(child.status, '未確認'); assert.equal(child.reviewedAt, null); assert.equal(child.revision, 1);
  assert.deepEqual(child.edited, c.content); assert.equal(child.parentDraftId, c.draft.id);
  assert.equal(affiliateValidationState(child).state, 'current'); assert.notEqual(child.affiliateValidationRunId, c.draft.affiliateValidationRunId);
  for (const key of ['publication', 'humanConfirmation', 'affiliateHumanConfirmation', 'warningResolutions', 'currentOfferCheck', 'finalExportCheck', 'generation']) assert.equal(Object.hasOwn(child, key), false);
  assert.equal(await readFile(c.file, 'utf8'), parentBefore);
  const copy = () => c.drafts.copy(child.id, new URLSearchParams({ revision: String(child.revision), field: 'body' }));
  assert.equal((await copy()).reasonCode, 'publication-not-ready');
  const reviewed = await c.drafts.update(child.id, child.revision, child.edited, 'review');
  assert.equal((await c.drafts.copy(reviewed.id, new URLSearchParams({ revision: String(reviewed.revision), field: 'body' }))).result, 'blocked');
  const ready = await c.drafts.update(reviewed.id, reviewed.revision, publicationInput(reviewed), 'publish');
  assert.equal((await c.drafts.copy(ready.id, new URLSearchParams({ revision: String(ready.revision), field: 'body' }))).result, 'pass');
  await c.offers.update(c.offer.id, 1, { ...c.input, status: 'paused' });
  assert.equal((await c.drafts.copy(ready.id, new URLSearchParams({ revision: String(ready.revision), field: 'body' }))).reasonCode, 'offer-paused');
});

for (const changes of [{ summary: '絶対成功' }, { body: '広告明示を削除' }, { summary: '料金は999円です。' }, { cta: '別の行動案内' }]) test(`Step 5.6: new findings from child ${Object.keys(changes)[0]}=${Object.values(changes)[0]}`, async t => {
  const c = await setup(t); const child = await c.drafts.createImproved(c.request.id, answer(c, changes));
  const codes = child.affiliateValidation.findings.map(f => f.code);
  const expected = changes.summary === '絶対成功' ? 'prohibited-expression' : changes.body ? 'disclosure-missing-or-misplaced' : changes.cta ? 'cta-review' : 'unregistered-numeric-candidate';
  assert.ok(codes.includes(expected)); assert.equal(child.affiliateValidation.contentHash, contentHash(child.edited));
  assert.notEqual(child.affiliateValidation.contentHash, c.draft.affiliateValidation.contentHash);
});

test('Step 5.6: repaired block is re-evaluated; warning confirms new child only', async t => {
  const c = await setup(t, { summary: '絶対成功' });
  const child = await c.drafts.createImproved(c.request.id, answer(c, { summary: '修正済み概要' }));
  assert.equal(affiliateValidationState(c.draft).counts.block, 1); assert.equal(affiliateValidationState(child).counts.block, 0);
  assert.ok(affiliateValidationState(child).counts.warning); assert.equal(child.publication, undefined);
});

for (const failure of ['validator', 'history']) test(`Step 5.6: ${failure} failure saves child failed state`, async t => {
  const c = await setup(t);
  const options = failure === 'validator' ? { offerStore: c.offers, validator: () => { throw new Error('password=DO_NOT_LEAK'); } } : { offerStore: { history: () => { throw new Error('password=DO_NOT_LEAK'); } } };
  const child = await createDraftStore(c.directory, options).createImproved(c.request.id, answer(c));
  assert.equal(affiliateValidationState(child).state, 'failed'); assert.equal(child.status, '未確認');
  assert.deepEqual(child.affiliateContext, c.draft.affiliateContext); assert.ok(!JSON.stringify(child).includes('DO_NOT_LEAK'));
});

const mutations = {
  schema: r => { r.schemaVersion = 1; }, version: r => { r.promptVersion = 'codex-improvement-v1'; },
  purpose: r => { r.purpose = 'export-ready'; }, sourceHash: r => { r.sourceContentHash = '0'.repeat(64); },
  source: r => { r.sourceContent.summary += '改ざん'; }, contextHash: r => { r.affiliateContext.contextHash = '0'.repeat(64); },
  bindingHash: r => { r.affiliateContextHash = '0'.repeat(64); }, incomplete: r => { delete r.affiliateContext.snapshot.cta; },
  offer: r => { r.offerId = randomUUID(); }, revision: r => { r.offerRevision++; }, conversion: r => { r.conversionId = 'contract'; },
  parent: r => { r.parentDraftId = randomUUID(); }, plan: r => { r.planSnapshot.id = randomUUID(); },
  futureParent: r => { r.parentRevision += 100; }, invalidDate: r => { r.createdAt = 'bad'; },
  prompt: r => { r.prompt += '\npassword=DO_NOT_LEAK'; }, settings: r => { r.settings.mode = 'wrong'; },
  settingsInjection: r => { r.settings.affiliateContext = {}; }, requestHash: r => { delete r.requestHash; },
  publication: r => { r.publication = { status: '公開準備OK' }; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`Step 5.6: stored ${name} tampering refused`, async t => {
  const c = await setup(t); mutate(c.request); await persistRequest(c, c.request);
  if (name === 'parent') { // 親が存在しないときも旧依頼を使用できない。
    assert.equal((await fetch(c.base + c.route)).status, 404);
    await assert.rejects(c.drafts.createImproved(c.request.id, answer(c)), { status: 404 });
  } else await rejectedEverywhere(c);
});

for (const secret of ['password=DO_NOT_LEAK', 'Bearer MOCK_SECRET', 'https://example.test/?token=MOCK_SECRET', 'https://affiliate.example.test/path']) test(`Step 5.6: new instructions secret/url refused ${secret}`, async t => {
  const c = await setup(t);
  const count = (await readdir(path.join(c.directory, 'improvements'))).length;
  const response = await c.post(`/drafts/${c.draft.id}/improve`, { revision: String(c.draft.revision), instructions: secret });
  assert.equal(response.status, 409); assert.ok(!(await response.text()).includes(secret));
  assert.equal((await readdir(path.join(c.directory, 'improvements'))).length, count);
});

for (const kind of ['legacy', 'missing-parent-context', 'null-parent-context', 'bad-parent-hash', 'parent-context-switched', 'secret-source']) test(`Step 5.6: ${kind} cannot fall back to plain improvement`, async t => {
  const c = await setup(t);
  if (kind === 'legacy') {
    c.request.schemaVersion = 1; c.request.promptVersion = 'codex-improvement-v1';
    for (const key of ['purpose', 'affiliateContext', 'sourceContentHash', 'affiliateContextHash', 'offerId', 'offerRevision', 'conversionId', 'requestHash']) delete c.request[key];
    await persistRequest(c, c.request);
  } else if (kind === 'secret-source') {
    c.request.sourceContent.summary = 'password=DO_NOT_LEAK'; c.request.sourceContentHash = contentHash(c.request.sourceContent);
    rehash(c.request); c.request.prompt = buildImprovementPrompt(c.request); await persistRequest(c, c.request);
  } else {
    if (kind === 'missing-parent-context') delete c.draft.affiliateContext;
    if (kind === 'null-parent-context') c.draft.affiliateContext = null;
    if (kind === 'bad-parent-hash') c.draft.affiliateContext.contextHash = '0'.repeat(64);
    if (kind === 'parent-context-switched') { c.draft.affiliateContext.conversionId = 'contract'; }
    await writeFile(c.file, JSON.stringify(c.draft));
  }
  await rejectedEverywhere(c);
});

for (const key of ['affiliateContext', 'affiliateValidation', 'publication', 'humanConfirmation', 'warningResolutions', 'currentOfferCheck', 'finalExportCheck', 'offerRevision', 'conversionId', 'unknown']) test(`Step 5.6: client ${key} rejected on create and import`, async t => {
  const c = await setup(t); const value = 'password=DO_NOT_LEAK';
  for (const [route, fields] of [[`/drafts/${c.draft.id}/improve`, { revision: String(c.draft.revision), [key]: value }], [c.route, { result: answer(c), [key]: value }]]) {
    const response = await c.post(route, fields); assert.equal(response.status, 400); assert.ok(!(await response.text()).includes(value));
  }
  const payload = JSON.parse(answer(c)); payload[key] = value;
  assert.equal((await c.post(c.route, { result: JSON.stringify(payload) })).status, 400);
  delete payload[key]; payload.content[key] = value;
  assert.equal((await c.post(c.route, { result: JSON.stringify(payload) })).status, 400);
  assert.equal((await c.drafts.list(c.plan.id)).length, 1);
});

test('Step 5.6: duplicate fields, JSON keys, query injection and cross-origin rejected', async t => {
  const c = await setup(t);
  for (const key of ['revision', 'mode', 'instructions']) {
    const form = new URLSearchParams({ revision: String(c.draft.revision), mode: 'rewrite', instructions: '' }); form.append(key, form.get(key));
    assert.equal((await c.post(`/drafts/${c.draft.id}/improve`, form)).status, 400);
  }
  for (const key of ['result', 'confirmWrap']) {
    const form = new URLSearchParams({ result: answer(c), confirmWrap: 'yes' }); form.append(key, form.get(key));
    assert.equal((await c.post(c.route, form)).status, 400);
  }
  const duplicate = answer(c).replace('"summary":', '"summary":"注入","summary":');
  assert.equal((await c.post(c.route, { result: duplicate })).status, 400);
  const options = new URLSearchParams({ revision: String(c.draft.revision) }); options.append('options', 'seo'); options.append('options', 'seo');
  assert.equal((await c.post(`/drafts/${c.draft.id}/improve`, options)).status, 400);
  assert.equal((await fetch(c.base + c.route + '?affiliateContext={}')).status, 400);
  assert.equal((await c.post(c.route, { result: answer(c) }, 'https://external.invalid')).status, 403);
});

test('Step 5.6: generic draft create remains unable to inject improvement context or relax direct generation', async t => {
  const c = await setup(t);
  await assert.rejects(c.drafts.create(c.plan, { content: c.content }, 'raw', c.request.prompt, c.request), { status: 409 });
  for (const generation of [null, { provider: 'fake' }]) await assert.rejects(c.drafts.create(c.plan, { content: c.content }, 'raw', 'prompt', null, generation, c.draft.affiliateContext));
  assert.equal((await c.drafts.list(c.plan.id)).length, 1);
});

test('Step 5.6: HTTP result import and fresh validation; no outward communication', async t => {
  const before = blockedConnections.length; const c = await setup(t);
  const r = await c.post(c.route, { result: answer(c, { summary: '改稿の概要' }) }); assert.equal(r.status, 303);
  const html = await (await fetch(c.base + r.headers.get('location'))).text(); assert.match(html, /未確認/); assert.match(html, /検査済み/);
  assert.equal(blockedConnections.length, before);
});

for (const affiliate of [true, false]) test(`Step 5.6: ${affiliate ? 'affiliate' : 'plain'} analysis preserved and cannot import`, async t => {
  const c = await setup(t);
  let draft = c.draft;
  if (!affiliate) draft = await c.drafts.create({ ...c.plan, offerBinding: undefined }, { content: c.content, generatedAt: null }, 'raw', 'plain');
  const r = await c.improvements.create(c.plan, draft, { ...settings, mode: 'analysis' });
  const html = await (await fetch(`${c.base}/improvements/${r.id}`)).text(); assert.match(html, /分析モード/); assert.ok(!html.includes('id="result"'));
  assert.equal((await c.post(`/improvements/${r.id}`, { result: answer(c) })).status, 400);
  await assert.rejects(c.drafts.createImproved(r.id, answer(c)), /分析結果/);
});

test('Step 5.6: plain rewrite preserves schema, plan prompt, post-edit import and no affiliate validation', async t => {
  const c = await setup(t);
  const plan = { ...c.plan }; delete plan.offerBinding;
  const parent = await c.drafts.create(plan, { content: c.content, generatedAt: null }, 'raw', 'plain');
  const request = await c.improvements.create(plan, parent, settings); assert.equal(request.schemaVersion, 1); assert.equal(request.affiliateContext, undefined);
  assert.ok(request.prompt.includes(plan.theme));
  await c.drafts.update(parent.id, 1, { ...parent.edited, summary: '後の編集' }, 'save');
  const raw = JSON.stringify({ planId: plan.id, promptVersion: request.promptVersion, requestId: request.id, parentDraftId: parent.id, generatedAt: null, content: c.content });
  const response = await c.post(`/improvements/${request.id}`, { result: raw }); assert.equal(response.status, 303);
  const child = await c.drafts.get(response.headers.get('location').split('/').at(-1));
  assert.equal(child.affiliateContext, undefined); assert.equal(child.affiliateValidation, undefined); assert.equal(child.status, '未確認');
});

for (const kind of ['context-missing', 'context-incomplete', 'context-hash', 'source-secret']) test(`Step 5.6: invalid parent ${kind} refuses new request without writing`, async t => {
  const c = await setup(t);
  if (kind === 'context-missing') delete c.draft.affiliateContext;
  if (kind === 'context-incomplete') delete c.draft.affiliateContext.snapshot.facts;
  if (kind === 'context-hash') c.draft.affiliateContext.contextHash = '0'.repeat(64);
  if (kind === 'source-secret') c.draft.edited.summary = 'password=DO_NOT_LEAK';
  await writeFile(c.file, JSON.stringify(c.draft));
  const before = (await readdir(path.join(c.directory, 'improvements'))).length;
  const r = await c.post(`/drafts/${c.draft.id}/improve`, { revision: String(c.draft.revision) });
  assert.equal(r.status, 409); assert.ok(!(await r.text()).includes('DO_NOT_LEAK'));
  assert.equal((await readdir(path.join(c.directory, 'improvements'))).length, before);
});

test('Step 5.6: imported secret rejected without result echo, draft or log', async t => {
  const c = await setup(t); const logs = []; const original = console.error;
  console.error = (...args) => logs.push(args.join(' ')); t.after(() => { console.error = original; });
  for (const raw of [answer(c, { summary: 'password=DO_NOT_LEAK' }), 'password=DO_NOT_LEAK\n' + answer(c)]) {
    const r = await c.post(c.route, { result: raw }); assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes('DO_NOT_LEAK'));
  }
  assert.deepEqual(logs, []); assert.equal((await c.drafts.list(c.plan.id)).length, 1);
});

test('Step 5.6: HTTP wrapped import remains preview-only until confirmation', async t => {
  const c = await setup(t);
  const wrapped = answer(c, { summary: '折返しの概要' }).replace('折返しの概要', '折返しの\n  概要');
  const r = await c.post(c.route, { result: wrapped }); assert.equal(r.status, 200); assert.match(await r.text(), /まだ保存していません/);
  assert.equal((await c.drafts.list(c.plan.id)).length, 1);
  const confirmed = await c.post(c.route, { result: wrapped, confirmWrap: 'yes' }); assert.equal(confirmed.status, 303);
  const child = await c.drafts.get(confirmed.headers.get('location').split('/').at(-1));
  assert.equal(child.edited.summary, '折返しの概要'); assert.equal(affiliateValidationState(child).state, 'current');
});


test('Step 5.6: JSON-escaped secret cannot bypass decoded content check', async t => {
  const c = await setup(t);
  const raw = answer(c, { summary: 'password=DO_NOT_LEAK' }).replace('password', '\\u0070assword');
  const r = await c.post(c.route, { result: raw }); assert.equal(r.status, 400);
  assert.ok(!(await r.text()).includes('DO_NOT_LEAK')); assert.equal((await c.drafts.list(c.plan.id)).length, 1);
});

test('Step 5.6: fullwidth URL cannot bypass additional instruction URL check', async t => {
  const c = await setup(t);
  const r = await c.post(`/drafts/${c.draft.id}/improve`, { revision: String(c.draft.revision), instructions: 'ｈｔｔｐｓ：／／example.test/path' });
  assert.equal(r.status, 409); assert.equal((await readdir(path.join(c.directory, 'improvements'))).length, 1);
});


test('Step 5.6: manual no-context draft on bound plan remains no-offer improvement', async t => {
  const c = await setup(t);
  const parent = await c.drafts.create(c.plan, { content: c.content, generatedAt: null }, 'manual raw', 'manual prompt');
  const r = await c.post(`/drafts/${parent.id}/improve`, { revision: '1' }); assert.equal(r.status, 303);
  const request = await c.improvements.get(r.headers.get('location').split('/').at(-1));
  assert.equal(request.schemaVersion, 1); assert.equal(request.affiliateContext, undefined);
  assert.ok(!request.prompt.includes('offerBinding'));
  const raw = JSON.stringify({ planId: c.plan.id, promptVersion: request.promptVersion, requestId: request.id,
    parentDraftId: parent.id, generatedAt: null, content: c.content });
  const child = await c.drafts.createImproved(request.id, raw);
  assert.equal(child.affiliateContext, undefined); assert.equal(child.affiliateValidation, undefined);
});
