import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateExtraction, validateOfferImport, hashDocumentText } from '../lib/offer-import/validation.js';
import { createOfferImport, reviewCandidate, approvedCandidatePreview } from '../lib/offer-import/contract.js';
import { importFixture, regulationFixture, importTime } from './fixtures/regulation-import.js';
import { blockedConnections } from './helpers/network-guard.js';

const action = (overrides = {}) => ({ decision: 'accepted', edited: null, sourceChecked: false,
  at: importTime, reason: '', ...overrides });
const review = (draft, id = 'candidate-2', overrides = {}) => reviewCandidate(draft, id, draft.revision, action(overrides));
const rejected = operation => assert.throws(operation, error => error.status === 400 && !error.message.includes('sentinel'));

test('Step 1: fictional extraction creates only pending, unverified independent candidates', () => {
  const draft = importFixture();
  assert.equal(draft.revision, 1);
  assert.equal(draft.targetOffer, null);
  assert.equal(draft.candidates.length, 9);
  for (const c of draft.candidates) {
    assert.equal(c.review.decision, 'pending');
    assert.equal(c.review.verification, 'unverified');
    assert.equal(c.review.checkedAt, null);
  }
  assert.deepEqual(approvedCandidatePreview(draft), []);
  assert.equal(Object.hasOwn(draft, 'status'), false);
});

test('Step 1: deterministic pure creation and validation detach nested caller objects', () => {
  const fixture = regulationFixture();
  const before = structuredClone(fixture);
  const options = { id: '10000000-0000-4000-8000-000000000001', createdAt: importTime, ...fixture };
  const first = createOfferImport(options);
  assert.deepEqual(first, createOfferImport(options));
  first.documents[0].blocks[0].id = 'changed';
  first.candidates[0].original.text = 'changed';
  assert.deepEqual(fixture, before);
  const draft = importFixture();
  const copy = validateOfferImport(draft);
  copy.candidates[0].review.reason = 'changed';
  assert.equal(draft.candidates[0].review.reason, '');
});

test('Step 1: acceptance, source verification and usage remain separate', () => {
  const draft = review(importFixture());
  const p = approvedCandidatePreview(draft)[0];
  assert.equal(p.verification, 'unverified');
  assert.equal(p.checkedAt, null);
  assert.equal(p.payload.usage, 'internal_only');
  assert.deepEqual(p.origins, ['asp']);
  const checked = review(draft, 'candidate-2', { sourceChecked: true });
  assert.equal(checked.candidates[1].review.verification, 'source_checked');
  assert.equal(checked.candidates[0].review.verification, 'unverified');
  assert.equal(approvedCandidatePreview(checked)[0].payload.usage, 'internal_only');
});

test('Step 1: publishable proposal never implies approval or source verification', () => {
  const f = regulationFixture();
  f.extraction.candidates[1].usage = 'publishable';
  const draft = createOfferImport({ id: importFixture().id, createdAt: importTime, ...f });
  assert.deepEqual(approvedCandidatePreview(draft), []);
  const p = approvedCandidatePreview(review(draft))[0];
  assert.equal(p.verification, 'unverified');
  assert.equal(p.payload.usage, 'publishable');
});

test('Step 1: editing preserves AI original and resets prior source verification', () => {
  const draft = review(importFixture(), 'candidate-2', { sourceChecked: true });
  const original = structuredClone(draft.candidates[1].original);
  const edited = { ...structuredClone(original), text: '月額1,000円（税込1,100円）。適用条件は要確認。' };
  const next = review(draft, 'candidate-2', { edited });
  assert.deepEqual(next.candidates[1].original, original);
  assert.equal(next.candidates[1].review.verification, 'unverified');
  assert.equal(next.candidates[1].review.checkedAt, null);
  edited.text = 'caller changed';
  assert.notEqual(next.candidates[1].review.edited.text, edited.text);
  assert.equal(draft.candidates[1].review.verification, 'source_checked');
});

test('Step 1: rejected and pending candidates cannot appear in approved preview', () => {
  const accepted = review(importFixture());
  const rejectedDraft = review(accepted, 'candidate-2', { decision: 'rejected', reason: '条件を再確認するため' });
  assert.deepEqual(approvedCandidatePreview(rejectedDraft), []);
  const pending = review(rejectedDraft, 'candidate-2', { decision: 'pending' });
  assert.equal(pending.candidates[1].review.confirmedHash, null);
  assert.equal(pending.candidates[1].review.reviewedAt, null);
  assert.deepEqual(approvedCandidatePreview(pending), []);
});

const extractionCases = [
  ['AI approval injection', f => { f.extraction.candidates[0].verification = 'source_checked'; }],
  ['AI official ID injection', f => { f.extraction.candidates[0].id = 'statement-1'; }],
  ['AI status injection', f => { f.extraction.status = 'active'; }],
  ['AI timestamp injection', f => { f.extraction.candidates[0].checkedAt = importTime; }],
  ['unknown target', f => { f.extraction.candidates[0].target = 'affiliateUrl'; }],
  ['missing property', f => { delete f.extraction.candidates[0].usage; }],
  ['empty evidence', f => { f.extraction.candidates[0].evidence = []; }],
  ['missing document', f => { f.extraction.candidates[0].evidence[0].documentId = 'missing'; }],
  ['missing block', f => { f.extraction.candidates[0].evidence[0].blockId = 'missing'; }],
  ['invented quote', f => { f.extraction.candidates[0].evidence[0].quote = '資料にないsentinel'; }],
  ['wrong offset', f => { f.extraction.candidates[0].evidence[0].start++; }],
  ['cross block reference', f => { f.extraction.candidates[0].evidence[0].end = f.documents[0].text.length; }],
  ['duplicate evidence', f => { f.extraction.candidates[0].evidence.push(structuredClone(f.extraction.candidates[0].evidence[0])); }],
  ['stale document hash', f => { f.documents[0].text += '変更'; }],
  ['duplicate documents', f => { f.documents.push(structuredClone(f.documents[0])); }],
  ['duplicate blocks', f => { f.documents[0].blocks[1].id = f.documents[0].blocks[0].id; }],
  ['omitted document range', f => { f.documents[0].blocks.pop(); }],
  ['fractional offset', f => { f.documents[0].blocks[0].start = 0.5; }],
  ['marketing goal becomes approval', f => { const c = f.extraction.candidates[3]; c.target = 'approvalConditions'; c.conversionKey = 'membership'; c.category = 'approval'; }],
  ['restriction becomes fact', f => { const c = f.extraction.candidates[2]; c.target = 'facts'; c.category = 'other'; }],
  ['prohibition becomes publishable', f => { f.extraction.candidates[2].usage = 'publishable'; }],
  ['wrong condition category', f => { f.extraction.candidates[4].category = 'feature'; }],
  ['condition has no conversion group', f => { f.extraction.candidates[4].conversionKey = null; }],
  ['fact has conversion group', f => { f.extraction.candidates[1].conversionKey = 'membership'; }],
  ['reward becomes publishable', f => { f.extraction.candidates[8].usage = 'publishable'; }],
  ['reward becomes ordinary fact', f => { const c = f.extraction.candidates[8]; c.target = 'facts'; c.conversionKey = null; }],
  ['condition is called ordinary fact', f => { f.extraction.candidates[4].purpose = 'fact'; }],
  ['oversized text', f => { f.extraction.candidates[0].text = 'x'.repeat(5001); }],
  ['too many candidates', f => { f.extraction.candidates = Array(201).fill(f.extraction.candidates[0]); }],
  ['unsupported format', f => { f.documents[0].format = 'pdf'; }],
];
for (const [name, mutate] of extractionCases) test(`Step 1 extraction rejects: ${name}`, () => {
  const f = regulationFixture();
  mutate(f);
  const before = structuredClone(f);
  rejected(() => validateExtraction(f.extraction, f.documents));
  assert.deepEqual(f, before);
});

for (const secret of ['password=sentinel', 'Cookie: sentinel', 'sk-sentinel12345678',
  'https://example.test/?token=sentinel', 'https://user:sentinel@example.test/', '<html>管理画面sentinel</html>']) {
  test(`Step 1 secrets rejected before draft creation: ${secret.split(/[=:]/)[0]}`, () => {
    const f = regulationFixture();
    f.documents[0].text = secret;
    f.documents[0].textHash = hashDocumentText(secret);
    rejected(() => validateExtraction(f.extraction, f.documents));
    const draft = importFixture();
    draft.candidates[0].original.text = secret;
    rejected(() => validateOfferImport(draft));
    const edited = { ...draft.candidates[1].original, text: secret };
    rejected(() => review(importFixture(), 'candidate-2', { edited }));
  });
}

const draftCases = [
  ['unknown root field', d => { d.appliedRevision = 2; }],
  ['duplicate candidate ID', d => { d.candidates[1].id = d.candidates[0].id; }],
  ['pending marked checked', d => { d.candidates[0].review.verification = 'source_checked'; }],
  ['accepted without confirmation', d => { d.candidates[0].review.decision = 'accepted'; }],
  ['stale edited review hash', d => { d.candidates[1].original.text = '創作した料金'; }],
  ['stale evidence review hash', d => { d.candidates[1].original.evidence = structuredClone(d.candidates[0].original.evidence); }],
  ['stale document version hash', d => { d.documents[0].text += '\n変更'; d.documents[0].textHash = hashDocumentText(d.documents[0].text); d.documents[0].blocks.at(-1).end = d.documents[0].text.length; }],
  ['source origin changed after review', d => { d.documents[0].kind = 'advertiser_material'; }],
  ['source version changed after review', d => { d.documents[0].versionLabel = '別版'; }],
  ['source label changed after review', d => { d.documents[0].label = '別資料'; }],
  ['unchecked with checked timestamp', d => { d.candidates[0].review.checkedAt = importTime; }],
  ['invalid calendar date', d => { d.createdAt = '2026-02-30T00:00:00Z'; }],
  ['review timestamp in future', d => { d.candidates[1].review.reviewedAt = '2027-01-01T00:00:00Z'; }],
  ['invalid target revision', d => { d.targetOffer = { id: d.id, revision: 0 }; }],
];
for (const [name, mutate] of draftCases) test(`Step 1 draft rejects: ${name}`, () => {
  const d = review(importFixture());
  mutate(d);
  rejected(() => validateOfferImport(d));
});

test('Step 1: unmapped evidence can remain pending/rejected but cannot be accepted', () => {
  const f = regulationFixture();
  f.extraction.candidates[0] = { ...f.extraction.candidates[0], target: 'unmapped', purpose: 'unmapped', usage: 'internal_only' };
  const d = createOfferImport({ id: importFixture().id, createdAt: importTime, ...f });
  rejected(() => review(d, 'candidate-1'));
  assert.deepEqual(approvedCandidatePreview(review(d, 'candidate-1', { decision: 'rejected' })), []);
});

test('Step 1: stale review revision, unknown actions and non-accepted checking rejected', () => {
  const d = review(importFixture());
  assert.throws(() => reviewCandidate(d, 'candidate-2', 1, action()), { status: 409 });
  rejected(() => review(d, 'missing'));
  rejected(() => review(d, 'candidate-2', { status: 'active' }));
  rejected(() => review(d, 'candidate-2', { decision: 'rejected', sourceChecked: true }));
  rejected(() => review(d, 'candidate-2', { at: '2026-10-03T00:00:00Z' }));
});

test('Step 1: exact evidence matching uses original UTF-16 positions including emoji/newlines', () => {
  const f = regulationFixture();
  const text = '架空🧩\n月額100円。';
  f.documents[0].text = text;
  f.documents[0].textHash = hashDocumentText(text);
  f.documents[0].blocks = [{ id: 'paragraph-1', start: 0, end: text.length }];
  f.extraction.candidates = [{ ...f.extraction.candidates[0], text,
    evidence: [{ documentId: 'document-1', blockId: 'paragraph-1', start: 0, end: text.length, quote: text }] }];
  assert.deepEqual(validateExtraction(f.extraction, f.documents), f.extraction);
  f.extraction.candidates[0].evidence[0].end = [...text].length;
  rejected(() => validateExtraction(f.extraction, f.documents));
});

test('Step 1: exact quote does not certify a fabricated claim; still unverified for human review', () => {
  const f = regulationFixture();
  f.extraction.candidates[1].text = '月額99,999円という創作を含む候補。';
  assert.equal(validateExtraction(f.extraction, f.documents).candidates[1].text, f.extraction.candidates[1].text);
  const d = createOfferImport({ id: importFixture().id, createdAt: importTime, ...f });
  assert.equal(d.candidates[1].review.verification, 'unverified');
  assert.deepEqual(approvedCandidatePreview(d), []);
});

test('Step 1: multiple evidence documents must each match and all reviewed source metadata is bound', () => {
  const f = regulationFixture();
  f.documents.push({ ...structuredClone(f.documents[0]), id: 'document-2', kind: 'advertiser_material' });
  f.extraction.candidates[1].evidence.push({ ...f.extraction.candidates[1].evidence[0], documentId: 'document-2' });
  const d = createOfferImport({ id: importFixture().id, createdAt: importTime, ...f });
  const accepted = review(d, 'candidate-2', { sourceChecked: true });
  assert.deepEqual(approvedCandidatePreview(accepted)[0].origins, ['asp', 'advertiser']);
  accepted.documents[1].kind = 'user_provided';
  rejected(() => validateOfferImport(accepted));
});

test('Step 1: review preview is detached and retains references without producing an offer', () => {
  const d = review(importFixture());
  const before = structuredClone(d);
  const preview = approvedCandidatePreview(d);
  assert.deepEqual(preview[0].payload.evidence, d.candidates[1].original.evidence);
  assert.equal(Object.hasOwn(preview[0], 'sourceIds'), false);
  assert.equal(Object.hasOwn(preview[0], 'status'), false);
  preview[0].payload.evidence[0].quote = 'changed';
  assert.deepEqual(d, before);
});

test('Step 1: new payloads may remain unmapped or empty without invented required offer data', () => {
  const f = regulationFixture();
  f.extraction.candidates = [];
  const d = createOfferImport({ id: importFixture().id, createdAt: importTime, ...f });
  assert.deepEqual(d.candidates, []);
  assert.deepEqual(approvedCandidatePreview(d), []);
  assert.equal(Object.hasOwn(d, 'conversions'), false);
  assert.equal(Object.hasOwn(d, 'disclosure'), false);
});

test('Step 1: origin is derived from human document metadata, never invented by extraction', () => {
  for (const [kind, expected] of [['asp_material', 'asp'], ['advertiser_material', 'advertiser'], ['user_provided', 'editor']]) {
    const f = regulationFixture(); f.documents[0].kind = kind;
    const d = createOfferImport({ id: importFixture().id, createdAt: importTime, ...f });
    assert.deepEqual(approvedCandidatePreview(review(d))[0].origins, [expected]);
  }
});

test('Step 1: API extraction schema has closed required objects and excludes human/system state', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/regulation-extraction.schema.json', import.meta.url), 'utf8'));
  function visit(rule) {
    if (rule.type === 'object') {
      assert.equal(rule.additionalProperties, false);
      assert.deepEqual([...rule.required].sort(), Object.keys(rule.properties).sort());
      for (const r of Object.values(rule.properties)) visit(r);
    }
    if (rule.items) visit(rule.items);
    if (rule.anyOf) rule.anyOf.forEach(visit);
    if (rule.$defs) Object.values(rule.$defs).forEach(visit);
  }
  visit(schema);
  for (const key of ['verification', 'checkedAt', 'status', 'revision', 'decision', 'id', 'origin']) {
    assert.equal(Object.hasOwn(schema.$defs.payload.properties, key), false);
  }
});

test('Step 1: no outward communication', () => assert.deepEqual(blockedConnections, []));
