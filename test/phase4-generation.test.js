import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { createOfferStore } from '../lib/offers/store.js';
import { createDraftStore } from '../lib/drafts.js';
import { createGenerationStore } from '../lib/ai/generation-store.js';
import { createGenerationService } from '../lib/ai/generation-service.js';
import { createOpenAIProvider } from '../lib/ai/openai-provider.js';
import { fakeContent } from '../lib/ai/fake-provider.js';
import { openaiConfig } from '../lib/ai/config.js';
import { contextHash, resolveAffiliateContext, validateAffiliateContext } from '../lib/ai/affiliate-context.js';
import { buildOpenAIPrompt } from '../lib/ai/generation-prompt.js';
import { offerInput } from './fixtures/plan-offer.js';

const now = () => new Date('2026-09-29T00:00:00Z');
function input() {
  const value = offerInput();
  value.name = '固定版の架空講座';
  value.facts[0].text = '固定版だけの公開情報';
  value.facts[1].text = '未確認の秘密ではない除外目印';
  value.facts[2].text = '内部用の除外目印';
  value.facts.push({ ...value.facts[0], id: 'editor', origin: 'editor', text: '編集者だけの除外目印' });
  value.facts.push({ ...value.facts[0], id: 'reward-category', category: 'reward', text: '報酬カテゴリの除外目印' });
  value.facts.push({ ...value.facts[0], id: 'url-text', text: '管理画面 https://admin.example.test/manage' });
  value.targetAudience[0].text = '初心者向けという確認済み情報';
  value.sellingPoints = [{ ...value.facts[0], id: 'selling', category: 'selling_point', text: '公開可能な訴求目印' }];
  value.conversions[0].name = '架空の相談予約';
  value.conversions[0].eligibility[0].usage = 'publishable';
  value.conversions[0].eligibility[0].text = '選択成果地点の公開条件';
  value.conversions[0].approvalConditions[0].text = '非公開条件の除外目印';
  value.conversions[0].reward.evidence.text = '報酬根拠の除外目印';
  value.conversions[1].ctaLabel.text = '別成果地点だけの除外目印';
  return value;
}
async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'affiliate-generation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const offers = createOfferStore(directory, { now });
  const offer = await offers.create(input());
  const drafts = createDraftStore(directory); const store = createGenerationStore(directory); const calls = [];
  const provider = createOpenAIProvider({ client: { responses: { create: async args => {
    calls.push(args);
    return { status: 'completed', output_text: JSON.stringify(fakeContent), usage: { input_tokens: 1000, output_tokens: 2000 } };
  } } } });
  const plan = { id: randomUUID(), createdAt: now().toISOString(), theme: '架空の企画', audience: '', medium: 'note', purpose: '', notes: '',
    offerBinding: { offerId: offer.id, offerRevision: 1, conversionId: 'consultation', selectionReason: '人間の判断記録の目印', snapshot: { offerName: offer.name, conversionName: offer.conversions[0].name } } };
  const options = { dataDirectory: directory, draftStore: drafts, provider, config: openaiConfig, now, store, ...overrides };
  const service = createGenerationService(options);
  return { directory, offers, offer, drafts, store, calls, provider, plan, options, service };
}
const execute = c => c.service.execute(c.plan, c.service.confirmation(c.plan));

test('Step 4: 案件なしOpenAI生成は従来prompt・draft形式、案件storeを読まない', async t => {
  const c = await setup(t); delete c.plan.offerBinding;
  const service = createGenerationService({ ...c.options, offerStore: { history() { throw new Error('参照禁止'); } } });
  const prepared = await service.prepareConfirmation(c.plan); assert.equal(prepared.affiliate, null);
  const run = await service.execute(c.plan, prepared.token);
  assert.equal(run.state, 'succeeded'); assert.equal(c.calls[0].instructions, buildOpenAIPrompt(c.plan));
  assert.equal((await c.drafts.get(run.draftId)).affiliateContext, undefined);
});

test('Step 4: allowlistから公開情報・禁止表現だけ抽出しSDK送信とdraftに固定根拠を保存', async t => {
  const c = await setup(t); const prepared = await c.service.prepareConfirmation(c.plan);
  assert.equal(c.calls.length, 0); assert.equal((await c.store.read()).runs.length, 0);
  const run = await c.service.execute(c.plan, prepared.token); assert.equal(run.state, 'succeeded');
  const prompt = c.calls[0].instructions;
  for (const included of ['固定版だけの公開情報', '初心者向けという確認済み情報', '公開可能な訴求目印', '選択成果地点の公開条件', '必ず成功するとの表現は禁止', '広告：アフィリエイトリンクを含みます。', '架空の相談を申し込む']) assert.ok(prompt.includes(included), included);
  for (const excluded of ['未確認の秘密ではない除外目印', '内部用の除外目印', '編集者だけの除外目印', '報酬カテゴリの除外目印', '管理画面', '非公開条件の除外目印', '報酬根拠の除外目印', '別成果地点だけの除外目印', '人間の判断記録の目印', 'reward', 'internal_only', 'affiliateUrl', 'test-asp', c.offer.id, 'https://']) assert.ok(!prompt.includes(excluded), excluded);
  assert.equal(c.calls[0].store, false); assert.equal(c.calls[0].text.format.schema.additionalProperties, false);
  const draft = await c.drafts.get(run.draftId); const a = draft.affiliateContext;
  assert.equal(a.offerId, c.offer.id); assert.equal(a.offerRevision, 1); assert.equal(a.conversionId, 'consultation');
  assert.equal(a.selectionReason, c.plan.offerBinding.selectionReason); assert.equal(a.offerName, c.offer.name); assert.equal(a.conversionName, c.offer.conversions[0].name);
  assert.equal(a.contextHash, contextHash(a.snapshot)); assert.deepEqual(a, prepared.affiliate.affiliateContext);
  assert.equal(draft.inputSnapshot.offerBinding, undefined); assert.equal(draft.promptVersion, 'direct-affiliate-v1');
  assert.equal(draft.status, '未確認'); assert.equal(draft.publication, undefined);
  assert.deepEqual(Object.keys(draft.edited).sort(), Object.keys(fakeContent).sort());
  for (const forbidden of ['reward', 'internal_only', 'affiliateUrl', 'test-asp', '報酬根拠の除外目印']) assert.ok(!JSON.stringify(draft).includes(forbidden));
});

test('Step 4: 最新revisionの本文・名称に追従せず固定revisionと選択conversionを使用', async t => {
  const c = await setup(t); const changed = input(); changed.name = '最新版だけの名前'; changed.facts[0].text = '最新版だけの事実';
  await c.offers.update(c.offer.id, 1, changed);
  const run = await execute(c); const draft = await c.drafts.get(run.draftId);
  assert.equal(draft.affiliateContext.offerRevision, 1); assert.equal(draft.affiliateContext.offerName, '固定版の架空講座');
  assert.ok(!c.calls[0].instructions.includes('最新版だけ'));
  c.plan.offerBinding.conversionId = 'contract';
  const second = await execute(c); assert.equal((await c.drafts.get(second.draftId)).affiliateContext.conversionId, 'contract');
  assert.ok(c.calls[1].instructions.includes('別成果地点だけの除外目印'));
  assert.ok(!c.calls[1].instructions.includes('選択成果地点の公開条件'));
  assert.equal(c.plan.offerBinding.offerRevision, 1);
});

for (const status of ['paused', 'ended', 'draft']) test(`Step 4: ${status}では確認tokenを発行せず、古い確認も拒否して紐付け保持`, async t => {
  const c = await setup(t); const token = await c.service.confirmation(c.plan); const before = structuredClone(c.plan);
  await c.offers.update(c.offer.id, 1, { ...input(), status });
  const prepared = await c.service.prepareConfirmation(c.plan);
  assert.equal(prepared.token, ''); assert.match(prepared.affiliate.blockedReason, new RegExp(status));
  await assert.rejects(c.service.execute(c.plan, token), { status: 409 });
  assert.equal(c.calls.length, 0); assert.equal((await c.store.read()).runs.length, 0); assert.deepEqual(c.plan, before);
});

for (const [key, value] of [['offerId', randomUUID()], ['offerRevision', 2], ['conversionId', 'contract'], ['selectionReason', '理由を変更']]) test(`Step 4: confirmation後の${key}変更を拒否`, async t => {
  const c = await setup(t); const token = await c.service.confirmation(c.plan); c.plan.offerBinding[key] = value;
  await assert.rejects(c.service.execute(c.plan, token), { status: 409 }); assert.equal(c.calls.length, 0);
});

test('Step 4: confirmation後の紐付け解除・追加を拒否', async t => {
  const c = await setup(t); const token = await c.service.confirmation(c.plan); const binding = c.plan.offerBinding; delete c.plan.offerBinding;
  await assert.rejects(c.service.execute(c.plan, token), { status: 409 });
  const plainToken = c.service.confirmation(c.plan); c.plan.offerBinding = binding;
  await assert.rejects(c.service.execute(c.plan, plainToken), { status: 409 }); assert.equal(c.calls.length, 0);
});

test('Step 4: 固定revisionのコンテキスト変更をhashで拒否', async t => {
  const c = await setup(t); const token = await c.service.confirmation(c.plan);
  const file = path.join(c.directory, 'offers', `${c.offer.id}.json`); const record = JSON.parse(await readFile(file, 'utf8'));
  record.revisions[0].facts[0].text = '履歴ファイルの変更を模擬'; await writeFile(file, JSON.stringify(record));
  await assert.rejects(c.service.execute(c.plan, token), { status: 409 }); assert.equal(c.calls.length, 0);
});

test('Step 4: 状態変更→active復帰も古い確認を拒否、新しい確認では固定版を使用', async t => {
  const c = await setup(t); const token = await c.service.confirmation(c.plan);
  await c.offers.update(c.offer.id, 1, { ...input(), status: 'paused' }); await c.offers.update(c.offer.id, 2, input());
  await assert.rejects(c.service.execute(c.plan, token), { status: 409 });
  const run = await execute(c); assert.equal((await c.drafts.get(run.draftId)).affiliateContext.offerRevision, 1);
});

test('Step 4: 改ざん・期限切れ・別serviceのconfirmationはAPI送信前に拒否', async t => {
  let clock = now(); const c = await setup(t, { now: () => clock }); const token = await c.service.confirmation(c.plan);
  await assert.rejects(c.service.execute(c.plan, token + 'x'), { status: 400 });
  const second = createGenerationService(c.options); await assert.rejects(second.execute(c.plan, token), { status: 400 });
  clock = new Date(clock.getTime() + 16 * 60_000);
  await assert.rejects(c.service.execute(c.plan, token), /期限/); assert.equal(c.calls.length, 0);
});

for (const mutation of ['missing-offer', 'missing-revision', 'wrong-conversion', 'unknown-field', 'secret']) test(`Step 4: 不正な紐付け／秘密混入を送信前に拒否 ${mutation}`, async t => {
  const c = await setup(t);
  if (mutation === 'missing-offer') c.plan.offerBinding.offerId = randomUUID();
  if (mutation === 'missing-revision') c.plan.offerBinding.offerRevision = 99;
  if (mutation === 'wrong-conversion') c.plan.offerBinding.conversionId = 'other-offer-conversion';
  if (mutation === 'unknown-field') c.plan.offerBinding.reward = 123;
  if (mutation === 'secret') c.plan.offerBinding.selectionReason = 'api_key=do-not-expose';
  await assert.rejects(c.service.prepareConfirmation(c.plan), error => { assert.ok(!error.message.includes('do-not-expose')); return true; });
  assert.equal(c.calls.length, 0);
});

for (const field of ['validFrom', 'validUntil', 'reviewDueAt']) test(`Step 4: ${field}による生成前の有効性確認`, async t => {
  const c = await setup(t); const changed = input(); changed[field] = field === 'validFrom' ? '2027-01-01T00:00:00Z' : '2026-01-01T00:00:00Z';
  await c.offers.update(c.offer.id, 1, changed);
  const prepared = await c.service.prepareConfirmation(c.plan); assert.equal(prepared.token, ''); assert.match(prepared.affiliate.blockedReason, /期間外|期限/);
  assert.equal(c.calls.length, 0);
});

test('Step 4: 現在の成果地点停止・削除も固定版に自動追従せず停止', async t => {
  const c = await setup(t); const changed = input(); changed.conversions[0].status = 'paused';
  await c.offers.update(c.offer.id, 1, changed); assert.equal((await c.service.prepareConfirmation(c.plan)).token, '');
  changed.conversions = changed.conversions.slice(1); await c.offers.update(c.offer.id, 2, changed);
  assert.equal((await c.service.prepareConfirmation(c.plan)).token, ''); assert.equal(c.calls.length, 0);
});

test('Step 4: 案件付きpromptの入力上限は切り捨てず送信前に停止', async t => {
  const c = await setup(t, { config: { ...openaiConfig, maxInputTokens: 10 } });
  const prepared = await c.service.prepareConfirmation(c.plan); assert.equal(prepared.token, ''); assert.match(prepared.affiliate.blockedReason, /上限/);
  assert.equal(c.calls.length, 0); assert.equal((await c.store.read()).runs.length, 0);
});

test('Step 4: 保存失敗→案件停止・企画変更・再起動→保存再試行は最初の根拠を維持しAPIは1回', async t => {
  const c = await setup(t); const service = createGenerationService({ ...c.options, draftStore: { create() { throw new Error('保存失敗'); } } });
  const prepared = await service.prepareConfirmation(c.plan); const run = await service.execute(c.plan, prepared.token); assert.equal(run.state, 'save-failed');
  assert.deepEqual(run.affiliateContext, prepared.affiliate.affiliateContext);
  await c.offers.update(c.offer.id, 1, { ...input(), status: 'ended' }); delete c.plan.offerBinding;
  const restarted = createGenerationService(c.options);
  const [a, b] = await Promise.all([restarted.retrySave(run.id), restarted.retrySave(run.id)]);
  assert.equal(a.state, 'succeeded'); assert.equal(b.draftId, a.draftId); assert.equal(c.calls.length, 1);
  const draft = await c.drafts.get(a.draftId); assert.deepEqual(draft.affiliateContext, prepared.affiliate.affiliateContext);
  assert.equal((await c.drafts.list(c.plan.id)).length, 1); assert.equal(draft.prompt, c.calls[0].instructions);
});

test('Step 4: 保存根拠のunknown field・hash不一致・秘密は再試行で使用しない', async t => {
  const c = await setup(t); const service = createGenerationService({ ...c.options, draftStore: { create() { throw new Error('保存失敗'); } } });
  const run = await service.execute(c.plan, service.confirmation(c.plan));
  const file = path.join(c.directory, 'generations', 'ledger.json'); const original = JSON.parse(await readFile(file, 'utf8'));
  for (const mutate of [a => { a.snapshot.reward = 99; }, a => { a.snapshot.facts[0] = '差し替え'; }, a => { a.selectionReason = 'password=do-not-expose'; }]) {
    const ledger = structuredClone(original); mutate(ledger.runs[0].affiliateContext); await writeFile(file, JSON.stringify(ledger));
    await assert.rejects(c.service.retrySave(run.id), { status: 503 });
  }
  assert.equal(c.calls.length, 1); assert.equal((await c.drafts.list(c.plan.id)).length, 0);
});

test('Step 4: 案件付きでも同一tokenの二重送信は1回、予算停止を維持', async t => {
  const c = await setup(t); const token = await c.service.confirmation(c.plan);
  const [a, b] = await Promise.all([c.service.execute(c.plan, token), c.service.execute(c.plan, token)]);
  assert.equal(a.id, b.id); assert.equal(c.calls.length, 1); assert.equal((await c.drafts.list(c.plan.id)).length, 1);
  const limited = createGenerationService({ ...c.options, config: { ...openaiConfig, warningYen: 1, stopYen: 1 } });
  await assert.rejects(limited.execute(c.plan, limited.confirmation(c.plan)), /安全停止額/); assert.equal(c.calls.length, 1);
});

test('Step 4: 予約待ち中のstatus変更は送信直前検証で停止し予約解除', async t => {
  const c = await setup(t); let changed = false;
  const store = { read: c.store.read, transaction: async change => {
    const result = await c.store.transaction(change);
    if (result?.run?.state === 'running' && !changed) { changed = true; await c.offers.update(c.offer.id, 1, { ...input(), status: 'paused' }); }
    return result;
  } };
  const service = createGenerationService({ ...c.options, store });
  await assert.rejects(service.execute(c.plan, service.confirmation(c.plan)), /paused/);
  assert.equal(c.calls.length, 0); const run = (await c.store.read()).runs[0];
  assert.equal(run.reservedYen, 0); assert.equal(run.attempted, false); assert.equal(run.state, 'failed');
});

test('Step 4: 公開snapshotのhashはキー順に依存せず、unknown fieldは拒否', async t => {
  const c = await setup(t); const result = await resolveAffiliateContext(c.plan.offerBinding, c.offers, now()); const a = result.affiliateContext;
  const reordered = Object.fromEntries(Object.entries(a.snapshot).reverse()); assert.equal(contextHash(reordered), a.contextHash);
  assert.deepEqual(validateAffiliateContext({ ...a, snapshot: reordered }).snapshot, reordered);
  assert.throws(() => validateAffiliateContext({ ...a, secret: 'unknown' }));
});

test('Step 4 HTTP: 確認GETは未送信・表示と明示POST・draft根拠・paused警告・入力改ざん拒否', async t => {
  const c = await setup(t); const filename = path.join(c.directory, `${c.plan.id}.json`); await writeFile(filename, JSON.stringify(c.plan));
  const server = createApp({ dataDirectory: c.directory, generationOptions: { provider: c.provider, config: openaiConfig, now } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`; const url = `${base}/plans/${c.plan.id}/generate`;
  const get = async () => (await fetch(url)).text();
  const post = data => fetch(url, { method: 'POST', headers: { Origin: base }, body: new URLSearchParams(data), redirect: 'manual' });
  const html = await get(); const token = html.match(/name="token" value="([^"]+)"/)[1];
  for (const text of [c.offer.name, c.offer.conversions[0].name, 'offer revision', '現在の案件status：active', '固定版だけの公開情報', '人間の判断記録の目印']) assert.ok(html.includes(text), text);
  for (const text of ['報酬根拠の除外目印', '非公開条件の除外目印', 'https://affiliate.example.test']) assert.ok(!html.includes(text));
  assert.equal(c.calls.length, 0);
  for (const data of [{ token, confirm: 'no' }, { token, confirm: 'yes', affiliateContext: '{}' }]) assert.equal((await post(data)).status, 400);
  const response = await post({ token, confirm: 'yes' }); assert.equal(response.status, 303); assert.equal(c.calls.length, 1);
  const draft = (await c.drafts.list(c.plan.id))[0];
  assert.ok((await (await fetch(`${base}/drafts/${draft.id}`)).text()).includes(draft.affiliateContext.contextHash));
  const next = (await get()).match(/name="token" value="([^"]+)"/)[1];
  await c.offers.update(c.offer.id, 1, { ...input(), status: 'paused' });
  assert.equal((await post({ token: next, confirm: 'yes' })).status, 409);
  const stopped = await get(); assert.match(stopped, /現在この案件はpaused/); assert.ok(!stopped.includes('data-generate'));
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), c.plan); assert.equal(c.calls.length, 1);
});

for (const target of ['cta', 'prohibition']) test(`Step 4: editor由来の${target}しかない場合は安全に生成停止`, async t => {
  const c = await setup(t); const changed = input();
  if (target === 'cta') changed.conversions[0].ctaLabel.origin = 'editor';
  else changed.prohibitedExpressions[0].origin = 'editor';
  await c.offers.update(c.offer.id, 1, changed); c.plan.offerBinding.offerRevision = 2;
  const prepared = await c.service.prepareConfirmation(c.plan);
  assert.equal(prepared.token, ''); assert.match(prepared.affiliate.blockedReason, /CTA|禁止表現/); assert.equal(c.calls.length, 0);
});

test('Step 4: 案件履歴の秘密混入はエラーへ転載せず送信・台帳作成前に拒否', async t => {
  const c = await setup(t); const filename = path.join(c.directory, 'offers', `${c.offer.id}.json`);
  const record = JSON.parse(await readFile(filename, 'utf8')); record.revisions[0].facts[0].text = 'Cookie=never-expose-secret';
  await writeFile(filename, JSON.stringify(record));
  await assert.rejects(c.service.prepareConfirmation(c.plan), error => { assert.equal(error.status, 503); assert.ok(!error.message.includes('never-expose-secret')); return true; });
  assert.equal(c.calls.length, 0); assert.equal((await c.store.read()).runs.length, 0);
});

test('Step 4: 案件なし確認の予約待ち中に紐付けが追加されても古い確認を使わない', async t => {
  const c = await setup(t); const original = structuredClone(c.plan); delete c.plan.offerBinding; let latest = structuredClone(c.plan); let changed = false;
  const store = { read: c.store.read, transaction: async change => {
    const result = await c.store.transaction(change);
    if (result?.run?.state === 'running' && !changed) { changed = true; latest = original; }
    return result;
  } };
  const service = createGenerationService({ ...c.options, store, loadPlan: async () => structuredClone(latest) });
  await assert.rejects(service.execute(c.plan, service.confirmation(c.plan)), { status: 409 });
  assert.equal(c.calls.length, 0); assert.equal((await c.store.read()).runs[0].reservedYen, 0);
});

test('Step 4: draft保存後の台帳更新失敗からも二重生成・二重draftなしで根拠を復旧', async t => {
  const c = await setup(t); let failed = false;
  const wrapped = { read: c.store.read, transaction: change => c.store.transaction(async ledger => {
    const result = await change(ledger);
    if (!failed && ledger.runs.some(run => run.state === 'succeeded')) { failed = true; throw new Error('台帳保存失敗'); }
    return result;
  }) };
  const service = createGenerationService({ ...c.options, store: wrapped });
  const run = await service.execute(c.plan, service.confirmation(c.plan)); assert.equal(run.state, 'save-failed');
  const initial = (await c.drafts.list(c.plan.id))[0];
  const recovered = await service.retrySave(run.id); assert.equal(recovered.state, 'succeeded'); assert.equal(recovered.draftId, initial.id);
  assert.deepEqual((await c.drafts.get(initial.id)).affiliateContext, run.affiliateContext);
  assert.equal((await c.drafts.list(c.plan.id)).length, 1); assert.equal(c.calls.length, 1);
});
