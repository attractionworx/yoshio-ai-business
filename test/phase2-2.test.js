import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createDraftStore } from '../lib/drafts.js';
import { PROMPT_VERSION } from '../lib/content.js';
import { publicationData, preflight, preparePublication } from '../lib/publish.js';
import { publishPage } from '../lib/publish-page.js';

// このファイルの文章は検証専用に新規作成した架空データです。
const content = { summary: '架空の紙工作の概要', titles: ['紙の星', '星を折る', '紙を選ぶ', '折り目の工夫', '工作を楽しむ'], readerNeeds: '紙工作を試す', outline: '準備と手順', body: '架空の紙工作の手順を紹介します。', cta: '次は別の色で試しましょう。', social: '紙工作の架空記事です。' };
const draft = { status: '確認済み', edited: content };
const complete = { action: 'ready', titleIndex: '1', experience: 'yes', numbers: 'yes', links: 'yes' };
for (const status of ['未確認', '編集中']) test(`${status}では公開前チェック・公開準備OKを拒否`, () => {
  for (const action of ['check', 'ready']) assert.throws(() => preparePublication({ ...draft, status }, { ...complete, action }), /先に下書きを確認済み/);
});
test('確認済みの公開前チェックと明示的なタイトル選択', () => {
  const result = preparePublication(draft, { ...complete, action: 'check' });
  assert.deepEqual(result.findings, []);
  assert.equal(result.titleIndex, 1);
  assert.ok(result.checkedAt);
  assert.notEqual(result.status, '公開準備OK');
});
for (const [name, text] of [['要確認', 'この手順は要確認です。'], ['仮URL', 'https://example.com/path'], ['編集メモ', '【編集メモ】ここを直す'], ['プレースホルダー', '{{申込URL}}'], ['未確定URL', '案内先：未定']]) test(`${name}を検出し公開準備OKを拒否`, () => {
  const sample = { ...draft, edited: { ...content, body: text } };
  assert.ok(preflight(publicationData(sample, 1)).some(f => f.field === 'body'));
  assert.equal(preparePublication(sample, { ...complete, action: 'check' }).status, '要修正');
  assert.throws(() => preparePublication(sample, complete), /検出された記述/);
});
test('選択タイトル・CTA・SNSも検査し、非公開の概要や未選択タイトルは除外', () => {
  for (const field of ['cta', 'social']) assert.ok(preflight(publicationData({ ...draft, edited: { ...content, [field]: '要確認' } }, 1)).some(f => f.field === field));
  const sample = { ...draft, edited: { ...content, summary: '要確認', titles: ['要確認', ...content.titles.slice(1)] } };
  assert.equal(preflight(publicationData(sample, 1)).length, 0);
  assert.ok(preflight(publicationData(sample, 0)).some(f => f.field === 'title'));
  assert.equal(preflight({ title: '例の使い方', body: 'https://developer.mozilla.org/ 数値の説明と編集方法。', cta: '詳細を確認してください。', social: 'リンクを確認しました。' }).length, 0);
});
test('人間確認は3項目とも必須、文字列true等で代替できない', () => {
  for (const key of ['experience', 'numbers', 'links']) for (const value of [undefined, 'true', 'no']) assert.throws(() => preparePublication(draft, { ...complete, [key]: value }), /人間による最終確認/);
});
test('タイトル未選択・不正選択では承認不可', () => {
  for (const titleIndex of ['', '-1', '5', '1.0', '01', 'undefined']) assert.throws(() => preparePublication(draft, { ...complete, titleIndex }), /タイトルを選択/);
});
test('必要条件を満たした場合のみ公開準備OK、公開用データとCTA込み本文', () => {
  assert.equal(preparePublication(draft, complete).status, '公開準備OK');
  assert.deepEqual(publicationData(draft, 1), { title: content.titles[1], body: content.body, cta: content.cta, social: content.social, bodyWithCta: `${content.body}\n\n${content.cta}` });
});
test('旧ドラフトは未チェック表示、読み取りで変更しない', () => {
  const before = structuredClone(draft);
  assert.match(publishPage(draft, String), /未チェック/);
  assert.deepEqual(draft, before);
});
test('HTTP: 保存・再起動・競合・再編集解除・外部要求拒否・原文と企画保持', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-phase22-'));
  const store = createDraftStore(directory);
  const start = async () => {
    const server = createApp({ dataDirectory: directory });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  let { server, base } = await start();
  const post = (url, values, origin = base) => fetch(base + url, { method: 'POST', body: new URLSearchParams(values), headers: { Origin: origin }, redirect: 'manual' });
  const planResponse = await post('/plans', { theme: '公開準備の架空企画', medium: 'note' });
  const planPath = planResponse.headers.get('location');
  const planId = planPath.split('/').at(-1);
  const planFile = path.join(directory, planId + '.json');
  const planBefore = await readFile(planFile, 'utf8');
  const imported = await post(planPath + '/drafts', { result: JSON.stringify({ planId, promptVersion: PROMPT_VERSION, generatedAt: null, content }) });
  const draftPath = imported.headers.get('location');
  const id = draftPath.split('/').at(-1);
  const route = draftPath + '/publish';
  const before = await store.get(id);
  const savedPath = path.join(directory, 'drafts', id + '.json');
  const legacyBytes = await readFile(savedPath, 'utf8');
  await fetch(base + route);
  assert.equal(await readFile(savedPath, 'utf8'), legacyBytes);
  assert.equal((await post(route, { ...complete, revision: 1 })).status, 400);
  assert.match(await (await fetch(base + route)).text(), /先に下書きを確認済み/);
  await store.update(id, 1, content, 'review');
  assert.equal((await post(route, { action: 'check', titleIndex: '1', revision: 2 })).status, 303);
  let current = await store.get(id);
  assert.equal(current.publication.titleIndex, 1);
  assert.equal(current.publication.status, '要修正');
  assert.equal((await post(route, { ...complete, revision: 2 })).status, 409);
  assert.equal((await post(route, { ...complete, revision: current.revision }, 'https://example.org')).status, 403);
  const concurrent = await Promise.all([post(route, { ...complete, revision: current.revision }), post(route, { ...complete, revision: current.revision })]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [303, 409]);
  current = await store.get(id);
  assert.equal(current.publication.status, '公開準備OK');
  assert.equal(current.status, '確認済み');
  assert.deepEqual(current.original, before.original);
  assert.equal(current.originalRaw, before.originalRaw);
  assert.equal(await readFile(planFile, 'utf8'), planBefore);
  await new Promise(resolve => server.close(resolve));
  ({ server, base } = await start());
  assert.match(await (await fetch(base + route)).text(), /<strong id="publish-status">公開準備OK/);
  // 同じ本文の保存は承認を保持。本文を変えたら選択・機械検査・人間確認を破棄。
  current = await store.update(id, current.revision, content, 'save');
  assert.equal(current.publication.status, '公開準備OK');
  current = await store.update(id, current.revision, { ...content, body: '変更した架空本文。' }, 'save');
  assert.equal(current.publication, undefined);
  assert.equal(current.status, '編集中');
  assert.equal((await post(route, { ...complete, revision: current.revision })).status, 400);
  assert.equal((await fetch(base + draftPath)).status, 200);
});

test('承認済みでも保存エラー画面ではコピーを停止する', () => {
  const html = publishPage({ ...draft, publication: preparePublication(draft, complete) }, String, '人間確認が不足しています。');
  assert.match(html, /未チェック（保存エラー）/);
  assert.equal((html.match(/data-publication-copy="[^"]+" disabled/g) || []).length, 4);
});
test('本文以外のタイトル・CTA・SNS等の変更でも承認と人間確認を解除する', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-publish-reset-'));
  const store = createDraftStore(directory);
  const plan = { id: '22222222-2222-4222-8222-222222222222' }; // 架空の固定ID
  for (const field of Object.keys(content)) {
    let current = await store.create(plan, { generatedAt: null, content }, '架空の回答', '架空の依頼');
    current = await store.update(current.id, current.revision, content, 'review');
    current = await store.update(current.id, current.revision, complete, 'publish');
    const edited = { ...content, [field]: field === 'titles' ? content.titles.map(t => t + '改') : content[field] + '変更' };
    current = await store.update(current.id, current.revision, edited, 'save');
    assert.equal(current.publication, undefined);
    assert.equal(current.status, '編集中');
    assert.deepEqual(current.original, content);
  }
});
