import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { checkCurrentOffer, currentOfferCheckPasses } from '../lib/current-offer-check.js';
import { preparePublication } from '../lib/publish.js';
import { affiliatePublicationIsCurrent } from '../lib/affiliate-publication.js';
import { publicationInput } from './fixtures/affiliate-publication.js';
import { affiliateDraftFixture } from './fixtures/affiliate-draft.js';
import { publishPage } from '../lib/publish-page.js';
import { blockedConnections } from './helpers/network-guard.js';
const now = new Date('2026-01-01T00:00:00Z');
const e = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const cases = [
  ['active', {}, 'offer-active'], ['paused', { status: 'paused' }, 'offer-paused'],
  ['ended', { status: 'ended' }, 'offer-ended'], ['unknown', { status: 'password=SYNTHETIC_SECRET' }, 'unknown-status'],
  ['draft status', { status: 'draft' }, 'unknown-status'], ['revision', { revision: 2 }, 'revision-mismatch'],
  ['conversion missing', { conversions: [] }, 'conversion-missing'],
  ['conversion paused', { conversions: [{ id: 'consultation', status: 'paused' }] }, 'conversion-unavailable'],
  ['conversion ended', { conversions: [{ id: 'consultation', status: 'ended' }] }, 'conversion-unavailable'],
  ['conversion unknown', { conversions: [{ id: 'consultation', status: 'unknown' }] }, 'conversion-unavailable'],
  ['expired boundary', { validUntil: now.toISOString() }, 'offer-expired'],
  ['valid', { validFrom: '2025-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' }, 'offer-active'],
  ['not started', { validFrom: '2027-01-01T00:00:00Z' }, 'offer-not-started'],
  ['review due', { reviewDueAt: now.toISOString() }, 'offer-review-due'],
  ['bad expiry', { validUntil: 'secret-value' }, 'invalid-current-state'],
];
for (const [name, changes, reasonCode] of cases) test(`Step 5.4: ${name}`, async t => {
  const c = await affiliateDraftFixture(t); const original = structuredClone(c.draft);
  const check = await checkCurrentOffer(c.draft, { get: async id => { assert.equal(id, c.offer.id); return { ...c.offer, ...changes }; } }, now);
  assert.equal(check.reasonCode, reasonCode); assert.equal(check.result, reasonCode === 'offer-active' ? 'pass' : 'blocked');
  assert.equal(currentOfferCheckPasses(c.draft, check), check.result === 'pass'); assert.deepEqual(c.draft, original);
  assert.ok(!JSON.stringify(check).includes('SYNTHETIC_SECRET')); assert.ok(!JSON.stringify(check).includes('secret-value'));
});
for (const status of [404, 503]) test(`Step 5.4: store failure ${status}`, async t => {
  const c = await affiliateDraftFixture(t); const check = await checkCurrentOffer(c.draft, { get: async () => { throw Object.assign(new Error('password=SYNTHETIC_SECRET'), { status }); } });
  assert.equal(check.reasonCode, status === 404 ? 'offer-missing' : 'offer-unavailable'); assert.ok(!JSON.stringify(check).includes('SYNTHETIC_SECRET'));
});
for (const key of ['status', 'currentRevision', 'conversionAvailability', 'expiry', 'currentOfferCheck']) test(`Step 5.4: client ${key} injection refused`, async t => {
  const c = await affiliateDraftFixture(t); const before = await readFile(c.file, 'utf8');
  await assert.rejects(c.drafts.update(c.draft.id, c.draft.revision, { ...publicationInput(c.draft), [key]: 'active' }, 'publish'), /未知|不正/);
  assert.equal(await readFile(c.file, 'utf8'), before);
});
test('Step 5.4: real local store pass, GET unchanged, publication tracked', async t => {
  const c = await affiliateDraftFixture(t); const d = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
  assert.equal(d.publication.status, '公開準備OK'); assert.equal(d.publication.affiliate.currentOfferCheck.result, 'pass'); assert.equal(affiliatePublicationIsCurrent(d), true);
  const before = await readFile(c.file, 'utf8'); assert.match(publishPage(d, e), /pass：現在案件チェック成功/); assert.equal(await readFile(c.file, 'utf8'), before);
});
for (const [name, changes, code] of [['paused', { status: 'paused' }, 'offer-paused'], ['ended', { status: 'ended' }, 'offer-ended'], ['revision', {}, 'revision-mismatch']]) test(`Step 5.4: old ready invalidated after ${name}`, async t => {
  const c = await affiliateDraftFixture(t); let d = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
  const context = structuredClone(d.affiliateContext); const validation = structuredClone(d.affiliateValidation);
  await c.offers.update(c.offer.id, 1, { ...c.input, ...changes });
  d = await c.drafts.update(d.id, d.revision, publicationInput(d), 'publish');
  assert.equal(d.publication.status, '要修正'); assert.equal(d.publication.readyAt, null); assert.equal(d.publication.affiliate.currentOfferCheck.reasonCode, code);
  assert.equal(affiliatePublicationIsCurrent(d), true); // current保存結果はblockedとして表示できる。
  assert.deepEqual(d.affiliateContext, context); assert.deepEqual(d.affiliateValidation, validation); assert.ok(d.publication.affiliate.humanConfirmation.confirmedAt);
  assert.match(publishPage(d, e), /blocked/); assert.match(publishPage(d, e), /data-publication-copy="publish-title" disabled/);
});
test('Step 5.4: active return at same revision can recheck without clearing evidence', async t => {
  const c = await affiliateDraftFixture(t); let offer = { ...c.offer, status: 'paused' };
  const { createDraftStore } = await import('../lib/drafts.js'); const drafts = createDraftStore(c.directory, { offerStore: { get: async () => offer } });
  let d = await drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish'); assert.equal(d.publication.status, '要修正');
  offer = c.offer; d = await drafts.update(d.id, d.revision, publicationInput(d), 'publish'); assert.equal(d.publication.status, '公開準備OK');
});
test('Step 5.4: missing offer invalidates ready without switching offer/conversion', async t => {
  const c = await affiliateDraftFixture(t); let d = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
  const { unlink } = await import('node:fs/promises'); const path = await import('node:path'); await unlink(path.join(c.directory, 'offers', `${c.offer.id}.json`));
  d = await c.drafts.update(d.id, d.revision, publicationInput(d), 'publish'); assert.equal(d.publication.status, '要修正'); assert.equal(d.publication.affiliate.currentOfferCheck.reasonCode, 'offer-missing'); assert.deepEqual(d.affiliateContext, c.draft.affiliateContext);
});
for (const state of ['unvalidated', 'stale', 'failed']) test(`Step 5.4: old ${state} draft cannot bypass validation`, async t => {
  const c = await affiliateDraftFixture(t);
  if (state === 'stale') c.draft.edited.summary = 'changed'; else delete c.draft.affiliateValidation;
  if (state === 'failed') c.draft.affiliateValidationFailure = { code: 'validation-unavailable' };
  await writeFile(c.file, JSON.stringify(c.draft));
  await assert.rejects(c.drafts.update(c.draft.id, c.draft.revision, { action: 'ready', titleIndex: '0', experience: 'yes', numbers: 'yes', links: 'yes' }, 'publish'), /current|再検査/);
});
test('Step 5.4: no offer preserves existing flow without store access', async t => {
  const c = await affiliateDraftFixture(t); delete c.draft.affiliateContext;
  assert.equal(await checkCurrentOffer(c.draft, { get: () => { throw new Error('must not access'); } }), null);
  assert.equal(preparePublication(c.draft, publicationInput(c.draft)).status, '公開準備OK'); assert.ok(!publishPage(c.draft, e).includes('data-current-offer-check'));
});
test('Step 5.4: pure publication without server check cannot become ready', async t => {
  const c = await affiliateDraftFixture(t); const p = preparePublication(c.draft, publicationInput(c.draft)); assert.equal(p.status, '要修正'); assert.equal(p.affiliate.currentOfferCheck, null);
});
test('Step 5.4: unsafe saved pass shape not reused', async t => {
  const c = await affiliateDraftFixture(t); const check = await checkCurrentOffer(c.draft, c.offers);
  assert.equal(currentOfferCheckPasses(c.draft, { ...check, secret: 'password=SYNTHETIC_SECRET' }), false);
  const d = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish'); delete d.publication.affiliate.currentOfferCheck; assert.equal(affiliatePublicationIsCurrent(d), false);
});
test('Step 5.4: check and UI contain only allowlisted state, no management data', async t => {
  const c = await affiliateDraftFixture(t); const d = await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish');
  const output = JSON.stringify(d.publication) + publishPage(d, e);
  for (const secret of [c.offer.conversions[0].affiliateUrl, c.offer.sources[0].publicUrl, '非公開情報専用目印', '報酬管理専用目印', 'management-only', 'internal_only', 'reward']) assert.ok(!output.includes(secret));
});
test('Step 5.4: no outward communication', async t => {
  const before = blockedConnections.length; const c = await affiliateDraftFixture(t); await c.drafts.update(c.draft.id, c.draft.revision, publicationInput(c.draft), 'publish'); assert.equal(blockedConnections.length, before);
});
