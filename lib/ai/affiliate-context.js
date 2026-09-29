import { createHash } from 'node:crypto';
import { invalid } from '../content.js';
import { safeText, validateOfferId } from '../offers/validation.js';

const fail = () => { throw invalid('案件の生成用情報を安全に確認できません。案件と企画を確認してください。', 409); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const contextHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const urlPattern = /(?:https?:\/\/|www\.)/iu;
function text(value, limit = 5000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || urlPattern.test(value)) fail();
  safeText(value);
  return value;
}
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== [...keys].sort().join()) fail();
}
function reason(value) {
  if (typeof value !== 'string' || value.length > 1000) fail();
  safeText(value);
  return value;
}
export function validateBinding(binding) {
  exact(binding, ['offerId', 'offerRevision', 'conversionId', 'selectionReason', 'snapshot']);
  validateOfferId(binding.offerId);
  if (!Number.isSafeInteger(binding.offerRevision) || binding.offerRevision < 1 || typeof binding.conversionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(binding.conversionId)) fail();
  reason(binding.selectionReason);
  exact(binding.snapshot, ['offerName', 'conversionName']);
  for (const name of Object.values(binding.snapshot)) { if (typeof name !== 'string' || name.length > 5000) fail(); safeText(name); }
}
const listKeys = ['facts', 'targetAudience', 'sellingPoints', 'eligibility', 'approvalConditions', 'rejectionConditions', 'prohibitedExpressions'];
// retryでも現在の案件へ差し替えない。保存済みの公開snapshotを厳密に検証する。
export function validateAffiliateContext(value) {
  exact(value, ['schemaVersion', 'offerId', 'offerRevision', 'conversionId', 'selectionReason', 'offerName', 'conversionName', 'contextHash', 'snapshot']);
  if (value.schemaVersion !== 1) fail();
  validateOfferId(value.offerId);
  validateBinding({ offerId: value.offerId, offerRevision: value.offerRevision, conversionId: value.conversionId, selectionReason: value.selectionReason, snapshot: { offerName: value.offerName, conversionName: value.conversionName } });
  const snapshot = value.snapshot;
  exact(snapshot, ['offerName', 'conversionName', ...listKeys, 'cta', 'disclosure']);
  for (const key of ['offerName', 'conversionName', 'cta']) text(snapshot[key]);
  for (const key of listKeys) {
    if (!Array.isArray(snapshot[key]) || snapshot[key].length > 200) fail();
    snapshot[key].forEach(item => text(item));
  }
  exact(snapshot.disclosure, ['required', 'text', 'placements']);
  if (snapshot.disclosure.required !== true || !Array.isArray(snapshot.disclosure.placements) || !snapshot.disclosure.placements.length || snapshot.disclosure.placements.some(p => !['bodyStart', 'cta', 'social'].includes(p))) fail();
  text(snapshot.disclosure.text);
  if (!snapshot.prohibitedExpressions.length || value.offerName !== snapshot.offerName || value.conversionName !== snapshot.conversionName || value.contextHash !== contextHash(snapshot)) fail();
  return structuredClone(value);
}
function inDate(offer, time) {
  return (!offer.validFrom || time >= Date.parse(offer.validFrom)) && (!offer.validUntil || time < Date.parse(offer.validUntil)) && (!offer.reviewDueAt || time < Date.parse(offer.reviewDueAt));
}
export async function resolveAffiliateContext(binding, store, now) {
  validateBinding(binding);
  const history = await store.history(binding.offerId); // storeが全履歴のschema/出典/秘密情報も検証する。
  const fixed = history.find(offer => offer.revision === binding.offerRevision);
  const current = history.at(-1);
  const conversion = fixed?.conversions.find(item => item.id === binding.conversionId);
  if (!fixed || !conversion) fail();
  const latestConversion = current.conversions.find(item => item.id === binding.conversionId);
  const eligible = s => s.verification === 'source_checked' && ['advertiser', 'asp'].includes(s.origin)
    && s.category !== 'reward' && !urlPattern.test(s.text);
  const publicTexts = items => items.filter(s => eligible(s) && s.usage === 'publishable').map(s => s.text);
  // constraint_onlyは公開事実に昇格しない。禁止表現だけは生成を制限する指示として扱う。
  const prohibitions = fixed.prohibitedExpressions.filter(s => eligible(s) && ['publishable', 'constraint_only'].includes(s.usage)).map(s => s.text);
  const snapshot = { offerName: text(fixed.name), conversionName: text(conversion.name),
    facts: publicTexts(fixed.facts), targetAudience: publicTexts(fixed.targetAudience), sellingPoints: publicTexts(fixed.sellingPoints),
    eligibility: publicTexts(conversion.eligibility), approvalConditions: publicTexts(conversion.approvalConditions), rejectionConditions: publicTexts(conversion.rejectionConditions),
    prohibitedExpressions: prohibitions,
    cta: conversion.ctaLabel && eligible(conversion.ctaLabel) && conversion.ctaLabel.usage === 'publishable' ? conversion.ctaLabel.text : '',
    disclosure: { required: true, text: text(fixed.disclosure.text), placements: [...fixed.disclosure.placements] } };
  let blockedReason = '';
  if (current.status !== 'active') blockedReason = `現在この案件は${current.status}です。新しい案件付き生成は停止しています。紐付けは保持しています。`;
  else if (fixed.status !== 'active' || conversion.status !== 'active' || latestConversion?.status !== 'active') blockedReason = '固定した案件・成果地点、または現在の成果地点がactiveではありません。生成を停止しています。';
  else if (!inDate(fixed, now.getTime()) || !inDate(current, now.getTime())) blockedReason = '案件の有効期間外、または確認期限を過ぎています。生成を停止しています。';
  else if (!snapshot.cta || !prohibitions.length || prohibitions.length !== fixed.prohibitedExpressions.length) blockedReason = '公開可能なCTAまたは安全に使用できる禁止表現を確認できません。生成を停止しています。';
  const affiliateContext = { schemaVersion: 1, offerId: fixed.id, offerRevision: fixed.revision, conversionId: conversion.id,
    selectionReason: reason(binding.selectionReason), offerName: fixed.name, conversionName: conversion.name,
    contextHash: contextHash(snapshot), snapshot };
  if (!blockedReason) validateAffiliateContext(affiliateContext);
  return { affiliateContext, currentStatus: current.status, currentRevision: current.revision, blockedReason,
    // 状態の変更→復帰も古い確認では通さない。最新版の本文は送信しない。
    confirmationHash: contextHash({ binding, contextHash: affiliateContext.contextHash, currentRevision: current.revision, currentStatus: current.status, blockedReason }) };
}
