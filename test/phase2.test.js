import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server.js';
import { buildPrompt, PROMPT_VERSION, contentFields } from '../lib/content.js';

test('Phase 2: 企画→依頼文→取り込み→編集→確認→再編集→再生成・履歴・再起動', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-phase2-'));
  async function start() {
    const server = createApp({ dataDirectory: directory });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  }
  let { server, base } = await start();
  const post = (route, values, headers = {}) => fetch(base + route, { method: 'POST', body: new URLSearchParams(values), headers: { Origin: base, ...headers }, redirect: 'manual' });
  const planValues = { theme: '日本語の企画 <script>alert(1)</script>', audience: '初心者', medium: 'YouTube', purpose: '解説', notes: 'メモ\n2行目' };
  const created = await post('/plans', planValues);
  assert.equal(created.status, 303);
  const planPath = created.headers.get('location');
  const planId = planPath.split('/').at(-1);
  const originalPlan = await readFile(path.join(directory, `${planId}.json`), 'utf8');
  const plan = JSON.parse(originalPlan);
  const prompt = buildPrompt(plan);
  for (const value of ['初心者', 'YouTube', PROMPT_VERSION, planId, 'タイトルは5個']) assert.ok(prompt.includes(value));
  const page = await (await fetch(base + planPath)).text();
  assert.ok(page.includes('依頼文をコピー'));
  assert.ok(!page.includes('<script>alert'));
  assert.equal((await fetch(base + '/app.js')).status, 200);

  const content = { summary: '概要', titles: ['一', '二', '三', '四', '五'], readerNeeds: '悩み', outline: '構成\n2行目', body: '<script>alert(2)</script>\n本文', cta: '次の行動', social: '告知' };
  const payload = { planId, promptVersion: PROMPT_VERSION, generatedAt: '2026-09-26T12:00:00+09:00', content };
  const raw = JSON.stringify(payload);
  const imported = await post(planPath + '/drafts', { result: raw });
  assert.equal(imported.status, 303);
  const draftPath = imported.headers.get('location');
  const draftId = draftPath.split('/').at(-1);
  const stored = () => readFile(path.join(directory, 'drafts', `${draftId}.json`), 'utf8').then(JSON.parse);
  let draft = await stored();
  assert.equal(draft.status, '未確認');
  assert.deepEqual(draft.original, content);
  assert.deepEqual(draft.edited, content);
  assert.equal(draft.originalRaw, raw);
  assert.equal(draft.generatedAt, payload.generatedAt);
  assert.equal(draft.generationMethod, 'codex-manual');
  assert.equal(draft.promptVersion, PROMPT_VERSION);
  assert.equal(draft.prompt, prompt);
  const draftHtml = await (await fetch(base + draftPath)).text();
  assert.ok(draftHtml.includes('&lt;script&gt;'));
  const toForm = (value, revision, action = 'save') => ({ ...value, titles: value.titles.join('\n'), revision, action });
  const edited = Object.fromEntries(contentFields.map(([key]) => [key, key === 'titles' ? content.titles.map(v => v + '編集') : content[key] + '\n編集']));
  assert.equal((await post(draftPath, toForm(edited, 1))).status, 303);
  draft = await stored();
  assert.equal(draft.status, '編集中');
  assert.deepEqual(draft.edited, edited);
  assert.deepEqual(draft.original, content);
  assert.equal((await post(draftPath, toForm(edited, draft.revision, 'review'))).status, 303);
  draft = await stored();
  assert.equal(draft.status, '確認済み');
  assert.ok(draft.reviewedAt);
  // 同じ内容の通常保存は確認済みを維持。フォームのCRLFも同じ内容として扱う。
  const same = toForm(edited, draft.revision);
  same.body = same.body.replace(/\n/g, '\r\n');
  await post(draftPath, same);
  draft = await stored();
  assert.equal(draft.status, '確認済み');
  const changed = { ...edited, body: edited.body + '再編集' };
  // JSを無効にして直接reviewを送っても、変更と承認を同時に行わせない。
  await post(draftPath, toForm(changed, draft.revision, 'review'));
  draft = await stored();
  assert.equal(draft.status, '編集中');
  assert.equal(draft.reviewedAt, null);
  const stale = await post(draftPath, toForm(edited, 1));
  assert.equal(stale.status, 409);
  assert.ok((await stale.text()).includes('別の画面で更新'));
  assert.deepEqual((await stored()).edited, changed);
  const firstSnapshot = await stored();
  const second = await post(planPath + '/drafts', { result: '```json\n' + JSON.stringify({ ...payload, generatedAt: null }) + '\n```' });
  assert.equal(second.status, 303);
  assert.notEqual(second.headers.get('location'), draftPath);
  assert.deepEqual(await stored(), firstSnapshot);
  const history = await (await fetch(base + planPath)).text();
  assert.ok(history.includes(draftPath));
  assert.ok(history.includes(second.headers.get('location')));
  assert.ok((await (await fetch(base + second.headers.get('location'))).text()).includes('不明（Codex'));
  assert.equal(await readFile(path.join(directory, `${planId}.json`), 'utf8'), originalPlan);

  for (const invalid of ['not json', JSON.stringify({ ...payload, planId: 'wrong' }), JSON.stringify({ ...payload, promptVersion: 'wrong' }), JSON.stringify({ ...payload, generatedAt: 'yesterday' }), JSON.stringify({ ...payload, content: { ...content, titles: ['1'] } }), JSON.stringify({ ...payload, content: { ...content, body: '' } }), JSON.stringify({ ...payload, content: { ...content, body: 'あ'.repeat(50001) } })]) {
    const response = await post(planPath + '/drafts', { result: invalid });
    assert.equal(response.status, 400);
    assert.ok((await response.text()).includes('id="result"'));
  }
  assert.equal((await post(draftPath, { ...toForm(edited, draft.revision), body: '' })).status, 400);
  for (const route of [planPath + '/drafts', draftPath]) {
    assert.equal((await post(route, {}, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post(route, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  }
  assert.equal((await fetch(base + `/data/drafts/${draftId}.json`)).status, 404);
  assert.equal((await fetch(base + '/data/backups/v1-before-phase2-20260926.tar.gz')).status, 404);
  assert.equal((await readdir(path.join(directory, 'drafts'))).filter(n => n.endsWith('.json')).length, 2);
  // 同時保存の片方だけ成功し、もう片方は競合として扱う。
  const simultaneous = await Promise.all([post(draftPath, toForm(changed, draft.revision)), post(draftPath, toForm(edited, draft.revision))]);
  assert.deepEqual(simultaneous.map(r => r.status).sort(), [303, 409]);
  await new Promise(resolve => server.close(resolve));
  ({ server, base } = await start());
  assert.equal((await fetch(base + draftPath)).status, 200);
  assert.ok((await (await fetch(base + planPath)).text()).includes('過去の下書き（2件）'));
  assert.deepEqual((await stored()).original, content);
});
