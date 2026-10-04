import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createApp } from '../server.js';
import { createOfferImportStore } from '../lib/offer-import/store.js';
import { regulationFixture, importTime } from './fixtures/regulation-import.js';

async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'yoshio-import-ui-'));
  const store = createOfferImportStore(directory, { now: () => new Date(importTime), ...options });
  const draft = await store.create({ targetOffer: null, ...regulationFixture() });
  const server = createApp({ dataDirectory: directory, offerImportOptions: { store } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `/offer-imports/${draft.id}`;
  return { directory, store, draft, route, base, file: path.join(directory, 'offer-imports', `${draft.id}.json`),
    get: suffix => fetch(base + suffix), post: (suffix, body, headers = { Origin: base }) => fetch(base + suffix, { method: 'POST', body, headers, redirect: 'manual' }) };
}
function form(draft, index = 1, overrides = {}) {
  const c = draft.candidates[index]; const p = c.review.edited || c.original;
  return new URLSearchParams({ revision: String(draft.revision), decision: 'accepted', text: p.text,
    target: p.target, category: p.category, usage: p.usage, purpose: p.purpose, conversionKey: p.conversionKey || '', reason: '', ...overrides });
}
const endpoint = (c, operation = 'review') => `${c.route}/candidates/candidate-2/${operation}`;

test('Step 3: list/detail/history GET show candidates and quotes without writing or invoking generation', async t => {
  const c = await setup(t); const before = await fs.readFile(c.file, 'utf8');
  assert.match(await (await c.get('/')).text(), /href="\/offer-imports"/);
  assert.match(await (await c.get('/offer-imports')).text(), /候補9件/);
  const response = await c.get(c.route); const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(html, /採用は正式案件への反映・公開許可・出典照合済みを意味しません/);
  assert.match(html, /根拠引用/); assert.match(html, /AIの抽出原文/);
  assert.ok(!html.includes('name="sourceChecked"'));
  const historical = await (await c.get(`${c.route}/revisions/1`)).text();
  assert.ok(!historical.includes('<form')); assert.match(historical, /過去版/);
  assert.equal(await fs.readFile(c.file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(c.directory), ['offer-imports']);
});

test('Step 3: accept then independently verify, edit resets verification, reject excludes candidate', async t => {
  const c = await setup(t);
  let response = await c.post(endpoint(c), form(c.draft));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), c.route);
  let draft = await c.store.get(c.draft.id);
  assert.equal(draft.candidates[1].review.decision, 'accepted');
  assert.equal(draft.candidates[1].review.verification, 'unverified');
  assert.match(await (await c.get(c.route)).text(), /保存済みの採用候補だけを照合対象/);
  response = await c.post(endpoint(c, 'verify'), new URLSearchParams({ revision: '2', confirm: 'yes' }));
  assert.equal(response.status, 303);
  draft = await c.store.get(c.draft.id);
  assert.equal(draft.candidates[1].review.verification, 'source_checked');
  assert.equal((await c.post(endpoint(c), form(draft, 1, { text: '月額1,000円（税込1,100円）。条件は要確認。' }))).status, 303);
  draft = await c.store.get(c.draft.id);
  assert.equal(draft.candidates[1].review.verification, 'unverified');
  assert.deepEqual(draft.candidates[1].original, c.draft.candidates[1].original);
  assert.equal((await c.post(endpoint(c), form(draft, 1, { decision: 'rejected' }))).status, 303);
  assert.equal((await c.store.get(c.draft.id)).candidates[1].review.decision, 'rejected');
  assert.deepEqual(await fs.readdir(c.directory), ['offer-imports']);
});

test('Step 3: pending cannot verify and explicit checkbox is required for accepted candidate', async t => {
  const c = await setup(t);
  assert.equal((await c.post(endpoint(c, 'verify'), new URLSearchParams({ revision: '1', confirm: 'yes' }))).status, 400);
  await c.post(endpoint(c), form(c.draft));
  for (const body of [{ revision: '2' }, { revision: '2', confirm: 'no' }, { revision: '2', confirm: 'yes', text: 'injected' }]) {
    assert.equal((await c.post(endpoint(c, 'verify'), new URLSearchParams(body))).status, 400);
  }
  assert.equal((await c.store.get(c.draft.id)).candidates[1].review.verification, 'unverified');
});

test('Step 3: stale review and stale verification stop at 409 without controls or overwrite', async t => {
  const c = await setup(t); await c.post(endpoint(c), form(c.draft));
  const before = await fs.readFile(c.file, 'utf8');
  for (const [url, body] of [[endpoint(c), form(c.draft)], [endpoint(c, 'verify'), new URLSearchParams({ revision: '1', confirm: 'yes' })]]) {
    const response = await c.post(url, body); const html = await response.text();
    assert.equal(response.status, 409); assert.match(html, /最新版を再読込/);
    assert.ok(!html.includes('<form')); assert.ok(!html.includes(c.draft.candidates[1].original.text));
  }
  assert.equal(await fs.readFile(c.file, 'utf8'), before);
});

test('Step 3: leftover lock gives safe stopped page and preserves history', async t => {
  const c = await setup(t); await fs.mkdir(path.join(c.directory, 'offer-imports/.lock'));
  const response = await c.post(endpoint(c), form(c.draft));
  assert.equal(response.status, 409); assert.match(await response.text(), /再送せず/);
  assert.equal((await c.store.get(c.draft.id)).revision, 1);
});

test('Step 3: save failure is 503, never echoes exception or submitted text, explicit reload required', async t => {
  let fail = false;
  const c = await setup(t, { fileSystem: { ...fs, async rename(...args) { if (fail) throw new Error('password=sentinel'); return fs.rename(...args); } } });
  const before = await fs.readFile(c.file, 'utf8'); fail = true;
  const response = await c.post(endpoint(c), form(c.draft, 1, { text: '修正sentinel' }));
  const html = await response.text();
  assert.equal(response.status, 503); assert.ok(!html.includes('sentinel')); assert.ok(!html.includes('<form'));
  assert.equal(await fs.readFile(c.file, 'utf8'), before);
  assert.equal((await c.get(c.route)).status, 200);
});

test('Step 3: Origin required, cross-site blocked, localhost host restriction unchanged', async t => {
  const c = await setup(t);
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://example.test' }, { Origin: c.base, 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await c.post(endpoint(c), form(c.draft), headers)).status, 403);
  }
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(c.base + c.route, { headers: { Host: 'example.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await c.store.get(c.draft.id)).revision, 1);
});

test('Step 3: unsupported body, oversized input and duplicate fields are rejected', async t => {
  const c = await setup(t);
  assert.equal((await c.post(endpoint(c), '{}', { Origin: c.base, 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await c.post(endpoint(c), new URLSearchParams({ huge: 'x'.repeat(100001) }))).status, 413);
  const duplicate = form(c.draft); duplicate.append('decision', 'rejected');
  assert.equal((await c.post(endpoint(c), duplicate)).status, 400);
});

for (const key of ['sourceChecked', 'verification', 'checkedAt', 'status', 'evidence', 'original', 'targetOffer', 'publishPermission']) {
  test(`Step 3: browser cannot inject ${key}`, async t => {
    const c = await setup(t);
    assert.equal((await c.post(endpoint(c), form(c.draft, 1, { [key]: 'sentinel' }))).status, 400);
    assert.equal((await c.store.get(c.draft.id)).revision, 1);
  });
}

test('Step 3: secret review input and corrupt stored history are never echoed', async t => {
  const c = await setup(t);
  const response = await c.post(endpoint(c), form(c.draft, 1, { text: 'password=sentinel' }));
  assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('sentinel'));
  await fs.writeFile(c.file, '{password=sentinel');
  for (const route of [c.route, '/offer-imports']) {
    const r = await c.get(route); assert.equal(r.status, 503); assert.ok(!(await r.text()).includes('sentinel'));
  }
});

test('Step 3: XSS candidate text is escaped and historical page cannot edit', async t => {
  const c = await setup(t);
  const malicious = '<img src=x onerror="alert(1)">';
  await c.post(endpoint(c), form(c.draft, 1, { text: malicious, decision: 'pending' }));
  const html = await (await c.get(c.route)).text();
  assert.ok(!html.includes(malicious)); assert.match(html, /&lt;img/);
  assert.equal((await c.post(`${c.route}/revisions/1`, form(c.draft))).status, 404);
});

test('Step 3: no create/analysis/apply/publish routes are available', async t => {
  const c = await setup(t);
  for (const route of ['/offer-imports', `${c.route}/apply`, `${c.route}/analyze`, `${c.route}/publish`]) {
    assert.equal((await c.post(route, form(c.draft))).status, 404);
  }
  const js = await (await c.get('/offer-import.js')).text();
  assert.match(js, /button.disabled = true/); assert.ok(!/fetch\(|localStorage/.test(js));
});

test('Step 3: concurrent HTTP reviews cannot overwrite each other', async t => {
  const c = await setup(t);
  const responses = await Promise.all([c.post(endpoint(c), form(c.draft)), c.post(endpoint(c), form(c.draft, 1, { decision: 'rejected' }))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [303, 409]);
  assert.equal((await c.store.get(c.draft.id)).revision, 2);
});

test('Step 3: a publishable proposal is accepted unverified and invalid goal classification is stopped', async t => {
  const c = await setup(t);
  assert.equal((await c.post(endpoint(c), form(c.draft, 1, { usage: 'publishable' }))).status, 303);
  let draft = await c.store.get(c.draft.id);
  assert.equal(draft.candidates[1].review.verification, 'unverified');
  const response = await c.post(`${c.route}/candidates/candidate-4/review`, form(draft, 3, {
    target: 'approvalConditions', category: 'approval', conversionKey: 'membership',
  }));
  assert.equal(response.status, 400);
  draft = await c.store.get(c.draft.id);
  assert.equal(draft.revision, 2);
  assert.equal(draft.candidates[3].review.decision, 'pending');
});
