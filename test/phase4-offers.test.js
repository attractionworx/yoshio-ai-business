import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateOffer, getUsableStatements } from '../lib/offers/validation.js';
import { createOfferStore } from '../lib/offers/store.js';

const timestamp = '2026-09-28T00:00:00.000Z';
function statement(id, overrides = {}) {
  return { id, category: 'feature', text: '架空の検証資料の記載', origin: 'advertiser', sourceIds: ['source-1'], verification: 'source_checked', usage: 'publishable', ...overrides };
}
function conversion(id) {
  return { id, name: '架空の無料相談', status: 'active', reward: {
    kind: 'fixed', value: 100, currency: 'JPY', evidence: statement(`${id}-reward`, { category: 'reward', usage: 'internal_only' }),
  }, eligibility: [statement(`${id}-eligibility`, { category: 'eligibility', usage: 'constraint_only' })],
  approvalConditions: [statement(`${id}-approval`, { category: 'approval', usage: 'constraint_only' })],
  rejectionConditions: [statement(`${id}-rejection`, { category: 'rejection', usage: 'constraint_only' })],
  affiliateUrl: 'https://affiliate.example.test/visit?program=demo', ctaLabel: statement(`${id}-cta`, { text: '架空の相談を申し込む' }) };
}
function input() {
  return { name: '架空案件・実際の案件ではありません', advertiserName: null, asp: { code: 'test-asp', programId: null }, status: 'active',
    validFrom: null, validUntil: null, reviewDueAt: null,
    sources: [{ id: 'source-1', kind: 'advertiser_material', label: '架空の条件資料', publicUrl: null, checkedAt: timestamp }],
    facts: [statement('fact-1'), statement('fact-unverified', { verification: 'unverified', text: '未確認の料金' }), statement('fact-internal', { usage: 'internal_only' })],
    targetAudience: [statement('audience', { category: 'audience' })], sellingPoints: [],
    prohibitedExpressions: [statement('prohibition', { category: 'prohibition', usage: 'constraint_only', text: '必ず成功するとの表現は禁止' })],
    conversions: [conversion('consultation'), conversion('contract')],
    disclosure: { required: true, text: '広告：アフィリエイトリンクを含みます。', placements: ['bodyStart', 'social'] } };
}
const complete = () => ({ ...input(), schemaVersion: 1, id: randomUUID(), revision: 1, createdAt: timestamp, updatedAt: timestamp });
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-phase4-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: createOfferStore(directory, { now: () => new Date(timestamp) }) };
}

test('案件登録・複数成果地点・revision履歴・再起動・停止・既存データの非変更', async t => {
  const { directory, store } = await setup(t);
  const legacy = path.join(directory, `${randomUUID()}.json`);
  const original = '{"theme":"Phase 3の既存企画"}\n';
  await writeFile(legacy, original);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await readdir(directory), [path.basename(legacy)]);
  const payload = input();
  const first = await store.create(payload);
  payload.name = '入力後の変更';
  assert.equal(first.revision, 1);
  assert.equal(first.conversions.length, 2);
  assert.equal((await stat(path.join(directory, 'offers', `${first.id}.json`))).mode & 0o777, 0o600);
  for (const [index, status] of ['paused', 'ended', 'draft', 'active'].entries()) {
    const saved = await store.update(first.id, index + 1, { ...input(), status });
    assert.equal(saved.revision, index + 2);
    assert.equal(saved.status, status);
  }
  const restarted = createOfferStore(directory);
  const history = await restarted.history(first.id);
  assert.deepEqual(history.map(item => item.revision), [1, 2, 3, 4, 5]);
  assert.deepEqual(history.map(item => item.status), ['active', 'paused', 'ended', 'draft', 'active']);
  assert.deepEqual(history[0], first);
  history[0].facts[0].text = '返却値の変更';
  assert.deepEqual((await restarted.history(first.id))[0], first);
  assert.equal((await restarted.list()).length, 1);
  assert.equal((await restarted.get(first.id)).revision, 5);
  assert.equal(await readFile(legacy, 'utf8'), original);
});

test('未確認・内部情報・他成果地点・停止・期間外は利用根拠から除外', () => {
  const offer = complete();
  const result = getUsableStatements(offer, 'consultation', new Date(timestamp));
  assert.deepEqual(result.publishable.map(s => s.id), ['fact-1', 'audience', 'consultation-cta']);
  assert.deepEqual(result.constraints.map(s => s.id), ['prohibition', 'consultation-eligibility', 'consultation-approval', 'consultation-rejection']);
  result.publishable[0].text = '変更';
  assert.notEqual(offer.facts[0].text, '変更');
  for (const overrides of [{ status: 'draft' }, { status: 'paused' }, { status: 'ended' }, { validFrom: '2027-01-01T00:00:00Z' }, { validUntil: timestamp }, { reviewDueAt: timestamp }]) {
    assert.deepEqual(getUsableStatements({ ...offer, ...overrides }, 'consultation', new Date(timestamp)), { publishable: [], constraints: [] });
  }
  offer.conversions[0].status = 'paused';
  assert.deepEqual(getUsableStatements(offer, 'consultation', new Date(timestamp)), { publishable: [], constraints: [] });
  assert.deepEqual(getUsableStatements(offer, 'missing', new Date(timestamp)), { publishable: [], constraints: [] });
});

test('draftは空条件を保存できるがactiveにできず、明示的な出典付き条件なしは保存可能', () => {
  const offer = complete();
  offer.status = 'draft';
  offer.conversions.forEach(c => { c.status = 'draft'; c.rejectionConditions = []; });
  assert.deepEqual(validateOffer(offer).conversions[0].rejectionConditions, []);
  offer.status = 'active';
  assert.throws(() => validateOffer(offer));
  offer.conversions[0].status = 'active';
  assert.throws(() => validateOffer(offer));
  offer.conversions[0].rejectionConditions = [statement('explicit-none', { text: '資料に追加の否認条件なしと明記', category: 'rejection', usage: 'constraint_only' })];
  assert.doesNotThrow(() => validateOffer(offer));
});

const invalidCases = [
  ['出典ID重複', o => o.sources.push({ ...o.sources[0] })],
  ['statement ID重複', o => o.sellingPoints.push({ ...o.facts[0] })],
  ['成果地点ID重複', o => { o.conversions[1].id = o.conversions[0].id; }],
  ['存在しないsource', o => { o.facts[0].sourceIds = ['missing']; }],
  ['未確認statementも不正参照を拒否', o => { o.facts[1].sourceIds = ['missing']; }],
  ['確認済みの出典なし', o => { o.facts[0].sourceIds = []; }],
  ['source未確認', o => { o.sources[0].checkedAt = null; }],
  ['空の成果条件', o => { o.conversions[0].approvalConditions = []; }],
  ['未確認の否認条件', o => { o.conversions[0].rejectionConditions[0].verification = 'unverified'; }],
  ['内部専用の適用条件', o => { o.conversions[0].eligibility[0].usage = 'internal_only'; }],
  ['未確認CTA', o => { o.conversions[0].ctaLabel.verification = 'unverified'; }],
  ['空の禁止条件', o => { o.prohibitedExpressions = []; }],
  ['未知のトップ項目', o => { o.apiKey = 'dummy'; }],
  ['未知のネスト項目', o => { o.facts[0].extra = true; }],
  ['不正な状態', o => { o.status = 'published'; }],
  ['不正なusage', o => { o.facts[0].usage = 'public'; }],
  ['不正なrevision', o => { o.revision = 1.5; }],
  ['不正なUUID', o => { o.id = '../private'; }],
  ['実在しない日付', o => { o.sources[0].checkedAt = '2026-02-30T00:00:00Z'; }],
  ['平年の2月29日', o => { o.updatedAt = '2027-02-29T00:00:00Z'; }],
  ['時差なし日時', o => { o.createdAt = '2026-09-28T00:00:00'; }],
  ['不正な時刻', o => { o.createdAt = '2026-09-28T24:00:00Z'; }],
  ['日時逆転', o => { o.updatedAt = '2025-01-01T00:00:00Z'; }],
  ['有効期間逆転', o => { o.validFrom = '2027-01-01T00:00:00Z'; o.validUntil = timestamp; }],
  ['公開用の報酬', o => { o.conversions[0].reward.evidence.usage = 'publishable'; }],
  ['不正な割合', o => { o.conversions[0].reward = { ...o.conversions[0].reward, kind: 'percentage', value: 101, currency: null }; }],
  ['負の報酬', o => { o.conversions[0].reward.value = -1; }],
  ['非数の報酬', o => { o.conversions[0].reward.value = NaN; }],
  ['広告明示解除', o => { o.disclosure.required = false; }],
  ['広告明示位置なし', o => { o.disclosure.placements = []; }],
  ['危険なURL方式', o => { o.conversions[0].affiliateUrl = 'javascript:alert(1)'; }],
];
for (const [label, change] of invalidCases) test(`案件検証拒否: ${label}`, () => {
  const offer = complete(); change(offer);
  assert.throws(() => validateOffer(offer), { status: 400 });
});

test('うるう年・時差付き日時・確認前の出典は正しく扱う', () => {
  const offer = complete();
  offer.sources.push({ id: 'unreviewed-source', kind: 'user_provided', label: '確認待ち', publicUrl: 'https://example.test/info', checkedAt: null });
  offer.facts[1].sourceIds = ['unreviewed-source'];
  offer.sources[0].checkedAt = '2024-02-29T09:00:00+09:00';
  assert.doesNotThrow(() => validateOffer(offer));
});

test('秘密情報は新規・更新とも拒否し、値を保存・エラーへ露出しない', async t => {
  const { directory, store } = await setup(t);
  const saved = await store.create(input());
  const filename = path.join(directory, 'offers', `${saved.id}.json`);
  const before = await readFile(filename, 'utf8');
  for (const secret of ['sk-testsecret123456789', 'API_KEY=private-sentinel', 'Cookie: session=private-sentinel', 'password: private-sentinel', '{"password":"private-sentinel"}', 'パスワード：private-sentinel', 'Bearer private-sentinel', 'https://user:private-sentinel@example.test/', 'https://example.test/?access%5Ftoken=private-sentinel', 'https://example.test/#session=private-sentinel']) {
    const payload = input(); payload.facts[0].text = secret;
    for (const operation of [() => store.create(payload), () => store.update(saved.id, 1, payload)]) {
      await assert.rejects(operation, error => error.status === 400 && !error.message.includes(secret) && !error.message.includes('private-sentinel'));
    }
    assert.equal(await readFile(filename, 'utf8'), before);
  }
  assert.deepEqual(await readdir(path.join(directory, 'offers')), [`${saved.id}.json`]);
});

test('重複ID・古いrevision・並行更新・管理項目上書きを拒否', async t => {
  const { store } = await setup(t);
  const saved = await store.create(input());
  await assert.rejects(() => store.create(input(), { id: saved.id }), { status: 409 });
  await assert.rejects(() => store.create({ ...input(), revision: 999 }), { status: 400 });
  await assert.rejects(() => store.update(saved.id, 1, { ...input(), createdAt: timestamp }), { status: 400 });
  const results = await Promise.allSettled([store.update(saved.id, 1, { ...input(), status: 'paused' }), store.update(saved.id, 1, { ...input(), status: 'ended' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal((await store.history(saved.id)).length, 2);
  await assert.rejects(() => store.get('../secret'), { status: 400 });
});

test('別ストアの同時更新と残存ロックは上書きせず停止', async t => {
  const { directory, store } = await setup(t);
  const saved = await store.create(input());
  const other = createOfferStore(directory, { now: () => new Date(timestamp) });
  const results = await Promise.allSettled([store.update(saved.id, 1, input()), other.update(saved.id, 1, input())]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await mkdir(path.join(directory, 'offers', '.lock'));
  await assert.rejects(() => other.update(saved.id, 2, input()), { status: 409 });
  assert.equal((await store.get(saved.id)).revision, 2);
});

test('破損履歴・revision欠落を拒否し、新規登録で上書きしない', async t => {
  const { directory, store } = await setup(t);
  const saved = await store.create(input());
  const filename = path.join(directory, 'offers', `${saved.id}.json`);
  for (const raw of ['{broken', JSON.stringify({ schemaVersion: 1, revisions: [{ ...saved, revision: 2 }] })]) {
    await writeFile(filename, raw);
    await assert.rejects(() => store.get(saved.id), { status: 503 });
    await assert.rejects(() => store.list(), { status: 503 });
    await assert.rejects(() => store.update(saved.id, 1, input()), { status: 503 });
    await assert.rejects(() => store.create(input(), { id: saved.id }), { status: 503 });
    assert.equal(await readFile(filename, 'utf8'), raw);
  }
});

test('不正IDはディレクトリ作成前に拒否し、その後の正常登録を妨げない', async t => {
  const { directory, store } = await setup(t);
  const id = randomUUID();
  await assert.rejects(() => store.create(input(), { id: '../invalid' }), { status: 400 });
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await store.create(input(), { id })).revision, 1);
});
