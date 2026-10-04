import { validateExtraction, validateOfferImport, reviewContentHash } from './validation.js';

const pendingReview = () => ({ decision: 'pending', edited: null, verification: 'unverified',
  reviewedAt: null, checkedAt: null, confirmedHash: null, reason: '' });
const conflict = () => { throw Object.assign(new Error('取り込み候補が変更されています。確認し直してください。'), { status: 409 }); };
const invalid = () => { throw Object.assign(new Error('取り込みレビューの操作が不正です。'), { status: 400 }); };

// Caller supplies validated source metadata, identity and time. No clock, UUID, API or write side effects.
export function createOfferImport({ id, targetOffer = null, documents, extraction, createdAt }) {
  const parsed = validateExtraction(extraction, documents);
  return validateOfferImport({ schemaVersion: 1, id, revision: 1, createdAt, updatedAt: createdAt,
    targetOffer, documents, candidates: parsed.candidates.map((original, index) => ({
      id: `candidate-${index + 1}`, original, review: pendingReview(),
    })) });
}

// A future server must authorize the human POST; this function does not authenticate a reviewer.
export function reviewCandidate(draft, candidateId, expectedRevision, action) {
  const result = validateOfferImport(draft);
  if (!Number.isSafeInteger(expectedRevision) || result.revision !== expectedRevision) conflict();
  if (!action || Object.getPrototypeOf(action) !== Object.prototype
      || Object.keys(action).sort().join() !== ['decision', 'edited', 'sourceChecked', 'at', 'reason'].sort().join()
      || typeof action.sourceChecked !== 'boolean' || !['pending', 'accepted', 'rejected'].includes(action.decision)) invalid();
  const candidate = result.candidates.find(c => c.id === candidateId);
  if (!candidate || (action.sourceChecked && action.decision !== 'accepted')
      || typeof action.at !== 'string' || Date.parse(action.at) < Date.parse(result.updatedAt)) invalid();
  candidate.review = { ...pendingReview(), edited: action.edited, reason: action.reason };
  if (action.decision !== 'pending') {
    candidate.review.decision = action.decision;
    candidate.review.reviewedAt = action.at;
    candidate.review.confirmedHash = reviewContentHash(action.edited || candidate.original, result.documents);
    if (action.sourceChecked) {
      candidate.review.verification = 'source_checked';
      candidate.review.checkedAt = action.at;
    }
  }
  result.revision++;
  result.updatedAt = action.at;
  return validateOfferImport(result);
}

// Review preview only. Deliberately not an offer input, save command or publication permission.
export function approvedCandidatePreview(draft) {
  const value = validateOfferImport(draft);
  return value.candidates.filter(c => c.review.decision === 'accepted').map(candidate => ({
    candidateId: candidate.id, payload: candidate.review.edited || candidate.original,
    verification: candidate.review.verification, checkedAt: candidate.review.checkedAt,
    origins: [...new Set((candidate.review.edited || candidate.original).evidence.map(e => {
      const kind = value.documents.find(d => d.id === e.documentId).kind;
      return { asp_material: 'asp', advertiser_material: 'advertiser', user_provided: 'editor' }[kind];
    }))],
  }));
}
