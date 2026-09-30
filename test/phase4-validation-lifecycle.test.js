import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDraftStore } from '../lib/drafts.js';
import { createOfferStore } from '../lib/offers/store.js';
import { createGenerationStore } from '../lib/ai/generation-store.js';
import { createGenerationService } from '../lib/ai/generation-service.js';
import { openaiConfig } from '../lib/ai/config.js';
import { contentHash, affiliateContextHash, validateAffiliateContent } from '../lib/affiliate-validation.js';
import { affiliateValidationState } from '../lib/affiliate-validation-lifecycle.js';
import { contextHash } from '../lib/ai/affiliate-context.js';
import { offerInput } from './fixtures/plan-offer.js';
import { createApp } from '../server.js';
import { publicationInput } from './fixtures/affiliate-publication.js';

const now = () => new Date('2026-09-30T00:00:00Z');
async function setup(t, draftOptions = {}, changes = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'affiliate-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const offers = createOfferStore(directory, { now });
  const input = offerInput(); input.prohibitedExpressions[0].text = '絶対成功';
  input.facts[0].text = '料金は100円です。';
  input.facts[2].text = '内部だけの目印'; input.conversions[0].reward.evidence.text = '報酬だけの目印';
  const offer = await offers.create(input);
  const content = { summary: '概要', titles: ['一', '二', '三', '四', '五'], readerNeeds: '悩み', outline: '構成',
    body: `${input.disclosure.text}\n料金は100円です。`, cta: input.conversions[0].ctaLabel.text, social: input.disclosure.text, ...changes };
  const drafts = createDraftStore(directory, { now, offerStore: offers, ...draftOptions });
  const ledger = createGenerationStore(directory);
  let calls = 0;
  const provider = { kind: 'openai', async generate() { calls++; return { status: 'completed', text: JSON.stringify(content), usage: { inputTokens: 100, outputTokens: 100 } }; } };
  const plan = { id: randomUUID(), createdAt: now().toISOString(), theme: '架空の企画', audience: '', medium: 'note', purpose: '', notes: '',
    offerBinding: { offerId: offer.id, offerRevision: 1, conversionId: 'consultation', selectionReason: '', snapshot: { offerName: offer.name, conversionName: offer.conversions[0].name } } };
  const options = { dataDirectory: directory, draftStore: drafts, store: ledger, provider, config: openaiConfig, now, offerStore: offers };
  const service = createGenerationService(options);
  const generate = async (svc = service) => svc.execute(plan, await svc.confirmation(plan));
  const file = id => path.join(directory, 'drafts', `${id}.json`);
  const create = async () => { const run = await generate(); assert.equal(run.state, 'succeeded'); return drafts.get(run.draftId); };
  return { directory, offers, offer, input, content, drafts, ledger, plan, provider, options, service, generate, create, file, calls: () => calls };
}
const current = draft => assert.equal(affiliateValidationState(draft).state, 'current');
const poison = 'SYNTHETIC_SECRET_NEVER_EXPOSE';

test('Step 5.2: 正常AI生成draftへ本文・固定context対応validationを保存', async t => {
  const c = await setup(t); const d = await c.create(); current(d);
  assert.equal(d.affiliateValidation.contentHash, contentHash(d.edited));
  assert.equal(d.affiliateValidation.affiliateContextHash, affiliateContextHash(d.affiliateContext));
  assert.ok(!d.affiliateValidation.findings.some(f => f.severity === 'block'));
  assert.equal(d.schemaVersion, 2); assert.equal(d.status, '未確認'); assert.equal(c.calls(), 1);
});
test('Step 5.2: block記事も保存成功', async t => {
  const c = await setup(t, {}, { summary: '絶対成功' }); const d = await c.create(); current(d);
  assert.ok(d.affiliateValidation.findings.some(f => f.code === 'prohibited-expression' && f.severity === 'block'));
});
test('Step 5.2: warning記事も保存成功', async t => {
  const c = await setup(t, {}, { summary: '料金は999円です。' }); const d = await c.create(); current(d);
  assert.ok(d.affiliateValidation.findings.some(f => f.code === 'unregistered-numeric-candidate' && f.severity === 'warning'));
});
test('Step 5.2: validator内部失敗は診断失敗として本文を保存・秘密非漏洩', async t => {
  const c = await setup(t, { validator() { throw new Error(poison); } }); const d = await c.create();
  assert.equal(d.affiliateValidation, undefined); assert.equal(affiliateValidationState(d).state, 'failed');
  assert.equal(d.affiliateValidationFailure.code, 'validation-unavailable'); assert.deepEqual(d.edited, c.content);
  assert.ok(!JSON.stringify(d).includes(poison)); assert.equal((await c.service.get(d.generation.executionId)).state, 'succeeded');
});
test('Step 5.2: 固定revision読取失敗は検査済みにしない', async t => {
  const c = await setup(t, { offerStore: { history() { throw new Error(poison); } } }); const d = await c.create();
  assert.equal(affiliateValidationState(d).state, 'failed'); assert.equal(d.affiliateValidation, undefined);
  assert.ok(!JSON.stringify(d.affiliateValidationFailure).includes(poison));
});
test('Step 5.2: snapshot不整合は記事findingと分けた検査失敗', async t => {
  const c = await setup(t); const d = await c.create(); const recordPath = path.join(c.directory, 'offers', `${c.offer.id}.json`);
  const record = JSON.parse(await readFile(recordPath, 'utf8')); record.revisions[0].facts[0].text = '料金は999円です。';
  await writeFile(recordPath, JSON.stringify(record)); const updated = await c.drafts.update(d.id, d.revision, null, 'revalidate');
  assert.equal(affiliateValidationState(updated).state, 'failed'); assert.equal(updated.affiliateValidation, undefined);
});
test('Step 5.2: 検査失敗後の明示再検査で回復・API再実行なし', async t => {
  let fail = true; const c = await setup(t, { validator(args) { if (fail) throw new Error(); return validateAffiliateContent(args); } });
  const d = await c.create(); fail = false; const updated = await c.drafts.update(d.id, d.revision, null, 'revalidate');
  current(updated); assert.equal(updated.affiliateValidationFailure, undefined); assert.equal(c.calls(), 1); assert.deepEqual(updated.original, d.original);
});
test('Step 5.2: 本文編集で再検査・hash変更・根拠維持・確認公開準備失効', async t => {
  const c = await setup(t); let d = await c.create(); const before = d;
  d = await c.drafts.update(d.id, d.revision, d.edited, 'review');
  d = await c.drafts.update(d.id, d.revision, publicationInput(d), 'publish');
  d.affiliateValidation.humanConfirmation = { confirmedAt: now().toISOString() }; d.humanConfirmation = { ok: true }; await writeFile(c.file(d.id), JSON.stringify(d));
  const edited = await c.drafts.update(d.id, d.revision, { ...d.edited, body: `${c.input.disclosure.text}\n料金は999円です。` }, 'save');
  current(edited); assert.notEqual(edited.affiliateValidation.contentHash, before.affiliateValidation.contentHash);
  assert.deepEqual(edited.affiliateContext, before.affiliateContext); assert.deepEqual(edited.original, before.original);
  assert.equal(edited.status, '編集中'); assert.equal(edited.reviewedAt, null); assert.equal(edited.publication, undefined);
  assert.equal(edited.humanConfirmation, undefined); assert.equal(edited.affiliateValidation.humanConfirmation, undefined);
});
test('Step 5.2: 編集時の検査失敗でも新本文保存・古い結果削除', async t => {
  let fail = false; const c = await setup(t, { validator(args) { if (fail) throw new Error(); return validateAffiliateContent(args); } });
  const d = await c.create(); fail = true; const edited = await c.drafts.update(d.id, d.revision, { ...d.edited, summary: '変更' }, 'save');
  assert.equal(edited.edited.summary, '変更'); assert.equal(edited.affiliateValidation, undefined); assert.equal(affiliateValidationState(edited).state, 'failed');
});
test('Step 5.2: 最新ended revisionへ追従せず編集検査する', async t => {
  const c = await setup(t); const d = await c.create(); const newer = structuredClone(c.input); newer.status = 'ended'; newer.facts[0].text = '料金は999円です。';
  await c.offers.update(c.offer.id, 1, newer); const edited = await c.drafts.update(d.id, d.revision, { ...d.edited, summary: '料金は999円です。' }, 'save');
  current(edited); assert.deepEqual(edited.affiliateContext, d.affiliateContext); assert.equal(edited.affiliateContext.offerRevision, 1);
  assert.ok(edited.affiliateValidation.findings.some(f => f.code === 'unregistered-numeric-candidate'));
});
test('Step 5.2: 本文以外の状態変更は検査を再利用', async t => {
  let validations = 0; const c = await setup(t, { validator(args) { validations++; return validateAffiliateContent(args); } });
  const d = await c.create(); const reviewed = await c.drafts.update(d.id, d.revision, d.edited, 'review');
  const saved = await c.drafts.update(d.id, reviewed.revision, Object.fromEntries(Object.entries(d.edited).reverse()), 'save');
  assert.equal(validations, 1); assert.deepEqual(saved.affiliateValidation, d.affiliateValidation); current(saved); assert.equal(saved.status, '確認済み');
});
for (const [name, mutate] of [
  ['contentHash', d => { d.edited.summary = '変更'; }],
  ['contextHash', d => { d.affiliateContext.offerRevision = 2; }],
  ['validationVersion', d => { d.affiliateValidation.validationVersion = 'affiliate-local-old'; }],
]) test(`Step 5.2: ${name}変更をstale判定`, async t => { const c = await setup(t); const d = await c.create(); mutate(d); assert.equal(affiliateValidationState(d).state, 'stale'); });
test('Step 5.2: 不正なfindingはinvalid・保存操作で再検査', async t => {
  const c = await setup(t); const d = await c.create(); d.affiliateValidation.findings[0].messageKey = poison;
  assert.equal(affiliateValidationState(d).state, 'invalid'); await writeFile(c.file(d.id), JSON.stringify(d));
  const saved = await c.drafts.update(d.id, d.revision, d.edited, 'save'); current(saved); assert.ok(!JSON.stringify(saved.affiliateValidation).includes(poison));
});
test('Step 5.2: 注入validatorの未知診断値を保存しない', async t => {
  const c = await setup(t, { validator(args) { const v = validateAffiliateContent(args); v.secret = poison; return v; } });
  const d = await c.create(); assert.equal(affiliateValidationState(d).state, 'failed'); assert.ok(!JSON.stringify(d).includes(poison));
});
test('Step 5.2: 検査版変更後の保存で再検査', async t => {
  let validations = 0; const c = await setup(t, { validator(args) { validations++; return validateAffiliateContent(args); } }); const d = await c.create();
  d.affiliateValidation.validationVersion = 'old'; await writeFile(c.file(d.id), JSON.stringify(d));
  current(await c.drafts.update(d.id, d.revision, d.edited, 'save')); assert.equal(validations, 2);
});
test('Step 5.2: Step 4旧draftは読取無変更・保存操作で検査', async t => {
  const c = await setup(t); const d = await c.create(); delete d.affiliateValidation; await writeFile(c.file(d.id), JSON.stringify(d));
  const before = await readFile(c.file(d.id), 'utf8'); const legacy = await c.drafts.get(d.id);
  assert.equal(affiliateValidationState(legacy).state, 'unvalidated'); assert.equal(await readFile(c.file(d.id), 'utf8'), before);
  current(await c.drafts.update(d.id, legacy.revision, legacy.edited, 'save'));
});
test('Step 5.2: 案件なし生成・編集では案件store・validatorを呼ばない', async t => {
  const c = await setup(t, { offerStore: { history() { throw new Error('参照禁止'); } }, validator() { throw new Error('参照禁止'); } });
  delete c.plan.offerBinding; const d = await c.create(); assert.equal(d.affiliateValidation, undefined);
  const edited = await c.drafts.update(d.id, d.revision, { ...d.edited, summary: '変更' }, 'save'); assert.equal(edited.affiliateValidation, undefined); assert.equal(affiliateValidationState(edited).state, 'not-applicable');
});
test('Step 5.2: store編集でclient context/validation追加キーを本文へ取り込まない', async t => {
  const c = await setup(t); const d = await c.create(); const edited = await c.drafts.update(d.id, d.revision, { ...d.edited, affiliateContext: { offerRevision: 999 }, affiliateValidation: { findings: [] } }, 'save');
  assert.deepEqual(edited.affiliateContext, d.affiliateContext); assert.deepEqual(edited.affiliateValidation, d.affiliateValidation); assert.deepEqual(edited.edited, d.edited);
});
test('Step 5.2: save retryは元結果・根拠を維持しAPI1回・重複なし', async t => {
  const c = await setup(t); const service = createGenerationService({ ...c.options, draftStore: { ...c.drafts, create() { throw new Error('保存失敗'); } } });
  const run = await c.generate(service); assert.equal(run.state, 'save-failed');
  await c.offers.update(c.offer.id, 1, { ...c.input, status: 'ended' }); delete c.plan.offerBinding;
  const [a, b] = await Promise.all([c.service.retrySave(run.id), c.service.retrySave(run.id)]);
  assert.equal(a.state, 'succeeded'); assert.equal(a.draftId, b.draftId); assert.equal(c.calls(), 1);
  const d = await c.drafts.get(a.draftId); current(d); assert.deepEqual(d.affiliateContext, run.affiliateContext); assert.deepEqual(d.edited, c.content);
  assert.equal((await c.drafts.list(c.plan.id)).length, 1);
});
test('Step 5.2: draft保存後台帳失敗retryは編集済みdraftを上書きしない', async t => {
  const c = await setup(t); let fail = true;
  const store = { read: c.ledger.read, transaction: fn => c.ledger.transaction(async ledger => { const result = await fn(ledger); if (fail && ledger.runs.some(r => r.state === 'succeeded')) { fail = false; throw new Error(); } return result; }) };
  const service = createGenerationService({ ...c.options, store }); const run = await c.generate(service); assert.equal(run.state, 'save-failed');
  let d = (await c.drafts.list(c.plan.id))[0]; d = await c.drafts.update(d.id, d.revision, { ...d.edited, summary: '人間の編集' }, 'save');
  const retried = await c.service.retrySave(run.id); assert.equal(retried.draftId, d.id); assert.deepEqual(await c.drafts.get(d.id), d); assert.equal(c.calls(), 1);
});
test('Step 5.2: 明示再検査は本文・status維持・Step 5.3確認publication失効・古いrevision拒否', async t => {
  const c = await setup(t); let d = await c.create(); d = await c.drafts.update(d.id, d.revision, d.edited, 'review');
  d = await c.drafts.update(d.id, d.revision, publicationInput(d), 'publish');
  const rechecked = await c.drafts.update(d.id, d.revision, null, 'revalidate');
  assert.deepEqual(rechecked.edited, d.edited); assert.deepEqual(rechecked.affiliateContext, d.affiliateContext); assert.equal(rechecked.publication, undefined); assert.equal(rechecked.status, d.status);
  await assert.rejects(c.drafts.update(d.id, d.revision, null, 'revalidate'), { status: 409 });
});
test('Step 5.2: 記事blockの保存を維持しStep 5.3公開gateで拒否', async t => {
  const c = await setup(t, {}, { summary: '絶対成功', body: `${offerInput().disclosure.text}\n絶対成功` }); let d = await c.create();
  d = await c.drafts.update(d.id, d.revision, d.edited, 'review');
  await assert.rejects(c.drafts.update(d.id, d.revision, publicationInput(d), 'publish'), /block/);
  assert.deepEqual((await c.drafts.get(d.id)).affiliateValidation, d.affiliateValidation);
});
test('Step 5.2: 結果保存に内部情報・URL・source管理情報を追加しない', async t => {
  const c = await setup(t); const d = await c.create(); const raw = JSON.stringify(d.affiliateValidation);
  for (const value of [c.offer.conversions[0].affiliateUrl, '報酬だけの目印', '内部だけの目印', 'test-asp', 'source-1', 'reward', 'internal_only']) assert.ok(!raw.includes(value));
});
test('Step 5.2: freshnessは新しいcheckedAtだけで有効にしない', async t => {
  const c = await setup(t); const d = await c.create(); d.affiliateValidation.checkedAt = '2099-01-01T00:00:00Z'; d.edited.summary = '変更'; assert.equal(affiliateValidationState(d).state, 'stale');
});
test('Step 5.2: finding位置・ID破損はinvalid', async t => {
  const c = await setup(t); const d = await c.create(); const f = d.affiliateValidation.findings.find(f => f.location); f.location.end = 999999; const { id, ...base } = f; f.id = contextHash(base); assert.equal(affiliateValidationState(d).state, 'invalid');
});
async function httpSetup(t) {
  const c = await setup(t); const d = await c.create(); await writeFile(path.join(c.directory, `${c.plan.id}.json`), JSON.stringify(c.plan));
  const server = createApp({ dataDirectory: c.directory }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve))); const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, values, origin = base) => fetch(base + url, { method: 'POST', headers: origin ? { Origin: origin } : {}, body: new URLSearchParams(values), redirect: 'manual' });
  return { ...c, d, base, post, route: `/drafts/${d.id}` };
}
test('Step 5.2 HTTP: 状態・件数表示、GET無変更、client context/validation注入不可', async t => {
  const c = await httpSetup(t); const before = await readFile(c.file(c.d.id), 'utf8'); const html = await (await fetch(c.base + c.route)).text();
  assert.match(html, /data-validation-state="current"/); for (const text of ['block：', 'warning：', 'info：', 'validationVersion', 'checkedAt']) assert.ok(html.includes(text));
  assert.equal(await readFile(c.file(c.d.id), 'utf8'), before);
  const response = await c.post(c.route, { ...c.d.edited, titles: c.d.edited.titles.join('\n'), action: 'save', revision: c.d.revision, affiliateContext: '{"offerRevision":999}', affiliateValidation: '{"findings":[]}' }); assert.equal(response.status, 303);
  const saved = await c.drafts.get(c.d.id); assert.deepEqual(saved.affiliateContext, c.d.affiliateContext); assert.deepEqual(saved.affiliateValidation, c.d.affiliateValidation);
});
test('Step 5.2 HTTP: 旧draft未検査表示・明示POSTで再検査・GET無変更', async t => {
  const c = await httpSetup(t); delete c.d.affiliateValidation; await writeFile(c.file(c.d.id), JSON.stringify(c.d));
  const before = await readFile(c.file(c.d.id), 'utf8'); const html = await (await fetch(c.base + c.route)).text(); assert.match(html, /data-validation-state="unvalidated"/); assert.equal(await readFile(c.file(c.d.id), 'utf8'), before);
  assert.equal((await c.post(c.route + '/affiliate-validation', { revision: c.d.revision })).status, 303); current(await c.drafts.get(c.d.id));
});
test('Step 5.2 HTTP: 再検査はOrigin・revision・入力項目を検証', async t => {
  const c = await httpSetup(t); const route = c.route + '/affiliate-validation';
  assert.equal((await c.post(route, { revision: c.d.revision }, '')).status, 403);
  assert.equal((await c.post(route, { revision: c.d.revision }, 'https://outside.test')).status, 403);
  assert.equal((await c.post(route, { revision: c.d.revision, affiliateContext: '{}' })).status, 400);
  assert.equal((await c.post(route, { revision: c.d.revision, affiliateValidation: '{}' })).status, 400);
  assert.equal((await c.post(route, { revision: c.d.revision - 1 })).status, 409);
});
test('Step 5.2 HTTP: 不正診断を画面へ転載しない・再検査で修復', async t => {
  const c = await httpSetup(t); c.d.affiliateValidation.findings[0].messageKey = poison; await writeFile(c.file(c.d.id), JSON.stringify(c.d));
  const html = await (await fetch(c.base + c.route)).text(); assert.match(html, /data-validation-state="invalid"/); assert.ok(!html.includes(poison));
  assert.equal((await c.post(c.route + '/affiliate-validation', { revision: c.d.revision })).status, 303); current(await c.drafts.get(c.d.id));
});
test('Step 5.2: 外向き通信なし', async t => {
  const guard = await import('./helpers/network-guard.js'); const before = guard.blockedConnections.length; const c = await setup(t); const d = await c.create(); await c.drafts.update(d.id, d.revision, null, 'revalidate'); assert.equal(guard.blockedConnections.length, before);
});
