import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createOfferStore } from '../../lib/offers/store.js';
import { newOfferInput } from '../../lib/offers/form.js';
import { createOfferImportStore } from '../../lib/offer-import/store.js';
import { createCommitStore } from '../../lib/offer-import/commit-store.js';
import { createReflectionService } from '../../lib/offer-import/reflection-service.js';
import { regulationFixture, importTime } from './regulation-import.js';

export const noneChoice = candidateId => ({ candidateId, mode: 'none', conversionIds: [], reason: '今回の正式反映対象外', commonConfirmed: false });
export const targetChoice = (candidateId, ...conversionIds) => ({ candidateId, mode: 'conversions', conversionIds, reason: '', commonConfirmed: conversionIds.length > 1 });
export const checkedReview = { decision: 'accepted', edited: null, sourceChecked: true, reason: '' };
export async function reflectionV2Fixture(t, { size = 9, blockedDisclosure = false, offersWrapper, auditFileSystem } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'reflection-v2-'));
  if (t) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const now = () => new Date(importTime);
  const offers = createOfferStore(directory, { now });
  const conversions = ['seminar', 'membership'].map(id => ({ id, name: id === 'seminar' ? '架空の無料セミナー予約' : '架空の入会申込', status: 'draft', reward: null, eligibility: [], approvalConditions: [], rejectionConditions: [], affiliateUrl: null, ctaLabel: null }));
  const offer = await offers.create({ ...newOfferInput(), name: '架空の複数成果地点案件', asp: { code: 'fictional', programId: null }, conversions });
  const f = regulationFixture();
  const base = f.extraction.candidates[1];
  f.extraction.candidates = [
    { ...structuredClone(base), target: 'conversion_name', category: 'other', text: '架空の無料セミナー予約', conversionKey: 'fictional-group', usage: 'publishable', purpose: 'fact' },
    { ...structuredClone(base), target: 'conversion_name', category: 'other', text: '架空の入会申込', conversionKey: 'fictional-group', usage: 'publishable', purpose: 'fact' },
    { ...structuredClone(base), target: 'eligibility', category: 'eligibility', conversionKey: 'fictional-group', usage: 'constraint_only', purpose: 'conversion_condition' },
    { ...structuredClone(base), target: 'approvalConditions', category: 'approval', conversionKey: 'fictional-group', purpose: 'conversion_condition' },
    { ...structuredClone(base), target: 'approvalConditions', category: 'approval', conversionKey: 'fictional-group', purpose: 'conversion_condition' },
    { ...structuredClone(base), target: 'reward_evidence', category: 'reward', conversionKey: 'fictional-group', purpose: 'fact' },
    { ...structuredClone(base), target: 'rejectionConditions', category: 'rejection', conversionKey: 'fictional-group', usage: 'constraint_only', purpose: 'conversion_condition' },
    { ...structuredClone(base), target: 'rejectionConditions', category: 'rejection', conversionKey: 'fictional-group', usage: 'constraint_only', purpose: 'conversion_condition' },
    structuredClone(base),
  ];
  if (size > 9) f.extraction.candidates.push(...Array.from({ length: size - 9 }, () => structuredClone(base)));
  if (blockedDisclosure) f.extraction.candidates[19] = { ...structuredClone(base), target: 'disclosure_text', category: 'effect', usage: 'constraint_only', purpose: 'fact', text: '架空の効果非保証表示' };
  const imports = createOfferImportStore(directory, { now });
  let draft = await imports.create({ targetOffer: { id: offer.id, revision: 1 }, ...f });
  // Large fixture checks rendering; only the candidates actually reflected need verification.
  for (let i = 0; i < Math.min(size, 9); i++) draft = await imports.review(draft.id, `candidate-${i + 1}`, draft.revision, checkedReview);
  if (blockedDisclosure) draft = await imports.review(draft.id, 'candidate-20', draft.revision, checkedReview);
  const audit = createCommitStore(directory, auditFileSystem ? { fileSystem: auditFileSystem } : {});
  const service = createReflectionService({ dataDirectory: directory, now, importStore: imports, offerStore: offersWrapper ? offersWrapper(offers) : offers, auditStore: audit });
  const options = { schemaVersion: 2, offerId: offer.id, choices: draft.candidates.map(c => noneChoice(c.id)) };
  for (const choice of [targetChoice('candidate-1', 'seminar'), targetChoice('candidate-2', 'membership'), targetChoice('candidate-3', 'seminar', 'membership'), targetChoice('candidate-4', 'seminar'), targetChoice('candidate-5', 'membership'), targetChoice('candidate-7', 'seminar', 'membership')]) options.choices[Number(choice.candidateId.split('-')[1]) - 1] = choice;
  options.choices[5].reason = '成果地点間の報酬優先ルールは構造化しない';
  options.choices[7].reason = 'candidate-7と同じ根拠の重複として反映なし';
  return { directory, now, offers, offer, imports, draft, audit, service, options };
}
export function reflectionV2Form(c, options = c.options) {
  const form = new URLSearchParams({ version: '2', offerId: c.offer.id, importRevision: String(c.draft.revision), offerRevision: String(c.offer.revision) });
  for (const choice of options.choices) {
    form.set(`${choice.candidateId}.mode`, choice.mode); form.set(`${choice.candidateId}.reason`, choice.reason);
    for (const id of choice.conversionIds) form.append(`${choice.candidateId}.target`, id);
    if (choice.commonConfirmed) form.set(`${choice.candidateId}.common`, 'yes');
  }
  return form;
}
