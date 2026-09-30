import { currentOfferCheckPasses } from './current-offer-check.js';
import { invalid } from './content.js';
import { contextHash } from './ai/affiliate-context.js';
import { affiliateValidationState } from './affiliate-validation-lifecycle.js';

export const affiliateHumanChecks = [
  ['affiliateFacts', '案件事実・条件を固定した案件根拠と照合した'],
  ['affiliateProhibited', '禁止表現を確認した'],
  ['affiliateDisclosure', '広告・アフィリエイト明示と配置を確認した'],
  ['affiliateCta', 'CTAと選択した成果地点の一致を確認した'],
];
export const findingDescriptions = Object.freeze({
  'prohibited-expression': '登録された禁止表現に一致しています。本文を修正し再検査してください。',
  'disclosure-missing-or-misplaced': '必要な広告明示が欠落、または指定位置にありません。登録文言と配置を確認し修正してください。',
  'evidence-mismatch': '固定した案件根拠を確認できません。下書きで再検査してください。',
  'prohibition-evasion-candidate': '空白等を挟んだ禁止表現の可能性があります。表記と文脈を確認してください。',
  'numeric-qualification-review': '数値の上限・下限・概数等の条件が保たれているか確認してください。',
  'unregistered-numeric-candidate': '公開可能な固定根拠に対応しない数値候補です。用途と根拠を確認し、根拠のない断定は修正してください。',
  'claim-review': '実績・効果・対象・条件等の記述を固定根拠と照合してください。',
  'cta-review': 'CTAの文言が登録CTAと異なります。誘導先と成果地点に矛盾がないか確認してください。',
  'human-fact-review-required': '機械では真偽を保証できません。7項目全体の事実・条件を人間が確認してください。',
});
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join() === [...keys].sort().join();
const iso = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(v) && Number.isFinite(Date.parse(v));

// 全7項目の検査結果に束縛する。checkedAtとrunIdで明示再検査も区別する。
export function validationFingerprint(draft) {
  if (affiliateValidationState(draft).state !== 'current') return null;
  const v = draft.affiliateValidation;
  return contextHash({ schemaVersion: v.schemaVersion, validationVersion: v.validationVersion,
    contentHash: v.contentHash, affiliateContextHash: v.affiliateContextHash, findings: v.findings,
    checkedAt: v.checkedAt, runId: draft.affiliateValidationRunId ?? null });
}

export function savedAffiliateConfirmation(draft) {
  const fingerprint = validationFingerprint(draft);
  const h = draft.publication?.affiliate?.humanConfirmation;
  if (!fingerprint || !exact(h, ['schemaVersion', 'validationFingerprint', 'confirmedAt', 'requiredChecks', 'warningResolutions'])
      || h.schemaVersion !== 1 || h.validationFingerprint !== fingerprint
      || !(h.confirmedAt === null || iso(h.confirmedAt))
      || !exact(h.requiredChecks, affiliateHumanChecks.map(([key]) => key))
      || !Object.values(h.requiredChecks).every(v => typeof v === 'boolean') || !Array.isArray(h.warningResolutions)) return null;
  const warnings = draft.affiliateValidation.findings.filter(f => f.severity === 'warning');
  const ids = new Set(warnings.map(f => f.id));
  if (h.warningResolutions.length > warnings.length || !h.warningResolutions.every(r => exact(r, ['findingId', 'reasonCode'])
      && ids.has(r.findingId) && r.reasonCode === 'human-reviewed')
      || new Set(h.warningResolutions.map(r => r.findingId)).size !== h.warningResolutions.length) return null;
  const complete = Object.values(h.requiredChecks).every(Boolean) && h.warningResolutions.length === warnings.length;
  if (Boolean(h.confirmedAt) !== complete) return null;
  return structuredClone(h);
}

// GETでは保存しない。古い公開準備OK・確認チェックを表示上でも再利用しない。
export function affiliatePublicationIsCurrent(draft) {
  if (!draft.affiliateContext) return true;
  const fingerprint = validationFingerprint(draft);
  const a = draft.publication?.affiliate;
  const h = savedAffiliateConfirmation(draft);
  if (!fingerprint || !exact(a, ['schemaVersion', 'validationState', 'validationFingerprint', 'humanConfirmation', 'missing', 'currentOfferCheck'])
      || a.schemaVersion !== 1 || a.validationState !== 'current' || a.validationFingerprint !== fingerprint || !h) return false;
  if (draft.publication.status === '公開準備OK') {
    return currentOfferCheckPasses(draft, a.currentOfferCheck) && draft.status === '確認済み' && Boolean(h.confirmedAt)
      && !draft.affiliateValidation.findings.some(f => f.severity === 'block');
  }
  return true;
}

// URLSearchParamsの重複をObject.fromEntriesより前に検出する。
export function readPublicationInput(draft, raw) {
  let input;
  if (raw instanceof URLSearchParams) {
    const entries = [...raw.entries()];
    if (new Set(entries.map(([k]) => k)).size !== entries.length) throw invalid('公開確認の入力が重複しています。');
    input = Object.fromEntries(entries);
  } else {
    if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) throw invalid('公開確認の入力が不正です。');
    input = { ...raw };
  }
  if (!draft.affiliateContext) return input;
  const state = affiliateValidationState(draft);
  const warnings = state.state === 'current' ? draft.affiliateValidation.findings.filter(f => f.severity === 'warning') : [];
  const allowed = ['revision', 'action', 'titleIndex', 'experience', 'numbers', 'links', 'validationFingerprint',
    ...affiliateHumanChecks.map(([k]) => k), ...warnings.map(f => `warning.${f.id}`)];
  if (Object.keys(input).some(key => !allowed.includes(key)) || Object.values(input).some(v => typeof v !== 'string')) throw invalid('公開確認に未知または不正な入力があります。');
  for (const key of [...affiliateHumanChecks.map(([k]) => k), ...warnings.map(f => `warning.${f.id}`)]) {
    if (Object.hasOwn(input, key) && input[key] !== 'yes') throw invalid('案件確認は個別のチェックで行ってください。');
  }
  const fingerprint = validationFingerprint(draft);
  if (fingerprint && input.validationFingerprint !== fingerprint) throw invalid('検査結果が変わりました。公開確認画面を開き直してください。', 409);
  if (!fingerprint && Object.hasOwn(input, 'validationFingerprint')) throw invalid('有効な検査結果がありません。下書きで再検査してください。', 409);
  return input;
}

export function prepareAffiliatePublication(draft, input, checkedAt) {
  if (!draft.affiliateContext) return null;
  const summary = affiliateValidationState(draft);
  const fingerprint = validationFingerprint(draft);
  if (!fingerprint) return { schemaVersion: 1, validationState: summary.state, validationFingerprint: null,
    humanConfirmation: null, missing: ['案件の機械検査がcurrentではありません。下書きで再検査してください。'] };
  const warnings = draft.affiliateValidation.findings.filter(f => f.severity === 'warning');
  const requiredChecks = Object.fromEntries(affiliateHumanChecks.map(([key]) => [key, input[key] === 'yes']));
  const warningResolutions = warnings.filter(f => input[`warning.${f.id}`] === 'yes').map(f => ({ findingId: f.id, reasonCode: 'human-reviewed' }));
  const complete = Object.values(requiredChecks).every(Boolean) && warningResolutions.length === warnings.length;
  const missing = [];
  if (summary.counts.block) missing.push('案件のblock findingを修正し、再検査してください。人間確認では解除できません。');
  if (!Object.values(requiredChecks).every(Boolean)) missing.push('案件に関する必須の人間確認4項目をすべて行ってください。');
  if (warningResolutions.length !== warnings.length) missing.push('案件のwarningを1件ずつ確認してください。');
  return { schemaVersion: 1, validationState: 'current', validationFingerprint: fingerprint,
    humanConfirmation: { schemaVersion: 1, validationFingerprint: fingerprint, confirmedAt: complete ? checkedAt : null,
      requiredChecks, warningResolutions }, missing };
}
