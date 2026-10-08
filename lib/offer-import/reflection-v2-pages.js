import { reflectionV2ChoiceGuidance } from './reflection-v2-guidance.js';
import { mappingDraftBinding } from './reflection-mapping-draft.js';
import { reflectionError } from './projection.js';
import { permitsMultipleConversions, reflectionV2Eligibility, v2ValidationError } from './reflection-v2-policy.js';

const bad = () => { throw reflectionError(400); };
export function reflectionV2Offer(query, draft) {
  if ([...query.keys()].some(k => k !== 'offerId') || query.getAll('offerId').length > 1) bad();
  return query.get('offerId') || draft.targetOffer?.id || null;
}
export function parseReflectionV2Form(form, draft, offer, partial = false) {
  const one = key => { if (form.getAll(key).length !== 1) { const [id, field] = key.split('.'); if (draft.candidates.some(c => c.id === id)) throw v2ValidationError(id, field, 'V2_FORM_FIELD_INVALID'); bad(); } return form.get(key); };
  const allowed = ['version', 'offerId', 'importRevision', 'offerRevision', 'draftAction', 'draftRevision', 'importHash', 'offerHash'];
  if (form.has('draftAction') && (one('draftAction') !== 'save' || !partial)) bad();
  for (const c of draft.candidates) allowed.push(`${c.id}.mode`, `${c.id}.target`, `${c.id}.reason`, `${c.id}.common`);
  if ([...form.keys()].some(k => !allowed.includes(k)) || one('version') !== '2' || one('offerId') !== offer.id) bad();
  for (const [key, value] of [['importRevision', draft.revision], ['offerRevision', offer.revision]]) {
    const raw = one(key);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) bad();
    if (Number(raw) !== value) throw reflectionError(409);
  }
  return { schemaVersion: 2, offerId: offer.id, choices: draft.candidates.map(c => {
    const common = form.getAll(`${c.id}.common`);
    if (common.length > 1 || (common.length && common[0] !== 'yes')) throw v2ValidationError(c.id, 'common', 'V2_FORM_FIELD_INVALID');
    const targets = form.getAll(`${c.id}.target`);
    if (targets.includes('') && targets.length !== 1) throw v2ValidationError(c.id, 'target', 'V2_MAPPING_TARGET_INVALID');
    return { candidateId: c.id, mode: one(`${c.id}.mode`), conversionIds: targets.length === 1 && targets[0] === '' ? [] : targets,
      reason: one(`${c.id}.reason`), commonConfirmed: common.length === 1 };
  }) };
}
export function reflectionV2Pages(e) {
  function selection(draft, offers, offerId, options = null, savedDraft = null) {
    const offer = offers.find(o => o.id === offerId && (!draft.targetOffer || draft.targetOffer.id === o.id));
    if (offerId && !offer) throw reflectionError(404);
    const url = `/offer-imports/${draft.id}/reflection-v2`;
    const guides = draft.candidates.map(c => ({ id: c.id, ...reflectionV2ChoiceGuidance(options?.choices.find(x => x.candidateId === c.id) || { mode: '', conversionIds: [], commonConfirmed: false, reason: '' }) }));
    return `<section class="card import-review reflection-v2"><h1>候補ごとの正式反映先を確認（方式v2）</h1>
      <p class="notice">AI整理グループは参考情報です。人間が各候補の反映先または反映なし理由を選びます。プレビューは正式案件へ保存しません。下書き保存は対応判断だけを保存します。新規成果地点作成・推測・公開許可は行いません。</p>
      <p><a href="/offer-imports/${draft.id}/reflection">従来のグループ対応方式v1</a></p>
      <form method="get" action="${url}"><label>正式案件<select name="offerId" required><option value="">選択してください</option>${offers.filter(o => !draft.targetOffer || draft.targetOffer.id === o.id).map(o => `<option value="${e(o.id)}"${offer?.id === o.id ? ' selected' : ''}>${e(o.name)}（revision ${o.revision}）</option>`).join('')}</select></label><button>案件を選び候補を表示</button></form>
      ${!offer ? '<p>先に正式案件を選択してください。</p>' : `<p>import revision ${draft.revision} ／ offer revision ${offer.revision} ／ 全${draft.candidates.length}候補</p>
      <p>反映なしには理由が必要です。単一地点では共通確認は不要です。2地点以上を選ぶ場合だけ共通適用を人間が確認してください。地点選択だけでは反映判断（mode）は決まりません。異なる分類や未照合候補の反映は保存前に停止します。</p>
      ${savedDraft ? `<p class="notice">下書きから再開 ／ 下書きrevision ${savedDraft.revision} ／ 入力済み ${savedDraft.progress.complete}件 ／ 未入力・未完了 ${savedDraft.progress.incomplete}件。下書きは承認・正式反映ではありません。</p>` : '<p>保存済み下書きなし。途中の入力は下書き保存できます。</p>'}
      <details><summary>未入力・未完了の理由（${guides.filter(g => g.status !== 'complete').length}件）</summary><ul>${guides.filter(g => g.status !== 'complete').map(g => `<li><a href="#mapping-${g.id}">${e(g.id)}</a>：${e(g.message)}</li>`).join('')}</ul></details>
      <nav aria-label="反映候補一覧">${draft.candidates.map(c => `<a href="#mapping-${c.id}">${e(c.id)}</a>`).join(' ／ ')}</nav>
      <form method="post" action="${url}" data-reflection-v2-form autocomplete="off"><input type="hidden" name="draftRevision" value="${savedDraft?.revision || 0}"><input type="hidden" name="importHash" value="${mappingDraftBinding(draft, offer).importHash}"><input type="hidden" name="offerHash" value="${mappingDraftBinding(draft, offer).offerHash}"><input type="hidden" name="version" value="2"><input type="hidden" name="offerId" value="${e(offer.id)}"><input type="hidden" name="importRevision" value="${draft.revision}"><input type="hidden" name="offerRevision" value="${offer.revision}">
      <p data-mapping-input-progress role="status">表示中の入力：入力完了 ${guides.filter(g => g.status === 'complete').length}件 ／ 未入力・未完了 ${guides.filter(g => g.status !== 'complete').length}件。mode未選択は地点選択済みでも未完了です。</p>
      ${draft.candidates.map(c => {
        const eligibility = reflectionV2Eligibility(c, draft);
        const p = c.review.edited || c.original, choice = options?.choices.find(x => x.candidateId === c.id);
        const guidance = guides.find(g => g.id === c.id);
        return `<details id="mapping-${c.id}" data-mapping-candidate="${c.id}" class="import-candidate" open><summary>${e(c.id)}：${e(p.text.slice(0, 60))} ／ ${choice?.mode ? e(choice.mode === 'none' ? '反映なし' : choice.mode === 'offer' ? '案件項目' : '成果地点') : '反映判断未選択'} ／ <span data-mapping-summary>${guidance.status === 'complete' ? '入力完了' : guidance.status === 'invalid' ? '不整合・停止' : '未完了'}</span></summary>
          <p data-mapping-status data-status="${guidance.status}" tabindex="-1" role="status">${e(guidance.message)}</p>
          <p class="import-text">${e(p.text)}</p><p>target：${e(p.target)} ／ category：${e(p.category)} ／ usage：${e(p.usage)}</p><p>判断：${e(c.review.decision)} ／ 照合：${e(c.review.verification)} ／ 有効グループ（参考）：${e(p.conversionKey || 'なし')}</p>
          <details><summary>根拠引用（${p.evidence.length}件）を確認</summary>${p.evidence.map(ref => `<p>${e(draft.documents.find(d => d.id === ref.documentId).label)} ／ ${e(ref.blockId)} ／ ${ref.start}–${ref.end}</p><blockquote class="import-text">${e(ref.quote)}</blockquote>`).join('')}</details>
          ${!eligibility.offer && !eligibility.conversions ? '<p class="notice">この候補は現在のusage/classification・採用／照合状態では正式案件項目へ反映できません。反映なしも自動決定しません。人間が判断してください。</p>' : ''}
          <label>反映判断<select name="${c.id}.mode" required><option value="">人間が選択してください</option><option value="none"${choice?.mode === 'none' ? ' selected' : ''}>反映しない（理由必須）</option>${eligibility.offer ? `<option value="offer"${choice?.mode === 'offer' ? ' selected' : ''}>案件項目へ反映</option>` : ''}${eligibility.conversions ? `<option value="conversions"${choice?.mode === 'conversions' ? ' selected' : ''}>下で選ぶ既存成果地点へ反映</option>` : ''}</select></label>
          ${eligibility.conversions ? `<fieldset><legend>既存成果地点：${permitsMultipleConversions(p) ? '共通条件として複数選択可能' : '1件だけ選択'}</legend>${!permitsMultipleConversions(p) ? `<label class="choice"><input type="radio" data-mapping-target name="${c.id}.target" value="">地点の選択を解除（反映なしの場合）</label>` : ''}${offer.conversions.map(cv => `<label class="choice"><input type="${permitsMultipleConversions(p) ? 'checkbox' : 'radio'}" data-mapping-target name="${c.id}.target" value="${e(cv.id)}"${choice?.conversionIds.includes(cv.id) ? ' checked' : ''}>${e(cv.name)}（${e(cv.id)} ／ ${e(cv.status)}）</label>`).join('') || '<p>成果地点がありません。正式案件の編集で先に登録してください。</p>'}${permitsMultipleConversions(p) ? `<label class="choice"><input type="checkbox" data-mapping-common name="${c.id}.common" value="yes"${choice?.commonConfirmed ? ' checked' : ''}>2地点以上を選んだ場合のみ：この条件の共通適用を人間が確認しました（単一地点ではチェック不要）</label>` : ''}<p>単一地点では共通確認は不要です。2地点から1地点へ変更してチェックが残った場合は、人間が解除するまで停止します。値は自動解除しません。反映なしを選ぶ場合も地点の選択と共通確認を人間が解除してください。</p></fieldset>` : ''}
          <label>反映なしの理由／対応の確認理由<textarea name="${c.id}.reason" maxlength="1000" rows="2">${e(choice?.reason || '')}</textarea></label></details>`;
      }).join('')}
      <p>未保存のreview編集は含みません。対応変更後は新しいプレビューを作成してください。新しいv2プレビューの作成で以前のv2承認は失効します。</p><button${draft.candidates.length ? '' : ' disabled'}>保存せず対応全体のプレビューを作成</button><button type="submit" name="draftAction" value="save" formnovalidate>途中の対応判断を下書き保存</button><p>下書き保存でoffer・import・レビュー・照合状態は変わりません。ブラウザの入力だけでは保存されません。</p></form>`}</section><script type="module" src="/reflection-v2.js"></script>`;
  }
  function decisions(plan, offer) {
    return `<section class="card import-review"><h2>承認対象の全候補対応（方式v2）</h2>${plan.decisions.map(d => `<details open><summary>${e(d.candidateId)}：${d.mode === 'none' ? '反映なし' : d.mode === 'offer' ? '案件項目へ反映' : '既存成果地点へ反映'}</summary><p class="import-text">${e(d.text)}</p><p>target：${e(d.target)} ／ category：${e(d.category)} ／ usage：${e(d.usage)} ／ 有効グループ：${e(d.conversionKey || 'なし')}</p><p>反映先：${d.mode === 'none' ? 'なし' : d.mode === 'offer' ? '案件項目' : d.conversionIds.map(id => `${e(offer.conversions.find(c => c.id === id)?.name || '')}（${e(id)}）`).join(' ／ ')}</p><p>理由：${e(d.reason || '任意理由なし')} ／ 共通適用の人間確認：${d.commonConfirmed ? 'あり' : '対象外'}</p><details><summary>根拠・原文引用</summary>${d.citations.map(ref => `<p>${e(ref.documentId)} ／ ${e(ref.blockId)} ／ ${ref.start}–${ref.end}</p><blockquote>${e(ref.quote)}</blockquote>`).join('')}</details></details>`).join('')}</section>`;
  }
  return { selection, decisions };
}
