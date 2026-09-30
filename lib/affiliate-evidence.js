import { contextHash, extractAffiliateSnapshot, validateAffiliateContext } from './ai/affiliate-context.js';
import { validateOffer } from './offers/validation.js';
import { invalid } from './content.js';

// 読取adapterだけが非同期。ネットワーク・最新版status・公開可否には依存しない。
export async function loadAffiliateEvidence(context, store) {
  const checked = validateAffiliateContext(context);
  let fixed;
  try {
    const history = await store.history(checked.offerId);
    fixed = history.find(o => o.id === checked.offerId && o.revision === checked.offerRevision);
    return verifyAffiliateEvidence(checked, fixed);
  } catch {
    throw invalid('固定した案件根拠を安全に確認できません。', 409);
  }
}

// pure: 戻り値はStep 4と同じ公開安全snapshotのみ。管理情報を複製しない。
export function verifyAffiliateEvidence(context, offer) {
  try {
    const checked = validateAffiliateContext(context);
    const fixed = validateOffer(offer);
    if (fixed.id !== checked.offerId || fixed.revision !== checked.offerRevision) throw new Error();
    const conversion = fixed.conversions.find(c => c.id === checked.conversionId);
    if (!conversion) throw new Error();
    const snapshot = extractAffiliateSnapshot(fixed, conversion);
    if (contextHash(snapshot) !== checked.contextHash) throw new Error();
    return snapshot;
  } catch {
    throw invalid('固定した案件根拠と保存済みsnapshotが一致しません。', 409);
  }
}
