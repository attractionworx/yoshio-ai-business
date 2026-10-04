import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateOffer } from '../offers/validation.js';
import { validateOfferImport } from './validation.js';

export const reflectionError = status => Object.assign(new Error(status === 400 ? '反映内容を検証できません。' : status === 503 ? '反映記録を安全に確認できません。復旧確認が必要です。' : '反映の競合または未解決記録があります。再読込・復旧確認が必要です。'), { status });
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
export const reflectionHash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const offerBusiness = offer => Object.fromEntries(Object.entries(offer).filter(([k]) => !['schemaVersion', 'id', 'revision', 'createdAt', 'updatedAt'].includes(k)));
export function exactReflection(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== [...keys].sort().join()) throw reflectionError(400);
}

// Pure projection of checked accepted candidates. No offer writes, clocks, IDs from AI, or activation.
export function projectReflection(importValue, offerValue, options, prior = []) {
  const draft = validateOfferImport(importValue);
  const offer = validateOffer(offerValue);
  exactReflection(options, ['offerId', 'conversions']);
  if (options.offerId !== offer.id || (draft.targetOffer && draft.targetOffer.id !== offer.id) || !Array.isArray(options.conversions) || options.conversions.length > 200) throw reflectionError(400);
  const groups = new Map();
  for (const mapping of options.conversions) {
    exactReflection(mapping, ['key', 'id']);
    if (typeof mapping.key !== 'string' || !draft.candidates.some(c => (c.review.edited || c.original).conversionKey === mapping.key)
      || groups.has(mapping.key) || !offer.conversions.some(c => c.id === mapping.id)) throw reflectionError(400);
    groups.set(mapping.key, mapping.id);
  }
  const input = structuredClone(offerBusiness(offer));
  const statements = [...input.facts, ...input.targetAudience, ...input.sellingPoints, ...input.prohibitedExpressions,
    ...input.conversions.flatMap(c => [...c.eligibility, ...c.approvalConditions, ...c.rejectionConditions, ...(c.ctaLabel ? [c.ctaLabel] : []), ...(c.reward ? [c.reward.evidence] : [])])];
  const statementIds = new Set(statements.map(s => s.id));
  const changes = [], excluded = [], mappings = [], replaced = new Set();
  const previous = prior.filter(p => p.importId === draft.id);
  const usedCandidates = new Set(previous.flatMap(p => p.mappings.map(m => m.candidateId)));
  for (const candidate of draft.candidates) {
    const p = candidate.review.edited || candidate.original;
    const skip = reason => excluded.push({ candidateId: candidate.id, reason });
    if (candidate.review.decision !== 'accepted') { skip(candidate.review.decision === 'rejected' ? '却下済み' : '保留中'); continue; }
    if (candidate.review.verification !== 'source_checked') { skip('未確認：人間による個別出典照合が必要'); continue; }
    if (usedCandidates.has(candidate.id)) { skip('この候補は既に反映済み'); continue; }
    if (p.target === 'reward_evidence' || p.target === 'unmapped') { skip('構造化した金額・条件等の個別設計が必要なため、このStepでは反映しません'); continue; }
    const conversion = p.conversionKey ? input.conversions.find(c => c.id === groups.get(p.conversionKey)) : null;
    if (p.conversionKey && !conversion) { skip('成果地点グループの反映先を人間が選択してください'); continue; }
    const kinds = new Set(p.evidence.map(e => draft.documents.find(d => d.id === e.documentId).kind));
    if (kinds.size !== 1) { skip('複数の提供元を単一originへ推測できません'); continue; }
    const scalar = ['name', 'conversion_name', 'disclosure_text'].includes(p.target);
    if (scalar && p.usage !== 'publishable') { skip('名称・広告明示への反映には公開用としての個別承認が必要'); continue; }
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
    const officialId = scalar ? (conversion?.id || null) : `imp-${draft.id}-${candidate.id}`;
    if (!scalar && statementIds.has(officialId)) throw reflectionError(409);
    if (!scalar) statementIds.add(officialId);
    const after = scalar ? p.text : { id: officialId, category: p.category, text: p.text,
      origin: { asp_material: 'asp', advertiser_material: 'advertiser', user_provided: 'editor' }[[...kinds][0]],
      sourceIds, verification: 'source_checked', usage: p.usage };
    const before = replacing ? structuredClone(owner[key]) : null;
    if (replacing) owner[key] = after; else owner[key].push(after);
    changes.push({ candidateId: candidate.id, field, operation: replacing ? 'change' : 'add', before, after: structuredClone(after), usage: p.usage });
    mappings.push({ candidateId: candidate.id, field, officialId, sourceIds, usage: p.usage,
      checkedAt: candidate.review.checkedAt, citations: structuredClone(p.evidence) });
  }
  // Preserve status, metadata and existing validation. Active constraints can reject the whole preview.
  validateOffer({ ...input, schemaVersion: 1, id: offer.id, revision: offer.revision + 1, createdAt: offer.createdAt, updatedAt: offer.updatedAt });
  return { schemaVersion: 1, importId: draft.id, importRevision: draft.revision, offerId: offer.id,
    importHash: reflectionHash(draft), offerHash: reflectionHash(offer),
    offerRevision: offer.revision, nextRevision: offer.revision + 1, input, changes, excluded, mappings,
    sources: input.sources.filter(s => mappings.some(m => m.sourceIds.includes(s.id))) };
}
