// ローカルstoreのみ。生成時の固定根拠を更新しない。
export const currentOfferReasons = Object.freeze({
  'offer-active': '現在案件チェック成功（ローカル保存情報のみ）',
  'offer-paused': '案件停止中', 'offer-ended': '案件終了',
  'unknown-status': '案件状態が公開利用可能ではありません',
  'offer-missing': '案件が見つかりません', 'offer-unavailable': '案件を安全に読み取れません',
  'revision-mismatch': '案件revision変更。固定根拠の明示的な見直しが必要です',
  'conversion-missing': '固定した成果地点が見つかりません',
  'conversion-unavailable': '成果地点が現在利用不可',
  'offer-expired': '有効期限切れ', 'offer-not-started': '有効期間開始前',
  'offer-review-due': '案件情報の再確認期限を過ぎています',
  'invalid-current-state': '現在案件情報を安全に判定できません',
});
export async function checkCurrentOffer(draft, offerStore, now = new Date()) {
  if (!draft.affiliateContext) return null;
  const { offerId, offerRevision: fixedRevision, conversionId } = draft.affiliateContext;
  const result = { schemaVersion: 1, checkedAt: now.toISOString(), offerId, fixedRevision,
    currentRevision: null, conversionId, status: 'unknown', result: 'blocked', reasonCode: 'offer-unavailable' };
  const finish = reasonCode => ({ ...result, reasonCode, result: reasonCode === 'offer-active' ? 'pass' : 'blocked' });
  let offer;
  try { offer = await offerStore.get(offerId); }
  catch (error) { return finish(error.status === 404 ? 'offer-missing' : 'offer-unavailable'); }
  if (!offer || offer.id !== offerId || !Number.isSafeInteger(offer.revision) || offer.revision < 1) return finish('invalid-current-state');
  result.currentRevision = offer.revision;
  result.status = ['active', 'paused', 'ended', 'draft'].includes(offer.status) ? offer.status : 'unknown';
  if (offer.status === 'paused') return finish('offer-paused');
  if (offer.status === 'ended') return finish('offer-ended');
  if (offer.status !== 'active') return finish('unknown-status');
  if (offer.revision !== fixedRevision) return finish('revision-mismatch');
  if (!Array.isArray(offer.conversions)) return finish('invalid-current-state');
  const conversions = offer.conversions.filter(c => c?.id === conversionId);
  if (!conversions.length) return finish('conversion-missing');
  if (conversions.length !== 1 || conversions[0].status !== 'active') return finish('conversion-unavailable');
  for (const [key, code, expired] of [['validFrom', 'offer-not-started', false], ['validUntil', 'offer-expired', true], ['reviewDueAt', 'offer-review-due', true]]) {
    if (offer[key] === null) continue; // 既存契約：未設定は期間による制限なし。永久保証ではない。
    if (typeof offer[key] !== 'string' || !Number.isFinite(Date.parse(offer[key]))) return finish('invalid-current-state');
    if (expired ? now.getTime() >= Date.parse(offer[key]) : now.getTime() < Date.parse(offer[key])) return finish(code);
  }
  return finish('offer-active');
}
export function currentOfferCheckPasses(draft, check) {
  const c = draft.affiliateContext;
  return Boolean(c && check && Object.keys(check).sort().join() === ['schemaVersion', 'checkedAt', 'offerId', 'fixedRevision', 'currentRevision', 'conversionId', 'status', 'result', 'reasonCode'].sort().join()
    && check.schemaVersion === 1 && typeof check.checkedAt === 'string' && Number.isFinite(Date.parse(check.checkedAt))
    && check.offerId === c.offerId && check.fixedRevision === c.offerRevision && check.currentRevision === c.offerRevision
    && check.conversionId === c.conversionId && check.status === 'active' && check.result === 'pass' && check.reasonCode === 'offer-active');
}
