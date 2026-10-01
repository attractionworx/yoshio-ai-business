import { affiliateValidationState } from './affiliate-validation-lifecycle.js';
import { affiliateHumanChecks, savedAffiliateConfirmation, validationFingerprint, affiliatePublicationIsCurrent } from './affiliate-publication.js';
import { contentHash } from './affiliate-validation.js';
import { checkCurrentOffer, currentOfferReasons } from './current-offer-check.js';
import { humanChecks, preflight, publicationData } from './publish.js';

export const finalExportReasons = Object.freeze({
  ...Object.fromEntries(Object.entries(currentOfferReasons).map(([code, message]) =>
    [code, `${message}。固定した案件根拠と現在の案件情報を見直し、公開準備をやり直してください。`])),
  'export-ready': '最終再確認に成功しました。公開先でも最終確認してください。内容の真実性や成果は保証しません。',
  'invalid-request': 'コピー要求が不正です。公開準備画面からやり直してください。',
  'draft-changed': '本文または保存状態が変更されています。下書きを確認し、公開準備をやり直してください。',
  'validation-stale': '再検査が必要です。下書きで保存済みの内容を再検査してください。',
  'validation-invalid': '検査結果を安全に確認できません。下書きで再検査してください。',
  'validation-failed': '検査に失敗しています。下書きで再検査してください。',
  'validation-unvalidated': '未検査です。下書きで再検査してください。',
  'validation-blocked': 'blockがあります。本文を修正し、再検査してください。',
  'warning-confirmation-required': '現在の検査に対するwarning確認が必要です。公開準備画面で1件ずつ確認してください。',
  'human-confirmation-required': '現在の検査に対する必須4項目の人間確認が必要です。公開準備画面で確認してください。',
  'validation-fingerprint-mismatch': '検査結果が公開準備時から変わっています。公開準備をやり直してください。',
  'publication-not-ready': '公開準備が完了していません。公開前チェックと人間確認を行い、公開準備OKにしてください。',
});
export const copyFields = Object.freeze(['title', 'body', 'bodyWithCta', 'social']);

// 過去のoffer pass・export passを許可証として使用しない。呼出ごとに現在storeを読む。
// 本文はここでは返さず、全条件成功後にstoreが同じdraftから組み立てる。
export async function checkFinalExport(draft, offerStore, now = new Date()) {
  const finish = reasonCode => ({ result: reasonCode === 'export-ready' ? 'pass' : 'blocked', reasonCode });
  if (!draft.affiliateContext) return finish('export-ready');
  const summary = affiliateValidationState(draft);
  if (summary.state !== 'current') return finish(`validation-${summary.state}`);
  if (summary.counts.block) return finish('validation-blocked');
  const p = draft.publication;
  const fingerprint = validationFingerprint(draft);
  if (p?.affiliate?.validationFingerprint !== fingerprint) return finish(p ? 'validation-fingerprint-mismatch' : 'publication-not-ready');
  if (p.contentHash !== contentHash(draft.edited)) return finish('draft-changed');
  const h = savedAffiliateConfirmation(draft);
  if (!h || !affiliateHumanChecks.every(([key]) => h.requiredChecks[key])) return finish('human-confirmation-required');
  const warnings = draft.affiliateValidation.findings.filter(f => f.severity === 'warning');
  if (h.warningResolutions.length !== warnings.length) return finish('warning-confirmation-required');
  if (!h.confirmedAt) return finish('human-confirmation-required');
  if (draft.status !== '確認済み' || p.schemaVersion !== 1 || p.status !== '公開準備OK'
      || typeof p.readyAt !== 'string' || !Number.isFinite(Date.parse(p.readyAt))
      || typeof p.checkedAt !== 'string' || !Number.isFinite(Date.parse(p.checkedAt))
      || !Array.isArray(p.findings) || p.findings.length || !Array.isArray(p.missing) || p.missing.length
      || !affiliatePublicationIsCurrent(draft) || !Number.isInteger(p.titleIndex) || p.titleIndex < 0 || p.titleIndex > 4
      || !humanChecks.every(([key]) => p.confirmations?.[key] === true)
      || preflight(publicationData(draft, p.titleIndex)).length) return finish('publication-not-ready');
  const current = await checkCurrentOffer(draft, offerStore, now);
  return finish(current.result === 'pass' ? 'export-ready' : current.reasonCode);
}
