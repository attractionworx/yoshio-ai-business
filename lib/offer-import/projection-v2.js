import { isDeepStrictEqual } from 'node:util';
import { validateOffer } from '../offers/validation.js';
import { validateOfferImport } from './validation.js';

import { reflectionError, reflectionHash, offerBusiness, exactReflection } from './projection.js';

import { reflectionV2Eligibility, v2ValidationError, validateReflectionV2Choice } from './reflection-v2-policy.js';
export { multipleConversionCategories, permitsMultipleConversions, conversionTargetsV2, offerTargetsV2 } from './reflection-v2-policy.js';
export const reflectionStatementId = (importId, candidateId, conversionId) => `imp2-${reflectionHash([importId, candidateId, conversionId])}`;

// Pure projection of checked accepted candidates. No offer writes, clocks, IDs from AI, or activation.
export function projectReflectionV2(importValue, offerValue, options, prior = []) {
  const draft = validateOfferImport(importValue);
  const offer = validateOffer(offerValue);
  exactReflection(options, ['schemaVersion', 'offerId', 'choices']);
  if (options.schemaVersion !== 2 || options.offerId !== offer.id || (draft.targetOffer && draft.targetOffer.id !== offer.id)
      || !Array.isArray(options.choices) || options.choices.length !== draft.candidates.length || !draft.candidates.length) throw reflectionError(400);
  const choices = new Map(); let assignments = 0;
  for (const choice of options.choices) {
    const candidate = draft.candidates.find(c => c.id === choice.candidateId);
    if (!candidate || choices.has(choice.candidateId)) throw reflectionError(400);
    validateReflectionV2Choice(choice, candidate, draft, offer);
    assignments += choice.conversionIds.length;
    choices.set(choice.candidateId, choice);
  }
  if (assignments > 1000) throw reflectionError(400);
  const input = structuredClone(offerBusiness(offer));
  const statements = [...input.facts, ...input.targetAudience, ...input.sellingPoints, ...input.prohibitedExpressions,
    ...input.conversions.flatMap(c => [...c.eligibility, ...c.approvalConditions, ...c.rejectionConditions, ...(c.ctaLabel ? [c.ctaLabel] : []), ...(c.reward ? [c.reward.evidence] : [])])];
  const statementIds = new Set(statements.map(s => s.id));
  const changes = [], excluded = [], mappings = [], decisions = [], replaced = new Set();
  const previous = prior.filter(p => p.importId === draft.id);
  const usedCandidates = new Set(previous.flatMap(p => p.mappings.map(m => m.candidateId)));
  for (const candidate of draft.candidates) {
    const p = candidate.review.edited || candidate.original;
    const choice = choices.get(candidate.id);
    decisions.push({ ...structuredClone(choice), text: p.text, target: p.target, category: p.category, usage: p.usage,
      conversionKey: p.conversionKey, contentHash: reflectionHash({ payload: p, review: candidate.review }),
      verification: candidate.review.verification, citations: structuredClone(p.evidence) });
    if (choice.mode === 'none') { excluded.push({ candidateId: candidate.id, reason: choice.reason, mode: 'none' }); continue; }
    const eligibility = reflectionV2Eligibility(candidate, draft);
    if (!eligibility[choice.mode]) throw v2ValidationError(candidate.id, eligibility.code === 'V2_SCALAR_USAGE_REQUIRED' ? 'usage' : eligibility.code === 'V2_SOURCE_CHECK_REQUIRED' ? 'verification' : eligibility.code === 'V2_EVIDENCE_KIND_MIXED' ? 'evidence' : 'mode', eligibility.code || 'V2_MAPPING_MODE_INVALID');
    if (usedCandidates.has(candidate.id)) throw reflectionError(409);
    if (choice.mode === 'conversions' && choice.conversionIds.length > 1 && (!eligibility.multiple || !choice.commonConfirmed)) throw v2ValidationError(candidate.id, 'common', 'V2_COMMON_CONFIRMATION_REQUIRED');
    const destinations = choice.mode === 'offer' ? [null] : choice.conversionIds.map(id => input.conversions.find(c => c.id === id));
    for (const conversion of destinations) {
      const kinds = new Set(p.evidence.map(e => draft.documents.find(d => d.id === e.documentId).kind));
      const scalar = ['name', 'conversion_name', 'disclosure_text'].includes(p.target);
      const sourceIds = [];
      for (const documentId of [...new Set(p.evidence.map(e => e.documentId))]) {
        const index = draft.documents.findIndex(d => d.id === documentId);
        const doc = draft.documents[index];
        const sourceId = `imp-${draft.id}-d${index + 1}`;
        const label = `${doc.label} [import:${draft.id}/${doc.id}]`;
        const source = input.sources.find(s => s.id === sourceId);
        if (source) {
          const createdHere = changes.some(c => c.field === 'sources' && c.after.id === sourceId);
          const recorded = previous.some(receipt => receipt.sources.some(s => isDeepStrictEqual(s, source)));
          if ((!createdHere && !recorded) || source.label !== label || source.kind !== doc.kind || source.publicUrl !== null || !source.checkedAt) throw reflectionError(409);
        } else {
          const added = { id: sourceId, kind: doc.kind, label, publicUrl: null, checkedAt: candidate.review.checkedAt };
          input.sources.push(added);
          changes.push({ candidateId: candidate.id, field: 'sources', operation: 'add', before: null, after: structuredClone(added), usage: 'source' });
        }
        sourceIds.push(sourceId);
      }
      const conversionIndex = conversion ? input.conversions.indexOf(conversion) : null;
      const field = p.target === 'conversion_name' ? `conversions.${conversionIndex}.name` : p.target === 'disclosure_text' ? 'disclosure.text'
        : conversion ? `conversions.${conversionIndex}.${p.target}` : p.target;
      const owner = p.target === 'disclosure_text' ? input.disclosure : conversion || input;
      const key = p.target === 'conversion_name' ? 'name' : p.target === 'disclosure_text' ? 'text' : p.target;
      const replacing = scalar || p.target === 'ctaLabel';
      if (replacing && replaced.has(field)) throw reflectionError(409);
      replaced.add(field);
      const officialId = scalar ? (conversion?.id || null) : reflectionStatementId(draft.id, candidate.id, conversion?.id || null);
      if (!scalar && statementIds.has(officialId)) throw reflectionError(409);
      if (!scalar) statementIds.add(officialId);
      const after = scalar ? p.text : { id: officialId, category: p.category, text: p.text,
        origin: { asp_material: 'asp', advertiser_material: 'advertiser', user_provided: 'editor' }[[...kinds][0]],
        sourceIds, verification: 'source_checked', usage: p.usage };
      const before = replacing ? structuredClone(owner[key]) : null;
      if (replacing) owner[key] = after; else owner[key].push(after);
      changes.push({ candidateId: candidate.id, field, operation: replacing ? 'change' : 'add', before, after: structuredClone(after), usage: p.usage });
      mappings.push({ candidateId: candidate.id, conversionId: conversion?.id || null, field, officialId, sourceIds, usage: p.usage,
        checkedAt: candidate.review.checkedAt, citations: structuredClone(p.evidence) });
    }
  }
  // Preserve status, metadata and existing validation. Active constraints can reject the whole preview.
  validateOffer({ ...input, schemaVersion: 1, id: offer.id, revision: offer.revision + 1, createdAt: offer.createdAt, updatedAt: offer.updatedAt });
  return { schemaVersion: 2, importId: draft.id, importRevision: draft.revision, offerId: offer.id,
    importHash: reflectionHash(draft), offerHash: reflectionHash(offer),
    offerRevision: offer.revision, nextRevision: offer.revision + (mappings.length ? 1 : 0), input, changes, excluded, mappings, decisions,
    sources: input.sources.filter(s => mappings.some(m => m.sourceIds.includes(s.id))) };
}
