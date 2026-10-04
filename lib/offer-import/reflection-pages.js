import { reflectionError } from './projection.js';

export function reflectionOptions(query, draft) {
  const keys = [...new Set(draft.candidates.map(c => (c.review.edited || c.original).conversionKey).filter(Boolean))];
  const allowed = ['offerId', ...keys.map((_, i) => `conversion.${i}`)];
  if ([...query.keys()].some(k => !allowed.includes(k)) || allowed.some(k => query.getAll(k).length > 1)) throw reflectionError(400);
  const offerId = query.get('offerId') || draft.targetOffer?.id;
  return offerId ? { offerId, conversions: keys.flatMap((key, i) => query.get(`conversion.${i}`) ? [{ key, id: query.get(`conversion.${i}`) }] : []) } : null;
}
export function parseReflectionApproval(form) {
  if ([...form.keys()].some(k => !['token', 'confirm'].includes(k)) || form.getAll('token').length !== 1
    || form.getAll('confirm').length !== 1 || form.get('confirm') !== 'yes') throw reflectionError(400);
  return form.get('token');
}
export function reflectionPages(e) {
  const json = value => `<pre>${e(JSON.stringify(value, null, 2))}</pre>`;
  function selection(draft, offers, options = null) {
    const keys = [...new Set(draft.candidates.map(c => (c.review.edited || c.original).conversionKey).filter(Boolean))];
    const current = offers.find(o => o.id === options?.offerId);
    return `<section class="card"><h1>正式案件への反映先を選ぶ</h1><p>保存済みで採用・出典照合済みの候補だけを使います。未保存の画面編集は含みません。新規案件作成・成果地点の推測は行いません。</p>
      <form method="get" action="/offer-imports/${draft.id}/reflection"><label>反映先の正式案件<select name="offerId" required><option value="">選んでください</option>${offers.filter(o => !draft.targetOffer || o.id === draft.targetOffer.id).map(o => `<option value="${o.id}"${current?.id === o.id ? ' selected' : ''}>${e(o.name)}（revision ${o.revision}）</option>`).join('')}</select></label>
      ${keys.map((key, i) => `<label>グループ「${e(key)}」の反映先（任意）<select name="conversion.${i}"><option value="">反映しない</option>${(current?.conversions || []).map(c => `<option value="${e(c.id)}"${options?.conversions.some(m => m.key === key && m.id === c.id) ? ' selected' : ''}>${e(c.name)}（${e(c.id)}）</option>`).join('')}</select></label>`).join('')}<p>先に案件を選んで表示を更新すると、その案件の成果地点を選べます。グループ名だけで成果地点へ自動対応させません。</p><button>保存せず反映プレビューを作る・更新する</button></form></section>`;
  }
  function preview(draft, prepared) {
    const p = prepared.plan;
    return `<section class="card import-review"><h1>正式案件への反映プレビュー</h1><p class="notice">この表示だけでは保存しません。承認すると正式案件に新しいrevisionが作成されます。正式案件への反映、出典照合、公開許可は別です。案件の状態を自動でactiveにしません。</p>
      <dl><dt>取り込みID / revision</dt><dd>${e(p.importId)} / ${p.importRevision}</dd><dt>対象offer ID</dt><dd>${e(p.offerId)}</dd><dt>現在のoffer revision → 作成予定</dt><dd>${p.offerRevision} → ${p.nextRevision}</dd><dt>プレビュー内容hash</dt><dd>${e(prepared.hash || '')}</dd></dl>
      <h2>追加・変更内容</h2>${p.changes.map(c => `<article><h3>${e(c.candidateId)} → ${e(c.field)}（${c.operation === 'add' ? '追加' : '変更'}）</h3><p>利用区分：${e(c.usage)}</p><h4>変更前</h4>${json(c.before)}<h4>変更後・追加する値</h4>${json(c.after)}</article>`).join('') || '<p>反映可能な変更はありません。</p>'}
      <h2>候補と正式ID・出典の対応</h2>${p.mappings.map(m => `<article><h3>${e(m.candidateId)} → ${e(m.field)}</h3><p>正式ID：${e(m.officialId || 'scalar項目のためIDなし')} ／ 利用区分：${e(m.usage)} ／ 個別照合：${e(m.checkedAt)}</p><p>source IDs：${e(m.sourceIds.join(', '))}</p>${m.citations.map(c => `<p>文書 ${e(c.documentId)} ／ ${e(c.blockId)} ／ 原文位置 ${c.start}–${c.end}</p><blockquote>${e(c.quote)}</blockquote>`).join('')}</article>`).join('')}
      <h2>反映する出典</h2>${json(p.sources)}<h2>反映しない候補と理由</h2><ul>${p.excluded.map(c => `<li>${e(c.candidateId)}：${e(c.reason)}</li>`).join('') || '<li>なし</li>'}</ul>
      <p>事実・条件・制約は既存配列に追加します。既存情報は自動削除・統合しません。矛盾や重複がないか、既存情報も確認してください。<a href="/offers/${p.offerId}">正式案件の現在の内容を確認</a></p><details><summary>反映後の案件業務項目全体を確認</summary>${json(p.input)}</details>
      <p>publishableは公開用の登録区分です。constraint_onlyは制約、internal_onlyは内部専用として保持します。公開可否は既存の検証・人間確認を通します。案件revisionの変更により既存記事の最終コピーが停止する場合があります。</p>
      ${prepared.token ? `<form method="post" action="/offer-imports/${draft.id}/commit"><input type="hidden" name="token" value="${e(prepared.token)}"><label><input type="checkbox" name="confirm" value="yes" required>追加・変更、除外理由、出典、利用区分を確認し、正式案件の新しいrevision作成を承認します</label><button>確認した内容を正式案件の新しい版に保存する</button></form>` : '<p>承認できる候補がありません。</p>'}<a href="/offer-imports/${draft.id}">レビューへ戻る</a></section>`;
  }
  function records(importId, data) {
    return `<section class="card import-review"><h1>反映記録・復旧確認</h1><p>commit intentを保存後、正式案件を保存し、commit resultを記録します。未解決intentはrecovery requiredとして扱い、新しい反映を停止します。復旧確認は案件を再保存しません。</p>
      ${(data.blockedBy || []).map(id => `<p role="alert">別の取り込みに未解決の反映があります。<a href="/offer-imports/${e(id)}/commits">その反映記録・復旧確認を開く</a></p>`).join('')}
      ${data.states.map(s => `<article><h2>${e(s.state)}</h2><p>commit ID：${e(s.intent.id)} ／ intent時刻：${e(s.intent.at)} ／ 結果時刻：${e(s.result?.at || '未確定')}</p><p>import ${e(s.intent.plan.importId)} revision ${s.intent.plan.importRevision} → offer ${e(s.intent.plan.offerId)} revision ${s.intent.plan.nextRevision}</p><p>preview hash：${e(s.intent.previewHash)}</p><details><summary>承認された変更・候補ID・正式ID・引用</summary>${json(s.intent.plan)}</details></article>`).join('') || '<p>反映記録はありません。</p>'}
      ${data.recovery ? `<p role="alert">復旧確認が必要です。履歴の完全一致による照合結果：${e(data.recovery.outcome === 'committed' ? '承認内容が予定revisionに保存されています' : data.recovery.outcome === 'not_applied' ? '正式案件は承認前の版のままです' : '安全に判定できません。記録を変更せず確認してください')}</p>${data.recovery.token ? `<form method="post" action="/offer-imports/${importId}/recover"><input type="hidden" name="token" value="${e(data.recovery.token)}"><label><input name="confirm" type="checkbox" value="yes" required>承認内容と正式案件履歴の照合結果を確認しました。案件を再保存せず、結果記録だけを確定します</label><button>照合した結果を反映記録に確定する</button></form>` : ''}` : ''}
      <a href="/offer-imports/${importId}/reflection">反映プレビューを作り直す</a> ／ <a href="/offer-imports/${importId}">候補レビューへ</a></section>`;
  }
  return { selection, preview, records };
}
