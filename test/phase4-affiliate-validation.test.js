import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { offerInput } from './fixtures/plan-offer.js';
import { resolveAffiliateContext, contextHash } from '../lib/ai/affiliate-context.js';
import { loadAffiliateEvidence } from '../lib/affiliate-evidence.js';
import { validateAffiliateContent, contentHash, affiliateContextHash } from '../lib/affiliate-validation.js';

const checkedAt = '2026-09-30T00:00:00.000Z';
async function setup() {
  const offer = { ...offerInput(), id: randomUUID(), schemaVersion: 1, revision: 1, createdAt: checkedAt, updatedAt: checkedAt };
  const stmt = (id, text, overrides = {}) => ({ ...offer.facts[0], id, text, ...overrides });
  offer.facts = [stmt('price', '月額1万円です。'), stmt('rate', '最大50%です。'), stmt('people', '参加者100人です。')];
  offer.prohibitedExpressions[0].text = '絶対SUCCESS';
  offer.disclosure.placements = ['bodyStart', 'cta', 'social'];
  offer.conversions[0].ctaLabel.text = '広告：アフィリエイトリンクを含みます。架空の相談を申し込む';
  const store = { history: async () => [offer] };
  const binding = { offerId: offer.id, offerRevision: 1, conversionId: 'consultation', selectionReason: '', snapshot: { offerName: offer.name, conversionName: offer.conversions[0].name } };
  const { affiliateContext } = await resolveAffiliateContext(binding, store, new Date(checkedAt));
  const content = { summary: '概要', titles: ['一', '二', '三', '四', '五'], readerNeeds: '悩み', outline: '構成',
    body: `${offer.disclosure.text}\n月額1万円です。`, cta: offer.conversions[0].ctaLabel.text, social: offer.disclosure.text };
  const run = (changes = {}, fixedOffer = offer, context = affiliateContext) => validateAffiliateContent({ content: { ...content, ...changes }, fixedOffer, affiliateContext: context, checkedAt });
  return { offer, store, affiliateContext, content, run, stmt };
}
const has = (r, code, severity) => r.findings.some(f => f.code === code && (!severity || f.severity === severity));

test('正常記事: 真偽承認なし・決定論的・入力不変', async () => {
  const c = await setup(); const before = JSON.stringify(c); const a = c.run();
  assert.ok(!a.findings.some(f => f.severity === 'block')); assert.ok(has(a, 'numeric-text-match', 'info'));
  assert.ok(has(a, 'human-fact-review-required', 'warning')); assert.deepEqual(a, c.run()); assert.equal(JSON.stringify(c), before);
  assert.equal(a.schemaVersion, 1); assert.equal(a.checkedAt, checkedAt); assert.ok(a.findings.every(f => /^[a-f0-9]{64}$/.test(f.id) && f.messageKey.startsWith('affiliate.')));
});
for (const [name, value] of [['完全一致', '絶対SUCCESS'], ['NFKC全角半角大小文字', '絶対ｓｕｃｃｅｓｓ'], ['部分一致', 'これは絶対SUCCESSです'], ['引用否定', '「絶対SUCCESS」とは言いません']]) {
  test(`禁止表現 ${name}`, async () => { const c = await setup(); assert.ok(has(c.run({ summary: value }), 'prohibited-expression', 'block')); });
}
test('禁止表現回避候補はwarning', async () => { const c = await setup(); assert.ok(has(c.run({ summary: '絶対 S\u200buC\nCESS' }), 'prohibition-evasion-candidate', 'warning')); });
test('登録文字列をregex実行しない', async () => { const c = await setup(); c.offer.prohibitedExpressions[0].text = '.*'; c.affiliateContext.snapshot.prohibitedExpressions = ['.*']; c.affiliateContext.contextHash = contextHash(c.affiliateContext.snapshot); assert.ok(!has(c.run(), 'prohibited-expression')); assert.ok(has(c.run({ outline: '.*' }), 'prohibited-expression')); });
for (const [name, value] of [['価格', '価格は999円です。'], ['割合', '割引率は25%です。'], ['期間', '期間は7日です。'], ['人数', '成功者100人です。'], ['金額', '総額1万円です。']]) {
  test(`未登録・別意味 ${name}`, async () => { const c = await setup(); const r = c.run({ summary: value }); assert.ok(has(r, 'unregistered-numeric-candidate', 'warning')); assert.ok(!r.findings.some(f => f.field === 'summary' && f.code === 'numeric-text-match')); });
}
test('1万円と10,000円は文脈も同一なら候補info', async () => { const c = await setup(); assert.ok(has(c.run({ summary: '月額10,000円です。' }), 'numeric-text-match')); });
test('記事構成数字は案件事実にしない', async () => { const c = await setup(); const r = c.run({ summary: '初心者が確認したい3つのポイント' }); assert.ok(!r.findings.some(f => f.field === 'summary')); });
test('限定語脱落はwarning', async () => { const c = await setup(); assert.ok(has(c.run({ summary: '50%です。' }), 'numeric-qualification-review', 'warning')); });
test('非数値の未登録効果・対象条件は人間確認', async () => { const c = await setup(); assert.ok(has(c.run({ summary: '必ず効果があります。全員が対象です。' }), 'claim-review')); });
for (const field of ['body', 'cta', 'social']) {
  test(`disclosure ${field}正常`, async () => { const c = await setup(); assert.ok(!c.run().findings.some(f => f.field === field && f.code === 'disclosure-missing-or-misplaced')); });
  test(`disclosure ${field}欠落`, async () => { const c = await setup(); assert.ok(c.run({ [field]: '通常の記事です。' }).findings.some(f => f.field === field && f.code === 'disclosure-missing-or-misplaced' && f.severity === 'block')); });
}
test('bodyStartは本文途中の明示を許可しない', async () => { const c = await setup(); assert.ok(has(c.run({ body: `序文\n${c.offer.disclosure.text}` }), 'disclosure-missing-or-misplaced')); });
test('CTA一致info', async () => { const c = await setup(); assert.ok(has(c.run(), 'cta-text-match', 'info')); });
test('CTA不一致warning・block推測なし', async () => { const c = await setup(); const r = c.run({ cta: `${c.offer.disclosure.text}今すぐ有料契約してください` }); assert.ok(has(r, 'cta-review', 'warning')); assert.ok(!r.findings.some(f => f.field === 'cta' && f.severity === 'block')); });
test('固定revision再抽出・最新endedへ追従しない', async () => { const c = await setup(); const latest = structuredClone(c.offer); latest.revision = 2; latest.status = 'ended'; latest.facts[0].text = '総額999円です。'; const snapshot = await loadAffiliateEvidence(c.affiliateContext, { history: async () => [c.offer, latest] }); assert.deepEqual(snapshot, c.affiliateContext.snapshot); assert.ok(has(c.run({}, latest), 'evidence-mismatch', 'block')); });
test('snapshot不整合は検出', async () => { const c = await setup(); c.affiliateContext.snapshot.facts[0] = '総額999円です。'; c.affiliateContext.contextHash = contextHash(c.affiliateContext.snapshot); assert.ok(has(c.run(), 'evidence-mismatch', 'block')); await assert.rejects(loadAffiliateEvidence(c.affiliateContext, c.store), /一致|確認/); });
test('context自身のhash不整合を拒否', async () => { const c = await setup(); c.affiliateContext.snapshot.facts[0] = '変更'; assert.throws(() => c.run(), /安全/); });
for (const [name, overrides] of [['reward', { category: 'reward' }], ['internal_only', { usage: 'internal_only' }], ['constraint_only', { usage: 'constraint_only' }], ['unverified', { verification: 'unverified' }], ['editor', { origin: 'editor' }]]) {
  test(`${name}は事実根拠にしない`, async () => { const c = await setup(); c.offer.facts.push(c.stmt('excluded', '価格999円です。', overrides)); const r = c.run({ summary: '価格999円です。' }); assert.ok(has(r, 'unregistered-numeric-candidate')); assert.ok(!has(r, 'evidence-mismatch')); });
}
test('別conversionは根拠にしない', async () => { const c = await setup(); c.offer.conversions[1].eligibility[0].text = '参加者999人です。'; c.offer.conversions[1].eligibility[0].usage = 'publishable'; assert.ok(has(c.run({ summary: '参加者999人です。' }), 'unregistered-numeric-candidate')); });
test('findingsへURL・secret・内部情報・抜粋を出さない', async () => { const c = await setup(); const r = c.run({ summary: `password=SYNTHETIC_SECRET ${c.offer.conversions[0].affiliateUrl} 999円です。` }); const s = JSON.stringify(r.findings); for (const v of ['SYNTHETIC_SECRET', 'https:', 'reward', 'internal_only', 'test-asp', '999円']) assert.ok(!s.includes(v)); });
test('contentHashキー順安定・内容変更検出', async () => { const c = await setup(); assert.equal(contentHash(c.content), contentHash(Object.fromEntries(Object.entries(c.content).reverse()))); assert.notEqual(contentHash(c.content), contentHash({ ...c.content, summary: '変更' })); });
test('affiliateContextHash安定・選定理由を含めない', async () => { const c = await setup(); assert.equal(affiliateContextHash(c.affiliateContext), affiliateContextHash({ ...Object.fromEntries(Object.entries(c.affiliateContext).reverse()), selectionReason: '別の理由' })); });
test('affiliateContextHash revision・conversion・snapshot変更検出', async () => { const c = await setup(); for (const update of [{ offerRevision: 2 }, { conversionId: 'contract' }, { snapshot: { ...c.affiliateContext.snapshot, facts: ['別の事実'] } }]) { const context = { ...c.affiliateContext, ...update }; context.contextHash = contextHash(context.snapshot); assert.notEqual(affiliateContextHash(context), affiliateContextHash(c.affiliateContext)); } });
test('offerなし互換性', async () => { const c = await setup(); const r = validateAffiliateContent({ content: c.content, checkedAt }); assert.deepEqual(r.findings, []); assert.equal(r.affiliateContextHash, null); });
test('不正日時は拒否', async () => { const c = await setup(); assert.throws(() => validateAffiliateContent({ content: c.content, checkedAt: 'invalid' }), /日時/); });
test('外向き通信なし', async () => { const guard = await import('./helpers/network-guard.js'); const before = guard.blockedConnections.length; const c = await setup(); c.run(); await loadAffiliateEvidence(c.affiliateContext, c.store); assert.equal(guard.blockedConnections.length, before); });
