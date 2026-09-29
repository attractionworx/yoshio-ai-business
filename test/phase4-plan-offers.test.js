import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { createOfferStore } from '../lib/offers/store.js';
import { createDraftStore } from '../lib/drafts.js';
import { buildPrompt } from '../lib/content.js';
import { buildOpenAIPrompt } from '../lib/ai/generation-prompt.js';
import { createImprovementStore, buildImprovementPrompt } from '../lib/improvements.js';
import { createGenerationService } from '../lib/ai/generation-service.js';
import { createFakeProvider } from '../lib/ai/fake-provider.js';
import { offerInput } from './fixtures/plan-offer.js';
const values = { theme: '初心者向けの記事', medium: 'note', audience: '', purpose: '', notes: '' };
const selection = offer => ({ offerId: offer.id, offerRevision: String(offer.revision), conversionId: 'consultation', selectionReason: '読者の学習目的と合うため' });
const none = { offerId: '', offerRevision: '', conversionId: '', selectionReason: '' };
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'plan-binding-'));
  const server = createApp({ dataDirectory: directory });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { directory, store: createOfferStore(directory),
    get: async url => (await fetch(base + url)).text(),
    post: (url, data, headers = {}) => fetch(base + url, { method: 'POST', headers: { Origin: base, ...headers }, body: data instanceof URLSearchParams ? data : new URLSearchParams(data), redirect: 'manual' }),
    read: async url => JSON.parse(await readFile(path.join(directory, `${url.split('/')[2]}.json`), 'utf8')) };
}
async function create(s, data = {}) {
  const response = await s.post('/plans', { ...values, ...data });
  assert.equal(response.status, 303, await response.text());
  return response.headers.get('location');
}
async function edit(s, url, data) {
  const plan = await s.read(url);
  return s.post(url + '/edit', { ...values, planRevision: String(plan.revision || 1), ...data });
}

test('案件なし企画・旧Phase 3企画の編集・既存draftの非変更', async t => {
  const s = await setup(t);
  const url = await create(s);
  assert.equal((await s.read(url)).offerBinding, undefined);
  const legacy = { id: randomUUID(), createdAt: new Date().toISOString(), ...values };
  const legacyUrl = `/plans/${legacy.id}`;
  await writeFile(path.join(s.directory, `${legacy.id}.json`), JSON.stringify(legacy));
  const drafts = createDraftStore(s.directory);
  const draft = await drafts.create(legacy, { content: {}, generatedAt: null }, '{}', buildPrompt(legacy));
  assert.match(await s.get(legacyUrl + '/edit'), /企画を編集/);
  assert.equal((await edit(s, legacyUrl, { ...none, theme: '編集後' })).status, 303);
  assert.deepEqual((await drafts.get(draft.id)).inputSnapshot, legacy);
  assert.equal((await s.read(legacyUrl)).offerBinding, undefined);
});

test('active案件・成果地点・理由・最小snapshotを保存し履歴更新後もrevision固定', async t => {
  const s = await setup(t); const first = await s.store.create(offerInput());
  const url = await create(s, selection(first));
  const original = await s.read(url);
  assert.deepEqual(original.offerBinding, { offerId: first.id, offerRevision: 1, conversionId: 'consultation', selectionReason: '読者の学習目的と合うため', snapshot: { offerName: first.name, conversionName: first.conversions[0].name } });
  const changed = offerInput(); changed.name = '更新した案件名'; changed.conversions[0].name = '更新した成果地点名';
  await s.store.update(first.id, 1, changed);
  assert.equal((await edit(s, url, { ...selection(first), selectionReason: '理由だけ編集' })).status, 303);
  let plan = await s.read(url);
  assert.equal(plan.offerBinding.offerRevision, 1);
  assert.deepEqual(plan.offerBinding.snapshot, original.offerBinding.snapshot);
  assert.equal(plan.offerBinding.selectionReason, '理由だけ編集');
  const html = await s.get(url);
  assert.match(html, /案件 revision 1/); assert.match(html, /現在の案件は revision 2/);
  assert.match(html, /現在の案件status/); assert.match(html, /理由だけ編集/);
  assert.equal((await edit(s, url, { ...selection(first), offerRevision: '2' })).status, 409);
  assert.equal((await edit(s, url, { ...selection(first), offerRevision: '2', conversionId: 'contract' })).status, 303);
  plan = await s.read(url); assert.equal(plan.offerBinding.offerRevision, 2); assert.equal(plan.offerBinding.conversionId, 'contract');
  const second = await s.store.create({ ...offerInput(), name: '別案件' });
  await s.store.update(second.id, 1, { ...offerInput(), name: '別案件改訂' });
  assert.equal((await edit(s, url, selection({ ...second, revision: 2 }))).status, 303);
  assert.equal((await s.read(url)).offerBinding.offerId, second.id);
  assert.equal((await s.read(url)).offerBinding.offerRevision, 2);
  assert.equal((await edit(s, url, none)).status, 303);
  assert.equal((await s.read(url)).offerBinding, undefined);
  assert.deepEqual((await s.store.history(first.id))[0], first);
});

for (const status of ['paused', 'ended', 'draft']) test(`${status}案件の新規選択拒否・既存選択と削除済み成果地点の保持・警告`, async t => {
  const s = await setup(t); const offer = await s.store.create(offerInput());
  const url = await create(s, selection(offer)); const original = (await s.read(url)).offerBinding;
  await s.store.update(offer.id, 1, { ...offerInput(), status, conversions: [] });
  const home = await s.get('/'); assert.ok(!home.includes(`value="${offer.id}"`));
  assert.equal((await s.post('/plans', { ...values, ...selection({ ...offer, revision: 2 }) })).status, 400);
  assert.equal((await s.post('/plans', { ...values, ...selection(offer) })).status, 400);
  assert.equal((await edit(s, url, selection(offer))).status, 303);
  assert.deepEqual((await s.read(url)).offerBinding, original);
  assert.match(await s.get(url), new RegExp(`現在この案件は${status}です`));
  assert.match(await s.get(url + '/edit'), /保存済み revision 1/);
});

for (const [name, change, status] of [
  ['不正offer ID', { offerId: '../secret' }, 400], ['存在しないoffer', { offerId: randomUUID() }, 404],
  ['別案件のconversion ID', { conversionId: 'other-only' }, 400], ['成果地点未選択', { conversionId: '' }, 400],
  ['存在しないrevision', { offerRevision: '999' }, 400], ['不正revision', { offerRevision: '1e0' }, 400],
  ['unknown field', { snapshot: 'forged' }, 400], ['ネストunknown field', { 'offerBinding.snapshot.offerName': 'forged' }, 400],
  ['秘密情報', { selectionReason: 'api_key=secret-test-value' }, 400], ['理由上限', { selectionReason: 'あ'.repeat(1001) }, 400],
]) test(`紐付け不正入力拒否：${name}`, async t => {
  const s = await setup(t); const offer = await s.store.create(offerInput());
  const other = offerInput(); other.conversions = other.conversions.slice(0, 1); other.conversions[0].id = 'other-only'; await s.store.create(other);
  const response = await s.post('/plans', { ...values, ...selection(offer), ...change });
  assert.equal(response.status, status);
  assert.ok(!(await response.text()).includes('secret-test-value'));
  assert.equal((await readdir(s.directory)).filter(name => name.endsWith('.json')).length, 0);
});

test('古い案件revisionでの新規紐付け・重複項目・紐付け欠落・古い企画タブを拒否', async t => {
  const s = await setup(t); const offer = await s.store.create(offerInput());
  const url = await create(s, selection(offer));
  await s.store.update(offer.id, 1, offerInput());
  assert.equal((await s.post('/plans', { ...values, ...selection(offer) })).status, 409);
  const duplicate = new URLSearchParams({ ...values, ...selection(offer) }); duplicate.append('offerId', offer.id);
  assert.equal((await s.post('/plans', duplicate)).status, 400);
  assert.equal((await edit(s, url, {})).status, 400);
  assert.equal((await edit(s, url, selection(offer))).status, 303);
  assert.equal((await s.post(url + '/edit', { ...values, ...none, planRevision: '1' })).status, 409);
  assert.equal((await s.read(url)).offerBinding.offerRevision, 1);
  assert.equal((await s.post(url + '/edit', { ...values, ...none, planRevision: '2' }, { Origin: 'https://evil.example' })).status, 403);
});

test('案件更新で成果地点が削除されても旧revision維持・別成果地点変更は最新revision', async t => {
  const s = await setup(t); const offer = await s.store.create(offerInput()); const url = await create(s, selection(offer));
  const changed = offerInput(); changed.conversions = changed.conversions.slice(1); await s.store.update(offer.id, 1, changed);
  assert.equal((await edit(s, url, selection(offer))).status, 303);
  assert.match(await s.get(url + '/edit'), /保存済み revision 1/);
  assert.equal((await edit(s, url, { ...selection(offer), conversionId: 'contract' })).status, 409);
  assert.equal((await edit(s, url, { ...selection(offer), offerRevision: '2', conversionId: 'contract' })).status, 303);
});

test('Phase 3の手動・改善・直接生成に案件情報を混入させない（ProviderはFake）', async t => {
  const s = await setup(t); const offer = await s.store.create({ ...offerInput(), name: '案件だけの目印' });
  const url = await create(s, { ...selection(offer), selectionReason: '判断記録だけの目印' }); const plan = await s.read(url);
  const legacy = { ...plan }; delete legacy.offerBinding; delete legacy.revision;
  assert.equal(buildPrompt(plan), buildPrompt(legacy)); assert.equal(buildOpenAIPrompt(plan), buildOpenAIPrompt(legacy));
  const request = { id: randomUUID(), planSnapshot: plan, parentDraftId: randomUUID(), parentRevision: 1, sourceContent: {}, settings: { options: [], mode: 'rewrite', instructions: '' } };
  assert.equal(buildImprovementPrompt(request), buildImprovementPrompt({ ...request, planSnapshot: legacy }));
  const drafts = createDraftStore(s.directory); const provider = createFakeProvider(); let prompt;
  const generate = provider.generate; provider.generate = args => { prompt = args.prompt; return generate(args); };
  const service = createGenerationService({ dataDirectory: s.directory, draftStore: drafts, provider });
  const run = await service.execute(plan, service.confirmation(plan)); assert.equal(run.state, 'succeeded');
  assert.ok(!prompt.includes('案件だけの目印')); assert.ok(!prompt.includes('判断記録だけの目印'));
  const draft = await drafts.get(run.draftId); assert.equal(draft.inputSnapshot.offerBinding, undefined);
  const before = JSON.stringify(draft);
  const improvements = createImprovementStore(s.directory);
  const improvement = await improvements.create(plan, draft, request.settings);
  assert.ok(!improvement.prompt.includes('offerBinding'));
  await edit(s, url, none);
  assert.equal(JSON.stringify(await drafts.get(run.draftId)), before);
});

test('画面は人間向け名称・エスケープ済み選択肢のみで報酬やURLを複製しない', async t => {
  const s = await setup(t); const input = offerInput(); input.name = '<script>案件</script>';
  const offer = await s.store.create(input); const home = await s.get('/');
  assert.match(home, /&lt;script&gt;案件/); assert.ok(!home.includes('<script>案件'));
  assert.match(home, /name="offerId"/); assert.match(home, /name="conversionId"/);
  assert.ok(!home.includes(input.conversions[0].affiliateUrl)); assert.ok(!home.includes('internal_only'));
  const url = await create(s, selection(offer)); const raw = JSON.stringify(await s.read(url));
  for (const text of ['reward', 'affiliateUrl', 'internal_only', 'source_checked']) assert.ok(!raw.includes(text));
});
