import { contentFields } from './content.js';
import { randomUUID } from 'node:crypto';
import { contextHash, validateAffiliateContext } from './ai/affiliate-context.js';
import { verifyAffiliateEvidence } from './affiliate-evidence.js';
import { AFFILIATE_VALIDATION_VERSION, contentHash, affiliateContextHash, validateAffiliateContent } from './affiliate-validation.js';

// 保存済み診断も自由文として信用しない。既知の契約だけを再利用・表示する。
const severities = {
  'evidence-mismatch': 'block', 'prohibited-expression': 'block', 'disclosure-missing-or-misplaced': 'block',
  'prohibition-evasion-candidate': 'warning', 'numeric-qualification-review': 'warning',
  'unregistered-numeric-candidate': 'warning', 'claim-review': 'warning', 'cta-review': 'warning',
  'human-fact-review-required': 'warning', 'numeric-text-match': 'info', 'claim-text-match': 'info', 'cta-text-match': 'info',
};
const exactKeys = (value, required, optional = []) => value && Object.getPrototypeOf(value) === Object.prototype
  && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k));
const hashPattern = /^[a-f0-9]{64}$/u;
const dateOK = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  && Number.isFinite(Date.parse(value));

function validResult(value, draft) {
  if (!exactKeys(value, ['schemaVersion', 'validationVersion', 'contentHash', 'affiliateContextHash', 'checkedAt', 'findings'])
      || value.schemaVersion !== 1 || value.validationVersion !== AFFILIATE_VALIDATION_VERSION
      || !hashPattern.test(value.contentHash) || !hashPattern.test(value.affiliateContextHash)
      || !dateOK(value.checkedAt) || !Array.isArray(value.findings) || value.findings.length > 100000) return false;
  const snapshot = draft.affiliateContext.snapshot;
  return value.findings.every(f => {
    if (!exactKeys(f, ['id', 'code', 'severity', 'field', 'evidenceRefs', 'messageKey'], ['titleIndex', 'location'])
        || !Object.hasOwn(severities, f.code) || f.severity !== severities[f.code] || f.messageKey !== `affiliate.${f.code}`
        || ![...contentFields.map(([k]) => k), 'context', 'all'].includes(f.field)) return false;
    if (f.field === 'titles') {
      if (!Number.isInteger(f.titleIndex) || f.titleIndex < 0 || f.titleIndex > 4) return false;
    } else if (Object.hasOwn(f, 'titleIndex')) return false;
    if (f.location) {
      const text = f.field === 'titles' ? draft.edited.titles[f.titleIndex] : draft.edited[f.field];
      if (!exactKeys(f.location, ['start', 'end']) || typeof text !== 'string'
          || !Number.isInteger(f.location.start) || !Number.isInteger(f.location.end)
          || f.location.start < 0 || f.location.end < f.location.start || f.location.end > text.length) return false;
    }
    if (!Array.isArray(f.evidenceRefs) || f.evidenceRefs.length > 1200 || !f.evidenceRefs.every(ref => {
      if (ref === 'cta' || ref === 'disclosure') return true;
      if (typeof ref !== 'string') return false;
      const match = /^(facts|targetAudience|sellingPoints|eligibility|approvalConditions|rejectionConditions|prohibitedExpressions):(0|[1-9]\d*)$/u.exec(ref);
      return match && Number(match[2]) < snapshot[match[1]].length;
    })) return false;
    const { id, ...base } = f;
    return typeof id === 'string' && hashPattern.test(id) && id === contextHash(base);
  }) && !value.findings.some(f => f.code === 'evidence-mismatch')
    && new Set(value.findings.map(f => f.id)).size === value.findings.length;
}

// 読取専用。checkedAtだけでは鮮度を認めず、未知の診断値をUIへ返さない。
export function affiliateValidationState(draft) {
  if (!draft.affiliateContext) return { state: 'not-applicable' };
  try {
    validateAffiliateContext(draft.affiliateContext);
    if (Object.hasOwn(draft, 'affiliateValidationRunId') && !/^[a-f0-9-]{36}$/u.test(draft.affiliateValidationRunId)) return { state: 'invalid' };
    const cHash = contentHash(draft.edited);
    const aHash = affiliateContextHash(draft.affiliateContext);
    const failure = draft.affiliateValidationFailure;
    if (failure) {
      if (exactKeys(failure, ['schemaVersion', 'code', 'attemptedAt', 'contentHash', 'affiliateContextHash'])
          && failure.schemaVersion === 1 && failure.code === 'validation-unavailable' && dateOK(failure.attemptedAt)
          && failure.contentHash === cHash && failure.affiliateContextHash === aHash) return { state: 'failed' };
      return { state: 'invalid' };
    }
    const v = draft.affiliateValidation;
    if (!v) return { state: 'unvalidated' };
    if (v.validationVersion !== AFFILIATE_VALIDATION_VERSION || v.contentHash !== cHash || v.affiliateContextHash !== aHash) return { state: 'stale' };
    if (!validResult(v, draft)) return { state: 'invalid' };
    return { state: 'current', validationVersion: AFFILIATE_VALIDATION_VERSION, checkedAt: v.checkedAt,
      counts: Object.fromEntries(['block', 'warning', 'info'].map(s => [s, v.findings.filter(f => f.severity === s).length])) };
  } catch { return { state: 'invalid' }; }
}

export function createAffiliateValidationLifecycle({ offerStore, validator = validateAffiliateContent, now = () => new Date() }) {
  return async function refresh(draft, { force = false } = {}) {
    if (!draft.affiliateContext) return;
    if (!force && affiliateValidationState(draft).state === 'current') return;
    // 古い結果と将来の確認を持ち越さない。新結果か失敗状態を本文と同時に保存する。
    delete draft.affiliateValidation;
    delete draft.affiliateValidationFailure;
    delete draft.humanConfirmation;
    delete draft.affiliateHumanConfirmation;
    delete draft.affiliateValidationRunId;
    if (draft.publication?.affiliate) delete draft.publication;
    const attemptedAt = now().toISOString();
    let cHash = null; let aHash = null;
    try {
      cHash = contentHash(draft.edited);
      aHash = affiliateContextHash(draft.affiliateContext);
      const context = validateAffiliateContext(draft.affiliateContext);
      const history = await offerStore.history(context.offerId);
      const fixedOffer = history.find(o => o.id === context.offerId && o.revision === context.offerRevision);
      verifyAffiliateEvidence(context, fixedOffer);
      const validation = await validator({ content: structuredClone(draft.edited), affiliateContext: context,
        fixedOffer: structuredClone(fixedOffer), checkedAt: attemptedAt });
      // 注入したadapterも保存契約を守る必要がある。生データは転記しない。
      if (validation.contentHash !== cHash || validation.affiliateContextHash !== aHash || !validResult(validation, draft)) throw new Error();
      draft.affiliateValidation = structuredClone(validation);
      draft.affiliateValidationRunId = randomUUID();
    } catch {
      draft.affiliateValidationFailure = { schemaVersion: 1, code: 'validation-unavailable',
        attemptedAt, contentHash: cHash, affiliateContextHash: aHash };
    }
  };
}
