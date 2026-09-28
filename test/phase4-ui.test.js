import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { createOfferStore } from '../lib/offers/store.js';
import { newOfferInput, businessProperties, resolveRule, emptyValue, parseOfferForm } from '../lib/offers/form.js';

function draft() { return { ...newOfferInput(), name: '架空の管理画面テスト', advertiserName: '架空広告主', asp: { code: 'demo-asp', programId: 'demo-1' } }; }
function statement(id, usage = 'constraint_only') {
  return { id, category: 'other', text: '架空資料の記載', origin: 'advertiser', sourceIds: ['source-1'], verification: 'source_checked', usage };
}
function active() {
  return { ...draft(), status: 'active', sources: [{ id: 'source-1', kind: 'advertiser_material', label: '架空の資料', publicUrl: null, checkedAt: '2026-09-28T00:00:00Z' }],
    facts: [statement('fact', 'publishable')], prohibitedExpressions: [statement('prohibition')], conversions: [{ id: 'consult', name: '架空相談', status: 'active', reward: null,
      eligibility: [statement('eligible')], approvalConditions: [statement('approval')], rejectionConditions: [statement('rejection')], affiliateUrl: 'https://example.test/affiliate', ctaLabel: statement('cta', 'publishable') }] };
}
function fields(input, id = '', revision) {
  const result = new URLSearchParams({ id });
  if (revision !== undefined) result.set('revision', String(revision));
  function add(original, value, key) {
    const rule = resolveRule(original);
    if (rule.oneOf) {
      const child = resolveRule(rule.oneOf.find(r => r.type !== 'null'));
      if (child.type === 'object') { result.set(`${key}.__present`, value === null ? 'null' : 'value'); add(child, value ?? emptyValue(child), key); }
      else add(child, value ?? '', key);
    } else if (rule.type === 'object') {
      for (const [name, child] of Object.entries(rule.properties)) add(child, value[name], `${key}.${name}`);
    } else if (rule.type === 'array') {
      result.set(`${key}.__array`, '1'); value.forEach((item, i) => add(rule.items, item, `${key}.${i}`));
    } else result.set(key, String(value));
  }
  for (const [name, rule] of Object.entries(businessProperties)) add(rule, input[name], `offer.${name}`);
  return result;
}
async function app(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-phase4-ui-'));
  const server = createApp({ dataDirectory: directory });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { directory, base, store: createOfferStore(directory), get: route => fetch(base + route),
    post: (route, body, headers = { Origin: base }) => fetch(base + route, { method: 'POST', body, headers, redirect: 'manual' }) };
}

test('UI: 空の案件一覧・新規フォーム・既存トップからの導線・静的JS', async t => {
  const c = await app(t);
  assert.match(await (await c.get('/')).text(), /href="\/offers"/);
  assert.match(await (await c.get('/offers')).text(), /登録済み案件はありません/);
  const response = await c.get('/offers/new');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await response.text();
  for (const field of ['offer.name', 'offer.advertiserName', 'offer.asp.code', 'offer.status', 'offer.validFrom', 'offer.validUntil', 'offer.reviewDueAt', 'offer.sources.__array', 'offer.facts.__array', 'offer.targetAudience.__array', 'offer.sellingPoints.__array', 'offer.prohibitedExpressions.__array', 'offer.conversions.__array', 'offer.disclosure.text']) assert.ok(html.includes(`name="${field}"`), field);
  assert.match(html, /未確認（公開記事の根拠に使えません）/);
  assert.match(html, /internal_only/);
  assert.match(html, /data-add-item/);
  assert.equal((await c.get('/offers.js')).status, 200);
  assert.deepEqual(await c.store.list(), []);
});

test('UI: ブラウザ形式で新規登録→一覧→詳細→編集→revision履歴', async t => {
  const c = await app(t);
  const value = active(); value.status = 'draft'; value.facts[0].verification = 'unverified';
  const saved = await c.post('/offers', fields(value));
  assert.equal(saved.status, 303);
  const location = saved.headers.get('location');
  const offer = (await c.store.list())[0];
  assert.equal(location, `/offers/${offer.id}`);
  const list = await (await c.get('/offers')).text();
  for (const value of [offer.name, offer.advertiserName, offer.asp.code, offer.updatedAt, 'revision：1']) assert.ok(list.includes(value));
  const detail = await (await c.get(location)).text();
  for (const value of ['架空の資料', 'unverified', 'publishable', '架空相談', 'アフィリエイトリンク']) assert.ok(detail.includes(value));
  assert.match(await (await c.get(`${location}/edit`)).text(), /value="unverified" selected/);
  const changed = { ...value, name: '編集した架空案件', status: 'paused' };
  assert.equal((await c.post(`${location}/edit`, fields(changed, offer.id, 1))).status, 303);
  const history = await c.store.history(offer.id);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], offer);
  assert.equal(history[1].name, changed.name);
  assert.equal(history[1].facts[0].verification, 'unverified');
  assert.match(await (await c.get(`${location}/revisions/1`)).text(), /過去revisionの閲覧/);
  assert.equal((await c.get(`${location}/revisions/99`)).status, 404);
});

test('UI: 任意の案件ID・重複拒否・編集時ID改ざん拒否', async t => {
  const c = await app(t); const id = randomUUID();
  assert.equal((await c.post('/offers', fields(draft(), id))).status, 303);
  assert.equal((await c.post('/offers', fields(draft(), id))).status, 409);
  assert.equal((await c.post(`/offers/${id}/edit`, fields(draft(), randomUUID(), 1))).status, 400);
  assert.equal((await c.store.history(id)).length, 1);
});

test('UI: 全statusの変更とactive化のサーバー検証', async t => {
  const c = await app(t); const first = await c.store.create(draft());
  const url = `/offers/${first.id}/edit`;
  assert.equal((await c.post(url, fields({ ...draft(), status: 'active' }, first.id, 1))).status, 400);
  assert.equal((await c.store.get(first.id)).revision, 1);
  for (const [index, status] of ['active', 'paused', 'ended', 'draft'].entries()) {
    assert.equal((await c.post(url, fields({ ...active(), status }, first.id, index + 1))).status, 303);
  }
  assert.deepEqual((await c.store.history(first.id)).map(o => o.status), ['draft', 'active', 'paused', 'ended', 'draft']);
});

test('UI: 古いrevisionは409で過去版・最新版を変更しない', async t => {
  const c = await app(t); const first = await c.store.create(draft());
  const url = `/offers/${first.id}/edit`;
  assert.equal((await c.post(url, fields(draft(), first.id, 1))).status, 303);
  const before = await c.store.history(first.id);
  assert.equal((await c.post(url, fields({ ...draft(), name: '競合' }, first.id, 1))).status, 409);
  assert.deepEqual(await c.store.history(first.id), before);
});

test('UI: 不正な日時・出典参照・確認状態・未知のネスト項目を拒否', async t => {
  const c = await app(t);
  for (const [key, value] of [['offer.validFrom', '2026-02-30T00:00:00Z'], ['offer.facts.0.sourceIds.0', 'missing'], ['offer.facts.0.verification', 'approved'], ['offer.facts.0.extra', 'unknown'], ['offer.conversions.0.reward.extra', 'unknown'], ['offer.status', 'published'], ['offer.schemaVersion', '999'], ['extra', 'unknown']]) {
    const body = fields(active()); body.set(key, value);
    assert.equal((await c.post('/offers', body)).status, 400, key);
  }
  const duplicate = fields(draft()); duplicate.append('offer.name', 'duplicate');
  assert.equal((await c.post('/offers', duplicate)).status, 400);
  const missing = fields(draft()); missing.delete('offer.sources.__array');
  assert.equal((await c.post('/offers', missing)).status, 400);
  assert.deepEqual(await c.store.list(), []);
});

test('UI: 秘密情報は保存・画面・ログへ出さず、更新履歴も増やさない', async t => {
  const c = await app(t); const first = await c.store.create(draft());
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
  for (const secret of ['sk-private123456789', 'Cookie: session=private-sentinel', 'password=private-sentinel']) {
    const value = { ...draft(), name: secret };
    for (const [url, body] of [['/offers', fields(value)], [`/offers/${first.id}/edit`, fields(value, first.id, 1)]]) {
      const response = await c.post(url, body);
      assert.equal(response.status, 400);
      assert.ok(!(await response.text()).includes(secret));
    }
  }
  assert.deepEqual(logs, []);
  assert.equal((await c.store.history(first.id)).length, 1);
  const raw = await readFile(path.join(c.directory, 'offers', `${first.id}.json`), 'utf8');
  assert.ok(!raw.includes('private'));
});

test('UI: 保存済みファイルへの秘密混入も表示せず停止', async t => {
  const c = await app(t); const first = await c.store.create(draft());
  const filename = path.join(c.directory, 'offers', `${first.id}.json`);
  const record = JSON.parse(await readFile(filename, 'utf8')); record.revisions[0].name = 'password=private-sentinel';
  await writeFile(filename, JSON.stringify(record));
  for (const url of ['/offers', `/offers/${first.id}`, `/offers/${first.id}/edit`]) {
    const response = await c.get(url); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private-sentinel'));
  }
});

test('UI: HTMLエスケープ・外部リンクの非取得・出典の非自動確認', async t => {
  const c = await app(t); const value = active(); value.status = 'draft';
  value.name = '<img src=x onerror=alert(1)>'; value.facts[0].text = '</textarea><script>alert(1)</script>';
  value.facts[0].verification = 'unverified';
  value.sources[0].publicUrl = 'https://example.test/evidence';
  const response = await c.post('/offers', fields(value)); assert.equal(response.status, 303);
  const location = response.headers.get('location');
  for (const url of ['/offers', location, `${location}/edit`]) {
    const html = await (await c.get(url)).text(); assert.ok(!html.includes('<img src=x')); assert.ok(!html.includes('<script>alert(1)'));
  }
  assert.equal((await c.store.list())[0].facts[0].verification, 'unverified');
});

test('UI: Origin必須・外部送信元・異なるContent-Type・大きすぎる入力を拒否', async t => {
  const c = await app(t);
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://example.test' }, { Origin: c.base, 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await c.post('/offers', fields(draft()), headers)).status, 403);
  assert.equal((await c.post('/offers', '{}', { Origin: c.base, 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await c.post('/offers', new URLSearchParams({ large: 'x'.repeat(2_000_001) }))).status, 413);
  assert.deepEqual(await c.store.list(), []);
});

test('UI: フォームの全項目を往復し、配列の削除後の欠番を保持できる', () => {
  const value = active();
  value.conversions[0].reward = { kind: 'fixed', value: 120, currency: 'JPY', evidence: statement('reward', 'internal_only') };
  value.targetAudience = [statement('audience', 'publishable')]; value.sellingPoints = [statement('selling', 'publishable')];
  assert.deepEqual(parseOfferForm(fields(value)).input, value);
  const body = fields(value);
  for (const [key, val] of [...body]) if (key.startsWith('offer.facts.0.')) { body.delete(key); body.set(key.replace('offer.facts.0.', 'offer.facts.3.'), val); }
  assert.deepEqual(parseOfferForm(body).input, value);
});

test('UI: 閲覧GETは保存しない・既存企画を変更しない・生成台帳を作らない', async t => {
  const c = await app(t); const legacy = path.join(c.directory, `${randomUUID()}.json`);
  const raw = JSON.stringify({ id: path.basename(legacy, '.json'), createdAt: '2026-01-01T00:00:00Z', theme: '旧企画', medium: 'note', audience: '', purpose: '', notes: '' });
  await writeFile(legacy, raw);
  const first = await c.store.create(draft());
  for (const url of ['/offers', '/offers/new', `/offers/${first.id}`, `/offers/${first.id}/edit`, `/offers/${first.id}/revisions/1`]) assert.equal((await c.get(url)).status, 200);
  assert.equal((await c.store.history(first.id)).length, 1);
  assert.equal(await readFile(legacy, 'utf8'), raw);
  assert.ok(!(await readdir(c.directory)).includes('generations'));
});
