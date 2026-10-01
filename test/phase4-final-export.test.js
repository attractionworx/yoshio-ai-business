import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server.js';
import { createDraftStore } from '../lib/drafts.js';
import { checkFinalExport, copyFields } from '../lib/final-export-check.js';
import { affiliateHumanChecks, validationFingerprint } from '../lib/affiliate-publication.js';
import { contentHash, affiliateContextHash } from '../lib/affiliate-validation.js';
import { publicationData } from '../lib/publish.js';
import { publishPage } from '../lib/publish-page.js';
import { affiliateDraftFixture } from './fixtures/affiliate-draft.js';
import { publicationInput } from './fixtures/affiliate-publication.js';
import { blockedConnections } from './helpers/network-guard.js';
import { createImprovementStore } from '../lib/improvements.js';
import { draftPages } from '../lib/draft-pages.js';

const e = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
async function ready(t) {
  const c = await affiliateDraftFixture(t);
  c.draft = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
  return c;
}
const input = (d, field = 'body') => new URLSearchParams({ revision: String(d.revision), field });
async function persist(c) { await writeFile(c.file, JSON.stringify(c.draft)); }
async function refused(c, reasonCode) {
  const before = structuredClone(c.draft);
  const result = await c.drafts.copy(c.draft.id, input(c.draft));
  assert.equal(result.result, 'blocked'); assert.equal(result.reasonCode, reasonCode);
  assert.equal(Object.hasOwn(result, 'text'), false);
  const after = await c.drafts.get(c.draft.id);
  for (const key of ['edited', 'affiliateContext', 'affiliateValidation', 'affiliateValidationFailure', 'affiliateValidationRunId']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.publication?.affiliate?.humanConfirmation, before.publication?.affiliate?.humanConfirmation);
  if (before.publication?.status === '公開準備OK') { assert.equal(after.publication.status, '要修正'); assert.equal(after.publication.readyAt, null); }
  return result;
}

test('Step 5.5: ready final check passes without mutation or caching', async t => {
  const c = await ready(t); const before = await readFile(c.file, 'utf8');
  assert.deepEqual(await checkFinalExport(c.draft, c.offers), { result: 'pass', reasonCode: 'export-ready' });
  for (const field of copyFields) {
    const r = await c.drafts.copy(c.draft.id, input(c.draft, field));
    assert.equal(r.result, 'pass'); assert.equal(r.text, publicationData(c.draft, 0)[field]);
  }
  assert.equal(await readFile(c.file, 'utf8'), before);
});
for (const state of ['stale', 'invalid', 'failed', 'unvalidated']) test(`Step 5.5: validation ${state} refuses text and preserves evidence`, async t => {
  const c = await ready(t);
  if (state === 'stale') c.draft.edited.summary += '変更';
  if (state === 'invalid') c.draft.affiliateValidation.schemaVersion = 999;
  if (state === 'unvalidated') delete c.draft.affiliateValidation;
  if (state === 'failed') c.draft.affiliateValidationFailure = { schemaVersion: 1, code: 'validation-unavailable', attemptedAt: new Date().toISOString(), contentHash: contentHash(c.draft.edited), affiliateContextHash: affiliateContextHash(c.draft.affiliateContext) };
  await persist(c); await refused(c, `validation-${state}`);
});
test('Step 5.5: block cannot be bypassed by ready publication', async t => {
  const c = await affiliateDraftFixture(t, { summary: '絶対成功' });
  c.draft.publication = { status: '公開準備OK', readyAt: new Date().toISOString() };
  await persist(c); await refused(c, 'validation-blocked');
});
test('Step 5.5: current warnings must each be confirmed', async t => {
  const c = await ready(t); const h = c.draft.publication.affiliate.humanConfirmation;
  assert.ok(h.warningResolutions.length); h.warningResolutions.pop(); h.confirmedAt = null;
  await persist(c); await refused(c, 'warning-confirmation-required');
});
for (const [key] of affiliateHumanChecks) test(`Step 5.5: missing ${key} refuses`, async t => {
  const c = await ready(t); const h = c.draft.publication.affiliate.humanConfirmation;
  h.requiredChecks[key] = false; h.confirmedAt = null; await persist(c); await refused(c, 'human-confirmation-required');
});
test('Step 5.5: human confirmation must match current validation', async t => {
  const c = await ready(t); c.draft.publication.affiliate.humanConfirmation.validationFingerprint = 'a'.repeat(64);
  await persist(c); await refused(c, 'human-confirmation-required');
});
test('Step 5.5: publication fingerprint must match current validation', async t => {
  const c = await ready(t); c.draft.publication.affiliate.validationFingerprint = 'a'.repeat(64);
  await persist(c); await refused(c, 'validation-fingerprint-mismatch');
});
for (const status of ['要修正', '最終承認待ち', null]) test(`Step 5.5: publication ${status} cannot export`, async t => {
  const c = await ready(t); if (status) c.draft.publication.status = status; else delete c.draft.publication;
  await persist(c); await refused(c, 'publication-not-ready');
});
test('Step 5.5: normal edited save invalidates old publication', async t => {
  const c = await ready(t); const old = c.draft;
  c.draft = await c.drafts.update(old.id, old.revision, { ...old.edited, body: old.edited.body + '\n変更' }, 'save');
  assert.equal(c.draft.publication, undefined);
  assert.equal((await c.drafts.copy(old.id, input(old))).reasonCode, 'draft-changed');
  await refused(c, 'publication-not-ready');
});
test('Step 5.5: even current revalidation cannot reuse old content publication', async t => {
  const c = await ready(t); const p = structuredClone(c.draft.publication);
  c.draft = await c.drafts.update(c.draft.id, c.draft.revision, { ...c.draft.edited, summary: '変更' }, 'save');
  c.draft.publication = p;
  c.draft.publication.affiliate.validationFingerprint = validationFingerprint(c.draft);
  await persist(c); await refused(c, 'draft-changed');
});
const changes = [
  ['paused', { status: 'paused' }, 'offer-paused'], ['ended', { status: 'ended' }, 'offer-ended'],
  ['revision', { revision: 2 }, 'revision-mismatch'],
  ['conversion disabled', { conversions: [{ id: 'consultation', status: 'paused' }] }, 'conversion-unavailable'],
  ['conversion removed', { conversions: [] }, 'conversion-missing'],
  ['expired', { validUntil: '2000-01-01T00:00:00Z' }, 'offer-expired'],
  ['not started', { validFrom: '2099-01-01T00:00:00Z' }, 'offer-not-started'],
  ['review due', { reviewDueAt: '2000-01-01T00:00:00Z' }, 'offer-review-due'],
];
for (const [name, change, code] of changes) test(`Step 5.5: saved offer pass ignored after ${name}`, async t => {
  const c = await ready(t); assert.equal(c.draft.publication.affiliate.currentOfferCheck.result, 'pass');
  let reads = 0;
  c.drafts = createDraftStore(c.directory, { offerStore: { get: async () => { reads++; return { ...c.offer, ...change }; } } });
  await refused(c, code); assert.equal(reads, 1);
});
test('Step 5.5: actual offer store read again after ready and update', async t => {
  const c = await ready(t); await c.offers.update(c.offer.id, 1, { ...c.input, status: 'paused' });
  await refused(c, 'offer-paused');
});
test('Step 5.5: offer deleted after ready refuses without switching offer', async t => {
  const c = await ready(t); await unlink(path.join(c.directory, 'offers', `${c.offer.id}.json`));
  await refused(c, 'offer-missing');
});
test('Step 5.5: store errors and invalid status do not leak secrets', async t => {
  const c = await ready(t);
  for (const store of [{ get: async () => { throw new Error('password=SYNTHETIC_SECRET'); } }, { get: async () => ({ ...c.offer, status: 'password=SYNTHETIC_SECRET' }) }]) {
    const result = await checkFinalExport(c.draft, store);
    assert.equal(result.result, 'blocked'); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
  }
});
test('Step 5.5: previous final pass never reusable; context, conversion, offer immutable', async t => {
  const c = await ready(t); const before = structuredClone(c.draft.affiliateContext);
  assert.equal((await c.drafts.copy(c.draft.id, input(c.draft))).result, 'pass');
  c.draft.publication.finalExportCheck = { result: 'pass', reasonCode: 'export-ready' }; await persist(c);
  await c.offers.update(c.offer.id, 1, c.input);
  await refused(c, 'revision-mismatch');
  assert.deepEqual((await c.drafts.get(c.draft.id)).affiliateContext, before);
  assert.equal((await c.offers.get(c.offer.id)).revision, 2);
});
for (const key of ['publish-ready', 'affiliateValidation', 'validationFingerprint', 'humanConfirmation', 'warningResolutions', 'status', 'revisionOverride', 'conversion', 'expiry', 'currentOfferCheck', 'exportPermission', 'finalExportCheck']) test(`Step 5.5: client ${key} injection rejected`, async t => {
  const c = await ready(t); const form = input(c.draft); form.append(key, 'password=SYNTHETIC_SECRET');
  const before = await readFile(c.file, 'utf8');
  const r = await c.drafts.copy(c.draft.id, form);
  assert.equal(r.reasonCode, 'invalid-request'); assert.equal(Object.hasOwn(r, 'text'), false);
  assert.ok(!JSON.stringify(r).includes('SYNTHETIC_SECRET')); assert.equal(await readFile(c.file, 'utf8'), before);
});
for (const field of ['cta', 'originalRaw', 'affiliateContext', 'prompt', 'unknown']) test(`Step 5.5: arbitrary export field ${field} refused`, async t => {
  const c = await ready(t); assert.equal((await c.drafts.copy(c.draft.id, input(c.draft, field))).reasonCode, 'invalid-request');
});
test('Step 5.5: duplicate field/revision refused', async t => {
  const c = await ready(t);
  for (const key of ['revision', 'field']) { const form = input(c.draft); form.append(key, form.get(key)); assert.equal((await c.drafts.copy(c.draft.id, form)).reasonCode, 'invalid-request'); }
});
for (const absent of ['affiliateValidation', 'affiliate', 'currentOfferCheck', 'contentHash', 'humanConfirmation']) test(`Step 5.5: legacy ready missing ${absent} cannot bypass`, async t => {
  const c = await ready(t);
  if (absent === 'affiliateValidation') delete c.draft[absent];
  else if (['affiliate', 'contentHash'].includes(absent)) delete c.draft.publication[absent];
  else delete c.draft.publication.affiliate[absent];
  await persist(c); const r = await c.drafts.copy(c.draft.id, input(c.draft));
  assert.equal(r.result, 'blocked'); assert.equal(Object.hasOwn(r, 'text'), false);
});
test('Step 5.5: plain draft retains local clipboard content and skips offer access', async t => {
  const c = await ready(t); delete c.draft.affiliateContext; delete c.draft.affiliateValidation;
  await persist(c); c.drafts = createDraftStore(c.directory, { offerStore: { get: () => { throw new Error('must not read'); } } });
  assert.equal((await c.drafts.copy(c.draft.id, input(c.draft))).text, c.draft.edited.body);
  const html = publishPage(c.draft, e); assert.ok(html.includes(e(c.draft.edited.body))); assert.ok(!html.includes('data-copy-endpoint'));
});
test('Step 5.5: affiliate GET offers no pre-authorized copy text or secret management data', async t => {
  const c = await ready(t); const html = publishPage(c.draft, e);
  assert.match(html, /data-copy-endpoint/);
  assert.match(html, /id="publish-body"[^>]*><\/textarea>/);
  for (const secret of [c.offer.conversions[0].affiliateUrl, c.offer.sources[0].publicUrl, '非公開情報専用目印', '報酬管理専用目印', 'management-only', 'reward', 'internal_only']) {
    assert.ok(!html.includes(secret)); assert.ok(!JSON.stringify(await c.drafts.copy(c.draft.id, input(c.draft))).includes(secret));
  }
});
test('Step 5.5: copy serialized with edits cannot return old ready body', async t => {
  const c = await ready(t);
  const edit = c.drafts.update(c.draft.id, c.draft.revision, { ...c.draft.edited, summary: '変更' }, 'save');
  const copy = c.drafts.copy(c.draft.id, input(c.draft));
  await edit; assert.equal((await copy).reasonCode, 'draft-changed'); assert.equal(Object.hasOwn(await copy, 'text'), false);
});
async function httpFixture(t) {
  const c = await ready(t); const server = createApp({ dataDirectory: c.directory });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...c, base, post: (form = input(c.draft), origin = base) => fetch(`${base}/drafts/${c.draft.id}/copy`, { method: 'POST', headers: { Origin: origin }, body: form }) };
}
test('Step 5.5 HTTP: POST returns exact allowed text, no-store, GET no raw export', async t => {
  const c = await httpFixture(t); const r = await c.post();
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal((await r.json()).text, c.draft.edited.body);
  for (const suffix of ['copy', 'export', 'download', 'raw']) assert.equal((await fetch(`${c.base}/drafts/${c.draft.id}/${suffix}`)).status, 404);
});
test('Step 5.5 HTTP: offer changed after GET fails next POST without text or finding changes', async t => {
  const c = await httpFixture(t); assert.equal((await fetch(`${c.base}/drafts/${c.draft.id}/publish`)).status, 200);
  await c.offers.update(c.offer.id, 1, { ...c.input, status: 'paused' });
  const r = await c.post(); assert.equal(r.status, 409); const body = await r.json(); assert.equal(body.reasonCode, 'offer-paused'); assert.equal(Object.hasOwn(body, 'text'), false);
  assert.deepEqual((await c.drafts.get(c.draft.id)).affiliateValidation, c.draft.affiliateValidation);
});
test('Step 5.5 HTTP: origin, spoofing, secret input fail closed and do not log content', async t => {
  const c = await httpFixture(t); const logs = []; const original = console.error; console.error = (...args) => logs.push(args.join(' ')); t.after(() => { console.error = original; });
  assert.equal((await c.post(input(c.draft), 'http://external.invalid')).status, 403);
  const form = input(c.draft); form.append('exportPermission', 'password=SYNTHETIC_SECRET');
  const r = await c.post(form); assert.equal(r.status, 409); assert.ok(!(await r.text()).includes('SYNTHETIC_SECRET')); assert.deepEqual(logs, []);
});
test('Step 5.5: no outward communication', async t => {
  const before = blockedConnections.length; const c = await ready(t); await c.drafts.copy(c.draft.id, input(c.draft)); assert.equal(blockedConnections.length, before);
});
test('Step 5.5: affiliate editor offers no ungated improvement prompt copy', async t => {
  const c = await ready(t);
  const html = draftPages({ escapeHtml: e, formatDate: e }).editor(c.draft);
  assert.ok(!html.includes('data-improve')); assert.match(html, /案件根拠の継承に未対応/);
});
test('Step 5.5: legacy affiliate improvement cannot create ungated plain child', async t => {
  const c = await ready(t);
  const request = await createImprovementStore(c.directory).create(c.plan, c.draft, { options: [], mode: 'rewrite', instructions: '' });
  await assert.rejects(c.drafts.create(c.plan, { content: c.content }, JSON.stringify(c.content), request.prompt, request), /案件根拠を引き継ぐ仕組みが未対応/);
  assert.equal((await c.drafts.list(c.plan.id)).length, 1);
});
test('Step 5.5 HTTP: affiliate improvement creation, old prompt GET and import blocked', async t => {
  const c = await httpFixture(t);
  const request = await createImprovementStore(c.directory).create(c.plan, c.draft, { options: [], mode: 'rewrite', instructions: '' });
  const before = await readFile(c.file, 'utf8');
  const creation = await fetch(`${c.base}/drafts/${c.draft.id}/improve`, { method: 'POST', headers: { Origin: c.base }, body: new URLSearchParams({ revision: String(c.draft.revision), mode: 'rewrite' }), redirect: 'manual' });
  assert.equal(creation.status, 409);
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${c.base}/improvements/${request.id}`, { method, ...(method === 'POST' ? { headers: { Origin: c.base }, body: new URLSearchParams({ result: '{}' }) } : {}) });
    assert.equal(response.status, 409); const html = await response.text(); assert.ok(!html.includes(c.draft.edited.body)); assert.ok(!html.includes('data-copy'));
  }
  assert.equal(await readFile(c.file, 'utf8'), before);
});
test('Step 5.5 HTTP: malformed and oversized requests return fixed errors without text', async t => {
  const c = await httpFixture(t);
  for (const [headers, body, status] of [
    [{ 'Content-Type': 'application/json' }, '{"secret":"SYNTHETIC_SECRET"}', 415],
    [{ 'Content-Type': 'application/x-www-form-urlencoded' }, 'secret=' + 'SYNTHETIC_SECRET'.repeat(200), 413],
    [{ 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' }, input(c.draft).toString(), 403],
  ]) {
    const r = await fetch(`${c.base}/drafts/${c.draft.id}/copy`, { method: 'POST', headers: { Origin: c.base, ...headers }, body });
    assert.equal(r.status, status); const result = await r.json(); assert.equal(result.reasonCode, 'copy-unavailable');
    assert.equal(Object.hasOwn(result, 'text'), false); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
  }
});
