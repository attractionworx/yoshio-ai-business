import { invalid } from './content.js';
import { safeText } from './offers/validation.js';

export const bindingFields = ['offerId', 'offerRevision', 'conversionId', 'selectionReason'];

// 名前は履歴から取り出す。クライアントのsnapshotや案件条件は受け取らない。
export async function resolvePlanOffer(form, previous, store) {
  const [offerId, revisionText, conversionId, reason] = bindingFields.map(key => (form.get(key) || '').trim());
  if (reason.length > 1000) throw invalid('選択理由は1,000文字以内にしてください。');
  safeText(reason);
  if (!offerId) {
    if (revisionText || conversionId || reason) throw invalid('案件なしの場合、成果地点・revision・選択理由は指定できません。');
    return null;
  }
  if (!/^[1-9]\d*$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText))) throw invalid('案件revisionが不正です。');
  const history = await store.history(offerId);
  const revision = Number(revisionText);
  const offer = history.find(item => item.revision === revision);
  const conversion = offer?.conversions.find(item => item.id === conversionId);
  if (!offer || !conversion) throw invalid('案件revisionまたは成果地点が見つかりません。');
  const unchanged = previous?.offerId === offerId && previous.conversionId === conversionId;
  if (unchanged) {
    if (previous.offerRevision !== revision) throw invalid('保存済みの案件revisionは変更できません。', 409);
    return { ...previous, selectionReason: reason };
  }
  const latest = history.at(-1);
  if (latest.status !== 'active') throw invalid('新しく選択できる案件はactiveだけです。');
  if (latest.revision !== revision) throw invalid('案件が更新されています。企画画面を開き直して選択してください。', 409);
  return { offerId, offerRevision: revision, conversionId, selectionReason: reason,
    snapshot: { offerName: offer.name, conversionName: conversion.name } };
}

export function planOfferViews(e) {
  function detail(binding, current) {
    if (!binding) return '<p>案件：使用しない</p>';
    return `<section data-plan-binding><h2>この企画の案件・成果地点</h2><dl>
<div><dt>案件名</dt><dd>${e(binding.snapshot.offerName)}</dd></div>
<div><dt>成果地点名</dt><dd>${e(binding.snapshot.conversionName)}</dd></div>
<div><dt>使用しているoffer revision</dt><dd>${e(binding.offerRevision)}</dd></div>
<div><dt>現在の案件status</dt><dd>${e(current?.status || '確認できません')}</dd></div>
<div><dt>選択理由</dt><dd>${e(binding.selectionReason || '未入力')}</dd></div></dl>
${!current ? '<p class="notice" role="alert">現在の案件を確認できません。保存済みの紐付けは保持しています。</p>' : current.status !== 'active' ? `<p class="notice" role="alert">現在この案件は${e(current.status)}です。保存済みの紐付けは保持しています。</p>` : ''}
${current && current.revision !== binding.offerRevision ? `<p class="notice">この企画は案件 revision ${e(binding.offerRevision)} を使用しています。現在の案件は revision ${e(current.revision)} です。自動更新はしません。</p>` : ''}</section>`;
  }
  function form(offers, binding) {
    const choices = offers.filter(offer => offer.status === 'active' || offer.id === binding?.offerId);
    if (binding && !choices.some(offer => offer.id === binding.offerId)) choices.push({ id: binding.offerId, name: binding.snapshot.offerName, revision: binding.offerRevision, status: 'missing', conversions: [] });
    const conversions = choices.flatMap(offer => offer.status === 'active' ? offer.conversions.map(item => ({ ...item, offerId: offer.id, offerName: offer.name })) : []);
    if (binding) {
      const index = conversions.findIndex(item => item.offerId === binding.offerId && item.id === binding.conversionId);
      const saved = { offerId: binding.offerId, offerName: binding.snapshot.offerName, id: binding.conversionId, name: `${binding.snapshot.conversionName}（保存済み revision ${binding.offerRevision}）` };
      if (index < 0) conversions.push(saved); else conversions[index] = saved;
    }
    return `<fieldset data-plan-offer data-saved-offer="${e(binding?.offerId || '')}" data-saved-conversion="${e(binding?.conversionId || '')}" data-saved-revision="${e(binding?.offerRevision || '')}"><legend>案件・成果地点（任意）</legend>
<p class="hint">人間が選択する判断記録です。案件情報・選択理由はAIの依頼文へ送信しません。</p>
<div class="field"><label for="offerId">案件</label><select id="offerId" name="offerId"><option value="">案件を使用しない</option>${choices.map(offer => `<option value="${e(offer.id)}" data-revision="${e(offer.revision)}"${binding?.offerId === offer.id ? ' selected' : ''}>${e(binding?.offerId === offer.id ? binding.snapshot.offerName : offer.name)}${offer.status !== 'active' ? `（現在 ${e(offer.status)}・保存済み選択のみ）` : ''}</option>`).join('')}</select></div>
<div class="field"><label for="conversionId">成果地点</label><select id="conversionId" name="conversionId"><option value="">成果地点を選択してください</option>${conversions.map(item => `<option value="${e(item.id)}" data-offer="${e(item.offerId)}"${binding?.offerId === item.offerId && binding?.conversionId === item.id ? ' selected' : ''}>${e(item.offerName)} ／ ${e(item.name)}</option>`).join('')}</select></div>
<input type="hidden" name="offerRevision" value="${e(binding?.offerRevision || '')}">
<div class="field"><label for="selectionReason">選択理由（任意・1,000文字以内）</label><textarea id="selectionReason" name="selectionReason" maxlength="1000" rows="3">${e(binding?.selectionReason || '')}</textarea></div>
<p data-binding-revision class="hint" aria-live="polite"></p><noscript>案件の新規選択・変更にはJavaScriptを有効にしてください。保存済みの選択はそのまま保存できます。</noscript></fieldset>`;
  }
  return { detail, form };
}
