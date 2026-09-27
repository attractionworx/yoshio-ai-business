import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDraftStore } from '../lib/drafts.js';
import { createGenerationService } from '../lib/ai/generation-service.js';
import { createGenerationStore } from '../lib/ai/generation-store.js';
import { createFakeProvider, fakeContent } from '../lib/ai/fake-provider.js';
import { summarizeUsage, checkBudget, estimateYen } from '../lib/ai/usage-budget.js';
import { fakeConfig, resolveConfig } from '../lib/ai/config.js';
import { factRule } from '../lib/fact-policy.js';
import { buildPrompt, PROMPT_VERSION } from '../lib/content.js';
import { buildGenerationPrompt } from '../lib/ai/generation-prompt.js';
import { buildImprovementPrompt } from '../lib/improvements.js';
import { createApp } from '../server.js';

const plan = () => ({ id: randomUUID(), createdAt: '2026-01-01T00:00:00Z', theme: '架空の検証専用企画', audience: '架空の読者', medium: 'note', purpose: '架空の確認', notes: '実データを使わない' });
async function setup(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-phase3-'));
  const draftStore = createDraftStore(directory);
  const store = createGenerationStore(directory);
  const service = createGenerationService({ dataDirectory: directory, draftStore, store, ...options });
  return { directory, draftStore, store, service, plan: plan() };
}
const execute = context => context.service.execute(context.plan, context.service.confirmation(context.plan));
const drafts = async context => context.draftStore.list(context.plan.id);

test('Phase 3正常生成: 未確認・新規ID・原文分離・生成元・実行ID・模擬usage', async () => {
  const c = await setup();
  const run = await execute(c);
  assert.equal(run.state, 'succeeded');
  const draft = await c.draftStore.get(run.draftId);
  assert.equal(draft.status, '未確認');
  assert.equal(draft.reviewedAt, null);
  assert.equal(draft.publication, undefined);
  assert.equal(draft.parentDraftId, null);
  assert.equal(draft.generationMethod, 'ai-direct-fake');
  assert.equal(draft.generation.executionId, run.id);
  assert.equal(draft.generation.model, 'fake-paper-v1');
  assert.deepEqual(draft.original, fakeContent);
  assert.deepEqual(draft.original, draft.edited);
  assert.notEqual(draft.original, draft.edited);
  draft.edited.body = '人間の架空編集';
  assert.equal(draft.original.body, fakeContent.body);
  assert.equal(draft.planId, c.plan.id);
  assert.equal(run.estimatedYen, 3);
  assert.equal(run.reservedYen, 0);
  const summary = await c.service.summary();
  assert.equal(summary.executionCount, 1);
  assert.equal(summary.savedCount, 1);
  assert.equal(summary.inputTokens, 1000);
  assert.equal(summary.outputTokens, 2000);
  const second = await execute(c);
  assert.notEqual(second.draftId, run.draftId);
  assert.deepEqual((await drafts(c)).map(d => d.versionNumber), [2, 1]);
});

for (const scenario of ['error', 'invalid-json', 'missing', 'violation', 'incomplete']) test(`Fake ${scenario}: 不完全ドラフトなし・再試行なし`, async () => {
  let calls = 0;
  const fake = createFakeProvider({ scenario, delayMs: 0 });
  const c = await setup({ provider: { kind: 'fake', generate: async input => { calls++; return fake.generate(input); } } });
  const run = await execute(c);
  assert.equal(run.state, 'failed');
  assert.equal((await drafts(c)).length, 0);
  assert.equal(calls, 1);
  assert.equal((await c.service.summary()).executionCount, 1);
  assert.equal(run.reservedYen, 0);
  assert.equal(run.estimatedYen, scenario === 'error' ? 0 : 3);
});
for (const scenario of ['timeout', 'unknown']) test(`Fake ${scenario}: 結果不明の予約保持・新規実行停止`, async () => {
  const c = await setup({ provider: createFakeProvider({ scenario, delayMs: 0 }), config: { timeoutMs: 10 } });
  const run = await execute(c);
  assert.equal(run.state, 'unknown');
  assert.equal(run.reservedYen, 10);
  assert.equal((await drafts(c)).length, 0);
  await assert.rejects(() => execute(c), /生成中または結果不明/);
  const restarted = createGenerationService({ dataDirectory: c.directory, draftStore: c.draftStore });
  assert.equal((await restarted.get(run.id)).reservedYen, 10);
  assert.equal((await restarted.summary()).reservedYen, 10);
});

test('使用量不明・上限外は0円扱いにせず予約保持', async () => {
  for (const usage of [undefined, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1000, outputTokens: 999999 }]) {
    const c = await setup({ provider: { kind: 'fake', async generate() { return { status: 'completed', text: JSON.stringify(fakeContent), usage }; } } });
    assert.equal((await execute(c)).state, 'unknown');
    assert.equal((await c.service.summary()).reservedYen, 10);
    assert.equal((await drafts(c)).length, 0);
  }
});

test('予算超過・1回上限超過ではProviderを呼ばない', async () => {
  for (const config of [{ monthlyBudgetYen: 1000, warningYen: 1, stopYen: 9 }, { reservationYen: 21 }]) {
    let calls = 0;
    const c = await setup({ config, provider: { kind: 'fake', async generate() { calls++; } } });
    await assert.rejects(() => execute(c), /安全停止額|1回の予約上限/);
    assert.equal(calls, 0);
    assert.equal((await drafts(c)).length, 0);
    assert.equal((await c.service.summary()).executionCount, 0);
  }
});

test('予算境界・警告・過去月の未解決予約・小数精算', () => {
  const run = { id: randomUUID(), month: '2026-01', attempted: true, state: 'succeeded', estimatedYen: 890, reservedYen: 0 };
  const now = new Date('2026-01-31T23:59:00Z');
  let summary = summarizeUsage([run], now, fakeConfig);
  assert.equal(summary.warning, true);
  assert.doesNotThrow(() => checkBudget(summary, fakeConfig)); // 900ちょうどは許可
  assert.throws(() => checkBudget({ ...summary, spentYen: 890.001 }, fakeConfig), /安全停止額/);
  summary = summarizeUsage([{ ...run, state: 'unknown', reservedYen: 10 }], new Date('2026-02-01T00:00:00Z'), fakeConfig);
  assert.equal(summary.spentYen, 0);
  assert.equal(summary.reservedYen, 10);
  assert.equal(estimateYen({ inputTokens: 1, outputTokens: 1 }, fakeConfig), 0.002);
});

test('送信前予約・同時生成拒否・同じ実行IDの二重送信は1回だけ', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const c = await setup({ provider: { kind: 'fake', async generate() { calls++; entered(); await gate; return { status: 'completed', text: JSON.stringify(fakeContent), usage: { inputTokens: 1000, outputTokens: 2000 } }; } } });
  const token = c.service.confirmation(c.plan);
  const first = c.service.execute(c.plan, token);
  await started;
  assert.equal((await c.service.summary()).reservedYen, 10);
  assert.equal((await c.service.execute(c.plan, token)).state, 'running');
  await assert.rejects(() => execute(c), /生成中または結果不明/);
  release();
  const result = await first;
  assert.equal((await c.service.execute(c.plan, token)).draftId, result.draftId);
  assert.equal(calls, 1);
  assert.equal((await drafts(c)).length, 1);
});

test('保存失敗後は保存だけ再試行・重複保存防止・料金は保持', async () => {
  let fail = true;
  let calls = 0;
  const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-save-failure-'));
  const draftStore = createDraftStore(directory);
  const service = createGenerationService({ dataDirectory: directory, draftStore: { ...draftStore, async create(...args) { if (fail) throw new Error('DO_NOT_EXPOSE_FAKE_SECRET'); return draftStore.create(...args); } },
    provider: { kind: 'fake', async generate(input) { calls++; return createFakeProvider().generate(input); } } });
  const p = plan();
  const run = await service.execute(p, service.confirmation(p));
  assert.equal(run.state, 'save-failed');
  assert.equal((await draftStore.list(p.id)).length, 0);
  assert.equal(run.estimatedYen, 3);
  fail = false;
  const results = await Promise.all([service.retrySave(run.id), service.retrySave(run.id)]);
  assert.equal(results[0].draftId, results[1].draftId);
  assert.equal((await draftStore.list(p.id)).length, 1);
  assert.equal(calls, 1);
  const persisted = await readFile(path.join(directory, 'generations/ledger.json'), 'utf8');
  assert.ok(!persisted.includes('DO_NOT_EXPOSE_FAKE_SECRET'));
});

test('保存後の台帳更新失敗も、再保存で既存ドラフトを再利用', async () => {
  const c = await setup();
  let failOnce = true;
  const wrapped = { ...c.store, transaction: change => c.store.transaction(async ledger => {
    const result = await change(ledger);
    if (failOnce && ledger.runs.some(r => r.state === 'succeeded')) { failOnce = false; throw new Error('disk'); }
    return result;
  }) };
  const service = createGenerationService({ dataDirectory: c.directory, draftStore: c.draftStore, store: wrapped });
  const run = await service.execute(c.plan, service.confirmation(c.plan));
  assert.equal(run.state, 'save-failed');
  assert.equal((await drafts(c)).length, 1); // 完全なドラフトは保存済み
  const recovered = await service.retrySave(run.id);
  assert.equal(recovered.state, 'succeeded');
  assert.equal((await drafts(c)).length, 1);
});

test('台帳破損・台帳消失時は停止し、予算をリセットしない', async () => {
  for (const mode of ['corrupt', 'missing']) {
    const c = await setup();
    await execute(c);
    const ledger = path.join(c.directory, 'generations/ledger.json');
    if (mode === 'corrupt') await writeFile(ledger, '{bad'); else await unlink(ledger);
    await assert.rejects(() => execute(c), /安全に読み取れません/);
    assert.equal((await drafts(c)).length, 1);
  }
});

test('確認トークンの改ざん・別企画・期限切れを拒否', async () => {
  let clock = new Date('2026-01-01T00:00:00Z');
  const c = await setup({ now: () => clock });
  const token = c.service.confirmation(c.plan);
  await assert.rejects(() => c.service.execute(c.plan, token + 'x'), /無効/);
  await assert.rejects(() => c.service.execute({ ...c.plan, theme: '別の架空企画' }, token), /企画または設定/);
  clock = new Date('2026-01-01T00:16:00Z');
  await assert.rejects(() => c.service.execute(c.plan, token), /期限/);
  assert.equal((await drafts(c)).length, 0);
});

test('Fake以外のProvider・任意モデル・再試行設定は利用不可', async () => {
  assert.throws(() => resolveConfig({ model: 'arbitrary-model' }), /Fake設定/);
  assert.throws(() => resolveConfig({ retries: 1 }), /Fake設定/);
  await assert.rejects(() => setup({ provider: { kind: 'openai' } }), /Fake Provider/);
});

test('共通の創作禁止方針を手動・改善・直接生成で維持', () => {
  assert.ok(buildPrompt(plan()).includes(factRule));
  assert.ok(buildGenerationPrompt().includes(factRule));
  assert.ok(buildImprovementPrompt({ planSnapshot: plan(), settings: { mode: 'analysis', options: [], instructions: '' } }).includes(factRule));
});

test('対象企画・ID・任意Providerメタデータを生成へ渡さない', async () => {
  let received;
  const c = await setup({ provider: { kind: 'fake', async generate(input) { received = input; return { status: 'completed', text: JSON.stringify(fakeContent), usage: { inputTokens: 1, outputTokens: 1 }, model: 'DO_NOT_USE_MODEL', apiKey: 'DO_NOT_SAVE_SECRET' }; } } });
  const run = await execute(c);
  assert.ok(!JSON.stringify(received).includes(c.plan.id));
  assert.ok(!JSON.stringify(received).includes(c.plan.theme));
  const stored = JSON.stringify(await c.draftStore.get(run.draftId));
  assert.ok(!stored.includes('DO_NOT_USE_MODEL'));
  assert.ok(!stored.includes('DO_NOT_SAVE_SECRET'));
});

test('不正な応答内の状態・企画ID・モデル等は採用せず拒否', async () => {
  const c = await setup({ provider: { kind: 'fake', async generate() { return { status: 'completed', text: JSON.stringify({ ...fakeContent, status: '確認済み', model: 'fake-other' }), usage: { inputTokens: 1, outputTokens: 1 } }; } } });
  assert.equal((await execute(c)).state, 'failed');
  assert.equal((await drafts(c)).length, 0);
});

async function startApp(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yoshio-phase3-http-'));
  const server = createApp({ dataDirectory: directory, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, values, headers = {}) => fetch(base + route, { method: 'POST', body: new URLSearchParams(values), headers: { Origin: base, ...headers }, redirect: 'manual' });
  const response = await post('/plans', { theme: 'HTTP検証の架空企画', medium: 'note' });
  const planPath = response.headers.get('location');
  return { directory, base, post, planPath };
}

test('HTTP: 確認画面は未実行・明示実行・結果・既存公開準備へ接続', async t => {
  const c = await startApp(t);
  const route = c.planPath + '/generate';
  const html = await (await fetch(c.base + route)).text();
  assert.match(html, /生成前確認/);
  assert.match(html, /実料金0円/);
  assert.match(html, /economy/);
  assert.ok(!(await readdir(c.directory)).includes('generations'));
  const token = html.match(/name="token" value="([^"]+)"/)[1];
  assert.equal((await c.post(route, { token, confirm: 'yes', model: 'dangerous' })).status, 400);
  assert.equal((await c.post(route, { token, confirm: 'yes' }, { Origin: 'https://example.com' })).status, 403);
  const noOrigin = await fetch(c.base + route, { method: 'POST', body: new URLSearchParams({ token, confirm: 'yes' }) });
  assert.equal(noOrigin.status, 403);
  const response = await c.post(route, { token, confirm: 'yes' });
  assert.equal(response.status, 303);
  const result = await (await fetch(c.base + response.headers.get('location'))).text();
  assert.match(result, /模擬概算/);
  const draftPath = result.match(/data-generated-draft href="([^"]+)"/)[1];
  const draftHtml = await (await fetch(c.base + draftPath)).text();
  assert.match(draftHtml, /id="draft-status">未確認/);
  assert.match(draftHtml, /直接AI生成（Fake/);
  const review = await c.post(draftPath, { ...fakeContent, titles: fakeContent.titles.join('\n'), revision: 1, action: 'review' });
  assert.equal(review.status, 303);
  const prep = await c.post(draftPath + '/publish', { action: 'ready', titleIndex: '0', experience: 'yes', numbers: 'yes', links: 'yes', revision: 2 });
  assert.equal(prep.status, 303);
  assert.match(await (await fetch(c.base + draftPath + '/publish')).text(), /公開準備OK/);
  const duplicate = await c.post(route, { token, confirm: 'yes' });
  assert.equal(duplicate.headers.get('location'), response.headers.get('location'));
  assert.equal((await readdir(path.join(c.directory, 'drafts'))).filter(n => n.endsWith('.json')).length, 1);
  // 既存の手動取り込みは引き続き新しい版として動作。
  const manual = await c.post(c.planPath + '/drafts', { result: JSON.stringify({ planId: c.planPath.split('/').at(-1), promptVersion: PROMPT_VERSION, generatedAt: null, content: fakeContent }) });
  assert.equal(manual.status, 303);
  assert.match(await (await fetch(c.base + manual.headers.get('location'))).text(), /Codex手動取り込み/);
});

test('Providerの秘密値をHTML・台帳・ログへ出さない', async t => {
  const sentinel = 'SYNTHETIC_SECRET_NEVER_EXPOSE';
  const log = [];
  const originalError = console.error;
  console.error = (...args) => { log.push(args.join(' ')); };
  t.after(() => { console.error = originalError; });
  const c = await startApp(t, { generationOptions: { provider: { kind: 'fake', async generate() { throw Object.assign(new Error(sentinel), { status: 400, code: sentinel, apiKey: sentinel }); } } } });
  const route = c.planPath + '/generate';
  const html = await (await fetch(c.base + route)).text();
  const token = html.match(/name="token" value="([^"]+)"/)[1];
  const response = await c.post(route, { token, confirm: 'yes' });
  const result = await (await fetch(c.base + response.headers.get('location'))).text();
  assert.ok(!result.includes(sentinel));
  assert.ok(!(await readFile(path.join(c.directory, 'generations/ledger.json'), 'utf8')).includes(sentinel));
  assert.ok(!log.join('\n').includes(sentinel));
  assert.match(result, /結果不明/);
});

test('実装はAPIキーを読まず、ネットワーク遮断下でもFake生成が完了する', async () => {
  const guard = await import('./helpers/network-guard.js');
  const before = guard.blockedConnections.length;
  const originalEnv = process.env;
  let keyReads = 0;
  // キーの値は設定も取得もしない。将来の誤った参照があれば例外にする。
  process.env = new Proxy(originalEnv, { get(target, key) {
    if (typeof key === 'string' && /OPENAI|API_KEY/.test(key)) { keyReads++; throw new Error('APIキー参照禁止'); }
    return Reflect.get(target, key);
  } });
  try {
    const c = await setup();
    assert.equal((await execute(c)).state, 'succeeded');
  } finally { process.env = originalEnv; }
  assert.equal(keyReads, 0);
  assert.equal(guard.blockedConnections.length, before);
});

test('明らかな経歴・実績・未知URLや数値の断定を拒否、要確認は未確認保存', async () => {
  for (const [body, expected] of [
    ['私は架空企業に勤務しました。', 'failed'],
    ['私は架空賞を受賞しました。', 'failed'],
    ['詳しくはhttps://invented-destination.invalidをご覧ください。', 'failed'],
    ['成功率は100%です。', 'failed'],
    ['成功率は要確認です。', 'succeeded'],
    ['仮の例として、月収100円と仮定します。', 'succeeded'],
  ]) {
    const c = await setup({ provider: { kind: 'fake', async generate() { return { status: 'completed', text: JSON.stringify({ ...fakeContent, body }), usage: { inputTokens: 1, outputTokens: 1 } }; } } });
    const run = await execute(c);
    assert.equal(run.state, expected, body);
    if (expected === 'succeeded') assert.equal((await c.draftStore.get(run.draftId)).status, '未確認');
    else assert.equal((await drafts(c)).length, 0);
  }
});

test('API相当の原文JSONを再整形せず保持する', async () => {
  const raw = JSON.stringify(fakeContent, null, 2);
  const c = await setup({ provider: { kind: 'fake', async generate() { return { status: 'completed', text: raw, usage: { inputTokens: 1, outputTokens: 1 } }; } } });
  const run = await execute(c);
  assert.equal((await c.draftStore.get(run.draftId)).originalRaw, raw);
});

test('保存待ち内容が不正に変化していた場合も再検証しドラフトを作らない', async () => {
  const c = await setup();
  const service = createGenerationService({ dataDirectory: c.directory, draftStore: { ...c.draftStore, async create() { throw new Error('save-failure'); } } });
  const run = await service.execute(c.plan, service.confirmation(c.plan));
  assert.equal(run.state, 'save-failed');
  await c.store.transaction(ledger => { ledger.runs[0].raw = JSON.stringify({ ...fakeContent, body: '私は架空企業に勤務しました。' }); });
  const recovered = await c.service.retrySave(run.id);
  assert.equal(recovered.state, 'save-failed');
  assert.equal((await drafts(c)).length, 0);
});

test('別のサービスからも実行中の台帳を見て同時生成を拒否', async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const c = await setup({ provider: { kind: 'fake', async generate() { entered(); await gate; return { status: 'completed', text: JSON.stringify(fakeContent), usage: { inputTokens: 1, outputTokens: 1 } }; } } });
  const operation = execute(c);
  await started;
  const second = createGenerationService({ dataDirectory: c.directory, draftStore: c.draftStore });
  await assert.rejects(() => second.execute(c.plan, second.confirmation(c.plan)), /生成中または結果不明/);
  release();
  await operation;
  assert.equal((await drafts(c)).length, 1);
});

test('台帳内の不正usageは表示・予約判定に使わず停止', async () => {
  const c = await setup();
  await execute(c);
  const file = path.join(c.directory, 'generations/ledger.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  ledger.runs[0].usage.inputTokens = '<script>invalid</script>';
  await writeFile(file, JSON.stringify(ledger));
  await assert.rejects(() => c.service.summary(), /安全に読み取れません/);
});
