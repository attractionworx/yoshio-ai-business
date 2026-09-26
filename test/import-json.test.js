import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseImport } from '../lib/content.js';
import { createApp } from '../server.js';

const originalRaw = await readFile(new URL('./fixtures/codex-note-response.json', import.meta.url), 'utf8');
const wrappedRaw = await readFile(new URL('./fixtures/codex-pasted-wrapped.txt', import.meta.url), 'utf8');
const original = JSON.parse(originalRaw);
const { planId } = original;

test('架空の長文回答で、コピー時の102か所の折り返しを再現', () => {
  assert.throws(() => JSON.parse(wrappedRaw), /control character/);
  assert.deepEqual(parseImport(originalRaw, planId).content, original.content);
  const parsed = parseImport(wrappedRaw, planId);
  assert.equal(parsed.normalization.count, 102);
  assert.deepEqual(parsed.content, original.content);
  assert.deepEqual(parseImport(wrappedRaw.replaceAll('\n', '\r\n'), planId).content, original.content);
});

test('前後の説明、コードブロック、BOM付き回答を1件だけ安全に抽出', () => {
  for (const input of [originalRaw, '\uFEFF' + originalRaw, '以下のJSONです。\n' + originalRaw + '\n以上です。', '回答です。\n```json\n' + originalRaw + '\n```\nご確認ください。', '```JSON\r\n' + originalRaw + '\r\n```', '説明\n```json\n' + wrappedRaw + '\n```\n終わり']) {
    assert.deepEqual(parseImport(input, planId).content, original.content);
  }
  const special = { ...original, content: { ...original.content, body: '括弧 { } [ ]、引用符 " 、パス C:\\work、段落\n次の段落、文字列としての\\n、```json' } };
  assert.deepEqual(parseImport('説明\n' + JSON.stringify(special) + '\n以上', planId).content, special.content);
});

const invalidInputs = [
  ['切れた回答', originalRaw.slice(0, -10)],
  ['重複回答', originalRaw + '\n' + originalRaw],
  ['配列', '[' + originalRaw + ']'],
  ['JSON文字列', JSON.stringify(originalRaw)],
  ['スマート引用符', originalRaw.replaceAll('"', '“')],
  ['末尾カンマ', originalRaw.replace('"generatedAt": null,', '"generatedAt": null,,')],
  ['引用符欠落', originalRaw.replace('"summary": "', '"summary": ')],
  ['不正なエスケープ', originalRaw.replace('"summary": "', '"summary": "\\q')],
  ['キー重複', originalRaw.replace('"generatedAt": null,', '"generatedAt": null,"generatedAt": null,')],
  ['エスケープされたキーの重複', originalRaw.replace('"generatedAt": null,', '"generatedAt": null,"generated\\u0041t": null,')],
  ['キー欠落', JSON.stringify({ ...original, content: { ...original.content, body: undefined } })],
  ['違う企画ID', originalRaw.replace(planId, 'wrong')],
  ['多すぎる文字', ' '.repeat(400001)],
  ['深すぎる入れ子', '{"x":'.repeat(65) + '0' + '}'.repeat(65)],
  ['閉じ括弧余分', originalRaw + '}'],
  ['末尾の余分なカンマ', originalRaw + ','],
  ['末尾の余分な値', originalRaw + 'null'],
  ['補正しても不正', wrappedRaw.replace('"generatedAt": null,', '"generatedAt": null,,')],
];
for (const [name, raw] of invalidInputs) test(`不正な入力は拒否：${name}`, () => assert.throws(() => parseImport(raw, planId), { status: 400 }));

test('HTTP: 補正プレビューは未保存、確認後のみ保存、原文保持、不正入力は保存ゼロ', async t => {
  await mkdir('data/test-runs', { recursive: true });
  const directory = await mkdtemp(path.resolve('data/test-runs/import-'));
  const server = createApp({ dataDirectory: directory });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, value) => fetch(base + route, { method: 'POST', body: new URLSearchParams(value), headers: { Origin: base }, redirect: 'manual' });
  const created = await post('/plans', { theme: '架空の資料整理テスト', medium: 'note' });
  const planPath = created.headers.get('location');
  const actualPlanId = planPath.split('/').at(-1);
  const raw = '生成した回答です。\n```json\n' + wrappedRaw.replace(planId, actualPlanId) + '\n```\n以上です。';
  const count = async () => { try { return (await readdir(path.join(directory, 'drafts'))).filter(n => n.endsWith('.json')).length; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };
  const preview = await post(planPath + '/drafts', { result: raw });
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.ok(html.includes('まだ保存していません'));
  assert.ok(html.includes('102か所'));
  assert.equal(await count(), 0);
  const saved = await post(planPath + '/drafts', { result: raw, confirmWrap: 'yes' });
  assert.equal(saved.status, 303);
  const draftId = saved.headers.get('location').split('/').at(-1);
  const file = path.join(directory, 'drafts', draftId + '.json');
  const before = await readFile(file, 'utf8');
  const draft = JSON.parse(before);
  assert.deepEqual(draft.original, original.content);
  assert.deepEqual(draft.edited, original.content);
  assert.equal(draft.originalRaw, raw);
  assert.equal(draft.status, '未確認');
  assert.equal(draft.importNormalization.count, 102);
  for (const [name, input] of invalidInputs) {
    const response = await post(planPath + '/drafts', { result: input.replaceAll(planId, actualPlanId), confirmWrap: 'yes' });
    assert.equal(response.status, 400, name);
    assert.equal(await count(), 1, name);
  }
  assert.equal(await readFile(file, 'utf8'), before);
  const normal = await post(planPath + '/drafts', { result: '説明\n```json\n' + originalRaw.replace(planId, actualPlanId) + '\n```\n以上です。' });
  assert.equal(normal.status, 303);
  assert.equal(await count(), 2);
});
