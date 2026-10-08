import { safeText } from '../offers/validation.js';
import { reflectionError, exactReflection } from './projection.js';

export const multipleConversionCategories = Object.freeze({ eligibility: 'eligibility', approvalConditions: 'approval', rejectionConditions: 'rejection' });
export const conversionTargetsV2 = Object.freeze(['conversion_name', 'eligibility', 'approvalConditions', 'rejectionConditions', 'ctaLabel']);
export const offerTargetsV2 = Object.freeze(['name', 'disclosure_text', 'facts', 'targetAudience', 'sellingPoints', 'prohibitedExpressions']);
export function permitsMultipleConversions(p) { return multipleConversionCategories[p.target] === p.category; }

// Local candidate eligibility only. Revisions, destination existence, collisions and final offer
// validation remain authoritative server checks; this policy never approves or changes a candidate.
export function reflectionV2Eligibility(candidate, draft) {
  const p = candidate.review.edited || candidate.original;
  let code = null;
  if (candidate.review.decision !== 'accepted' || candidate.review.verification !== 'source_checked') code = 'V2_SOURCE_CHECK_REQUIRED';
  else if (new Set(p.evidence.map(e => draft.documents.find(d => d.id === e.documentId)?.kind)).size !== 1) code = 'V2_EVIDENCE_KIND_MIXED';
  else if (['name', 'conversion_name', 'disclosure_text'].includes(p.target) && p.usage !== 'publishable') code = 'V2_SCALAR_USAGE_REQUIRED';
  return { offer: !code && offerTargetsV2.includes(p.target), conversions: !code && conversionTargetsV2.includes(p.target),
    multiple: !code && permitsMultipleConversions(p), code: code || (!offerTargetsV2.includes(p.target) && !conversionTargetsV2.includes(p.target) ? 'V2_TARGET_UNSUPPORTED' : null) };
}
const codes = new Set(['V2_SOURCE_CHECK_REQUIRED', 'V2_EVIDENCE_KIND_MIXED', 'V2_SCALAR_USAGE_REQUIRED', 'V2_TARGET_UNSUPPORTED', 'V2_NONE_REASON_REQUIRED', 'V2_MAPPING_MODE_INVALID', 'V2_MAPPING_TARGET_INVALID', 'V2_COMMON_CONFIRMATION_REQUIRED', 'V2_FORM_FIELD_INVALID']);
const fields = new Set(['mode', 'target', 'reason', 'common', 'usage', 'verification', 'evidence']);
export function v2ValidationError(candidateId, field, code) {
  const error = reflectionError(400);
  if (/^candidate-[1-9]\d*$/.test(candidateId) && fields.has(field) && codes.has(code)) error.v2Diagnostic = { candidateId, field, code };
  return error;
}
export function reflectionV2Diagnostic(error, escape) {
  const d = error?.v2Diagnostic;
  if (!d || !/^candidate-[1-9]\d*$/.test(d.candidateId) || !fields.has(d.field) || !codes.has(d.code)) return '';
  const guidance = d.field === 'common' && d.code === 'V2_MAPPING_TARGET_INVALID' ? '共通適用確認と反映判断・選択数が一致しません。単一地点では共通確認は不要です。チェックを人間が解除するまで停止します。自動補正は行いません。' : d.field === 'mode' && d.code === 'V2_MAPPING_MODE_INVALID' ? '地点を選択済みでも、反映判断（mode）が未選択なら未完了です。modeは自動補完しません。' : '';
  return `<p role="alert">候補：${escape(d.candidateId)} ／ 入力項目：${escape(d.field)} ／ validation code：${escape(d.code)}</p>${guidance ? `<p>${guidance}</p>` : ''}`;
}


// Partial drafts retain blanks and incomplete confirmation, never substitute a decision.
export function validateReflectionV2Choice(choice, candidate, draft, offer, partial = false) {
  exactReflection(choice, ['candidateId', 'mode', 'conversionIds', 'reason', 'commonConfirmed']);
  const fail = (field, code) => { throw v2ValidationError(candidate.id, field, code); };
  if (choice.candidateId !== candidate.id || ![...(partial ? [''] : []), 'none', 'offer', 'conversions'].includes(choice.mode)) fail('mode', 'V2_MAPPING_MODE_INVALID');
  if (!Array.isArray(choice.conversionIds) || choice.conversionIds.length > 200 || new Set(choice.conversionIds).size !== choice.conversionIds.length
    || choice.conversionIds.some(id => typeof id !== 'string' || !offer.conversions.some(c => c.id === id)) || typeof choice.commonConfirmed !== 'boolean') fail('target', 'V2_MAPPING_TARGET_INVALID');
  if (typeof choice.reason !== 'string' || choice.reason.length > 1000) fail('reason', 'V2_FORM_FIELD_INVALID');
  try { safeText(choice.reason); } catch { fail('reason', 'V2_FORM_FIELD_INVALID'); }
  const policy = reflectionV2Eligibility(candidate, draft);
  if (choice.mode && choice.mode !== 'none' && !policy[choice.mode]) fail(policy.code === 'V2_SCALAR_USAGE_REQUIRED' ? 'usage' : policy.code === 'V2_SOURCE_CHECK_REQUIRED' ? 'verification' : policy.code === 'V2_EVIDENCE_KIND_MIXED' ? 'evidence' : 'mode', policy.code || 'V2_MAPPING_MODE_INVALID');
  if (choice.mode === 'none' || choice.mode === 'offer') {
    if (choice.conversionIds.length || choice.commonConfirmed) fail('target', 'V2_MAPPING_TARGET_INVALID');
    if (choice.mode === 'none' && !choice.reason.trim()) { if (partial) return false; fail('reason', 'V2_NONE_REASON_REQUIRED'); }
  } else {
    if (choice.conversionIds.length && !policy.conversions) fail('target', 'V2_MAPPING_TARGET_INVALID');
    if (choice.conversionIds.length > 1 && !policy.multiple) fail('target', 'V2_MAPPING_TARGET_INVALID');
    if (choice.commonConfirmed && (choice.conversionIds.length < 2 || !policy.multiple)) fail('common', 'V2_MAPPING_TARGET_INVALID');
    if (choice.mode === 'conversions' && (!choice.conversionIds.length || (choice.conversionIds.length > 1 && !choice.commonConfirmed))) {
      if (partial) return false;
      fail(choice.conversionIds.length ? 'common' : 'target', choice.conversionIds.length ? 'V2_COMMON_CONFIRMATION_REQUIRED' : 'V2_MAPPING_TARGET_INVALID');
    }
  }
  return Boolean(choice.mode);
}
