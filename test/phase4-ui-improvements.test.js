import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createOfferStore } from '../lib/offers/store.js';
import { validateOffer } from '../lib/offers/validation.js';
import { parseOfferForm, newOfferInput } from '../lib/offers/form.js';
import { toJapanInput, fromJapanInput, activeFindings } from '../lib/offers/ui-guidance.js';
import { nextInternalId, sourceChoices } from '../public/offer-helpers.js';

const statement = (id = 'existing-fact') => ({ id, text: '架空の情報', category: 'feature', origin: 'advertiser', sourceIds: ['existing-source'], verification: 'unverified', usage: 'publishable' });
function draft() {
  return { ...newOfferInput(), name: 'UI改善の架空案件', asp: { code: 'test-asp', programId: null }, sources: [{ id: 'existing-source', label: '架空の案件詳細ページ', kind: 'asp_material', publicUrl: null, checkedAt: null }], facts: [statement()] };
}
function fields(input, id = '', revision) {
  const result = new URLSearchParams({ id, timeZone: 'Asia/Tokyo' });
  if (revision) result.set('revision', String(revision));
  function add(value, prefix) {
    if (Array.isArray(value)) { result.set(`${prefix}.__array`, '1'); value.forEach((item, index) => add(item, `${prefix}.${index}`)); }
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) add(child, `${prefix}.${key}`);
    else result.set(prefix, value === null ? '' : String(value));
  }
  add(input, 'offer'); return result;
}
async function app(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'phase4-ui-improvements-'));
  const server = createApp({ dataDirectory: directory });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store: createOfferStore(directory), get: url => fetch(base + url), post: (url, body) => fetch(base + url, { method: 'POST', headers: { Origin: base }, body, redirect: 'manual' }) };
}

test('UI改善: 内部IDは安全な形式で種類別に生成し、衝突時は再生成する', () => {
  const used = new Set();
  for (const [field, prefix] of [['sources', 'source'], ['facts', 'statement'], ['targetAudience', 'statement'], ['sellingPoints', 'statement'], ['prohibitedExpressions', 'statement'], ['conversions', 'conversion'], ['conversions.0.approvalConditions', 'statement']]) {
    const id = nextInternalId(`offer.${field}.0.id`, used, randomUUID);
    assert.match(id, new RegExp(`^${prefix}-[a-f0-9-]{36}$`));
    assert.ok(id.length <= 80);
  }
  const duplicate = randomUUID(); used.add(`source-${duplicate}`); let attempts = 0;
  const id = nextInternalId('offer.sources.0.id', used, () => attempts++ === 0 ? duplicate : randomUUID());
  assert.notEqual(id, `source-${duplicate}`); assert.equal(attempts, 2);
});

test('UI改善: 出典選択は資料名とIDを表示し、削除済み参照を勝手に置換しない', () => {
  assert.deepEqual(sourceChoices([{ id: 'source-1', label: 'A8.net テスト案件詳細ページ' }], 'deleted-source'), [
    { value: '', label: '出典を選択してください' }, { value: 'source-1', label: 'A8.net テスト案件詳細ページ（source-1）' }, { value: 'deleted-source', label: '参照先がありません（deleted-source）' },
  ]);
});

test('UI改善: 日時は日本時間で明示変換し、日付境界・秒・ミリ秒・異なるoffsetを保持', () => {
  for (const original of ['2026-09-28T00:00:00Z', '2026-09-28T09:12:34.123+09:00', '2026-12-31T23:59:59.987-05:00']) {
    const local = toJapanInput(original);
    assert.equal(Date.parse(fromJapanInput(local)), Date.parse(original));
  }
  assert.equal(toJapanInput('2026-09-27T23:00:00Z'), '2026-09-28T08:00:00.000');
  assert.equal(fromJapanInput('2026-09-28T09:00'), '2026-09-28T09:00:00+09:00');
  assert.equal(toJapanInput(null), '');
  assert.equal(fromJapanInput('2026-02-30T09:00'), '2026-02-30T09:00:00+09:00');
  const offer = { ...draft(), schemaVersion: 1, id: randomUUID(), revision: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', validFrom: fromJapanInput('2026-02-30T09:00') };
  assert.throws(() => validateOffer(offer), { status: 400 });
});

test('UI改善: 日時変換には明示された日本時間を使い未知のtimeZoneは拒否', () => {
  const input = draft(); input.validFrom = '2026-09-28T09:00';
  assert.equal(parseOfferForm(fields(input)).input.validFrom, '2026-09-28T09:00:00+09:00');
  const bad = fields(input); bad.set('timeZone', 'America/New_York');
  assert.throws(() => parseOfferForm(bad), { status: 400 });
  const legacy = fields(input); legacy.delete('timeZone');
  assert.equal(parseOfferForm(legacy).input.validFrom, input.validFrom); // 後段のStep 1で拒否する。
});

test('UI改善: 保存→出典選択→編集で既存ID・参照・未確認・revisionを維持', async t => {
  const c = await app(t); const first = await c.store.create(draft());
  const html = await (await c.get(`/offers/${first.id}/edit`)).text();
  assert.match(html, /<select[^>]*data-source-ref/);
  assert.match(html, /架空の案件詳細ページ（existing-source）/);
  assert.match(html, /value="existing-source" selected/);
  const next = draft(); next.sources[0].checkedAt = '2026-09-28T09:00';
  assert.equal((await c.post(`/offers/${first.id}/edit`, fields(next, first.id, 1))).status, 303);
  const history = await c.store.history(first.id);
  assert.deepEqual(history[0], first);
  assert.equal(history[1].sources[0].id, first.sources[0].id);
  assert.equal(history[1].facts[0].id, first.facts[0].id);
  assert.deepEqual(history[1].facts[0].sourceIds, ['existing-source']);
  assert.equal(history[1].facts[0].verification, 'unverified');
  assert.equal(history[1].sources[0].checkedAt, '2026-09-28T09:00:00+09:00');
  assert.equal(history[1].revision, 2);
});

test('UI改善: 不足案内は固定文だけでCTA・URL・条件の不足を知らせる', () => {
  const offer = draft(); offer.status = 'active'; offer.name = 'password=private-sentinel';
  offer.conversions = [{ status: 'active', eligibility: [], approvalConditions: [statement()], rejectionConditions: [], ctaLabel: null, affiliateUrl: null }];
  const messages = activeFindings(offer).join('\n');
  for (const text of ['禁止表現が未登録', '成果条件に未確認', 'CTAが未登録', 'アフィリエイトURLが未登録']) assert.ok(messages.includes(text));
  assert.ok(!messages.includes('private-sentinel')); assert.ok(!messages.includes('existing-source')); assert.ok(!messages.includes('架空の情報'));
});

test('UI改善: active化拒否時に不足案内、秘密・unknown field拒否と履歴保持', async t => {
  const c = await app(t); const first = await c.store.create(draft());
  const input = draft(); input.status = 'active'; input.name = 'password=private-sentinel';
  const response = await c.post(`/offers/${first.id}/edit`, fields(input, first.id, 1));
  assert.equal(response.status, 400);
  const html = await response.text(); assert.match(html, /禁止表現が未登録/); assert.ok(!html.includes('private-sentinel'));
  const unknown = fields(draft(), first.id, 1); unknown.set('offer.timeZone', 'Asia/Tokyo');
  assert.equal((await c.post(`/offers/${first.id}/edit`, unknown)).status, 400);
  assert.deepEqual(await c.store.history(first.id), [first]);
});

test('UI改善: JavaScriptなしでもnative折りたたみ・日時・基本登録が使える', async t => {
  const c = await app(t); const response = await c.get('/offers/new'); const html = await response.text();
  assert.match(html, /<details id="offer-section-basic" open>/);
  assert.match(html, /<details id="offer-section-conversions">/);
  assert.match(html, /type="datetime-local"/);
  assert.match(html, /日本時間（UTC\+09:00）/);
  assert.match(html, /有効化する場合に必須/);
  assert.ok(!/data-optional-fields hidden/.test(html));
  const input = newOfferInput(); input.name = 'JSなし基本登録'; input.asp.code = 'test'; input.validFrom = '2026-09-28T09:00';
  assert.equal((await c.post('/offers', fields(input))).status, 303);
  assert.equal((await c.store.list())[0].status, 'draft');
});

test('UI改善: 日本語ラベル化はenumだけに適用し、事実本文を置き換えない', async t => {
  const c = await app(t); const input = draft(); input.facts[0].text = 'source_checked';
  const offer = await c.store.create(input);
  const html = await (await c.get(`/offers/${offer.id}`)).text();
  assert.match(html, /<strong>本文<\/strong><p>source_checked<\/p>/);
  assert.match(html, /未確認（公開記事の根拠に使えません）/);
});
