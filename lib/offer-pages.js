import { businessProperties, resolveRule, emptyValue, newOfferInput } from './offers/form.js';
import { toJapanInput } from './offers/ui-guidance.js';

const labels = {
  name: '案件名／成果地点名', advertiserName: '広告主（advertiser）', asp: 'ASP', code: 'ASPコード', programId: 'ASPの案件番号', status: '状態',
  validFrom: '有効開始日時', validUntil: '有効終了日時', reviewDueAt: '再確認期限', sources: '出典', id: 'ID（同じ種類内で重複不可）',
  kind: '種類', label: '資料名', publicUrl: '公開資料URL', checkedAt: '資料を確認した日時', facts: '事実・情報', targetAudience: '対象読者',
  sellingPoints: '訴求ポイント', prohibitedExpressions: '禁止表現', conversions: '成果地点', disclosure: '広告・アフィリエイト明示',
  category: '情報の分類', text: '本文', origin: '情報の提供元', sourceIds: '参照する出典ID', verification: '確認状態', usage: '利用区分',
  reward: '報酬（内部管理専用）', value: '金額／割合', currency: '通貨（定額ならJPY等、割合なら空欄）', evidence: '報酬の根拠',
  eligibility: '対象となる条件', approvalConditions: '成果条件', rejectionConditions: '否認条件', affiliateUrl: 'アフィリエイトURL', ctaLabel: '行動案内（CTA）',
  required: '広告明示を必須にする', placements: '広告明示の位置',
};
const options = {
  draft: '下書き（draft）', active: '有効（active）', paused: '停止中（paused）', ended: '終了（ended）',
  unverified: '未確認（公開記事の根拠に使えません）', source_checked: '出典確認済み',
  publishable: '公開記事の根拠に使用可能（出典確認が必要）', constraint_only: '記事生成時の制約として使用', internal_only: '内部管理専用',
  advertiser_material: '広告主の資料', asp_material: 'ASPの資料', user_provided: '人間が提供した資料', advertiser: '広告主', asp: 'ASP', editor: '編集者',
  price: '価格', track_record: '実績', effect: '効果', feature: '特徴', audience: '対象読者', selling_point: '訴求点', eligibility: '対象条件', approval: '成果条件', rejection: '否認条件', prohibition: '禁止事項', reward: '報酬', other: 'その他',
  fixed: '定額', percentage: '割合（%）', bodyStart: '本文冒頭', cta: 'CTA付近', social: 'SNS告知文',
};

export function offerPages(e) {
  let sources = [];
  function requirement(rule, path) {
    if (/\.(?:eligibility|approvalConditions|rejectionConditions|prohibitedExpressions|affiliateUrl|ctaLabel|conversions)$/.test(path)) return '有効化する場合に必須';
    if (/\.sourceIds$/.test(path)) return '出典確認済みにする場合に必須';
    if (/\.checkedAt$/.test(path)) return '出典確認済みにする場合に必須';
    if (rule.oneOf || rule.type === 'array' && !rule.minItems) return '任意（未登録は未確認）';
    if (/\.(?:name|code|required|text|placements|status)$/.test(path) && path.split('.').length <= 3) return '必須';
    return '項目を登録する場合に必須';
  }
  function render(original, value, path, label, depth = 0, readonly = false, requirementHint = null) {
    const rule = resolveRule(original);
    const fieldLabel = readonly ? label : `${label}【${requirementHint || requirement(rule, path)}】`;
    if (readonly && value === null) return `<p>${e(label)}：未入力</p>`;
    if (rule.oneOf) {
      const child = resolveRule(rule.oneOf.find(item => item.type !== 'null'));
      if (child.type === 'object' && !readonly) return `<fieldset data-optional><legend>${e(fieldLabel)}</legend>
        <label>登録するか<select name="${e(path)}.__present" data-optional-select><option value="null"${value === null ? ' selected' : ''}>未登録</option><option value="value"${value !== null ? ' selected' : ''}>登録する</option></select></label>
        <div data-optional-fields>${render(child, value ?? emptyValue(child), path, label, depth, false)}</div></fieldset>`;
      return render(child, value ?? '', path, label, depth, readonly, requirement(rule, path));
    }
    if (rule.type === 'object') return `<fieldset><legend>${e(fieldLabel)}</legend>${Object.entries(rule.properties).map(([key, child]) => render(child, value?.[key] ?? emptyValue(child), `${path}.${key}`, labels[key] || key, depth, readonly)).join('')}</fieldset>`;
    if (rule.type === 'array') {
      const items = value || [];
      if (readonly) return `<section class="offer-group"><h3>${e(label)}</h3>${items.length ? items.map(item => render(rule.items, item, path, label, depth + 1, true)).join('') : '<p class="hint">未登録・未確認（条件なしを意味しません）</p>'}</section>`;
      const token = `__i${depth}__`;
      const item = (value, index) => `<div data-array-item>${render(rule.items, value, `${path}.${index}`, `${label}の項目`, depth + 1)}<button type="button" class="secondary" data-remove-item>この項目を削除</button></div>`;
      return `<fieldset data-array data-next="${items.length}" data-token="${token}" data-max="${rule.maxItems}"><legend>${e(fieldLabel)}</legend>
        <p class="hint">必要な項目を追加してください。空欄の項目を追加した場合は、入力するか削除してください。出典IDは参照欄と一致させてください。</p>
        <input type="hidden" name="${e(path)}.__array" value="1"><div data-items>${items.map(item).join('')}</div>
        <template>${item(emptyValue(rule.items), token)}</template><button type="button" class="secondary" data-add-item>${e(label)}を追加</button></fieldset>`;
    }
    if (readonly) return `<div class="offer-value"><strong>${e(label)}</strong><p>${e(rule.enum ? options[value] || String(value) : String(value))}${rule.enum ? ` <small class="hint">${e(value)}</small>` : ''}</p></div>`;
    let input;
    if (rule.enum) input = `<select name="${e(path)}">${rule.enum.map(option => `<option value="${e(option)}"${value === option ? ' selected' : ''}>${e(options[option] || option)}</option>`).join('')}</select>`;
    else if (typeof rule.const === 'boolean') input = `<select name="${e(path)}"><option value="true">必須（解除できません）</option></select>`;
    else if (path.endsWith('.text')) input = `<textarea name="${e(path)}" rows="3" maxlength="${rule.maxLength || 5000}">${e(value)}</textarea>`;
    else if (/\.sourceIds\.[^.]+$/.test(path)) input = `<select name="${e(path)}" data-source-ref><option value="">出典を選択してください</option>${sources.map(source => `<option value="${e(source.id)}"${value === source.id ? ' selected' : ''}>${e(source.label)}（${e(source.id)}）</option>`).join('')}${value && !sources.some(s => s.id === value) ? `<option value="${e(value)}" selected>参照先がありません（${e(value)}）</option>` : ''}</select>`;
    else if (rule.format === 'date-time') input = `<input type="datetime-local" step="0.001" name="${e(path)}" value="${e(toJapanInput(value))}">`;
    else input = `<input name="${e(path)}" value="${e(value)}" maxlength="${rule.maxLength || 5000}"${rule.type === 'number' ? ' inputmode="decimal"' : ''}${path.endsWith('.id') ? ' data-internal-id' : ''}>`;
    return `<label class="field">${e(fieldLabel)}${input}${rule.enum ? `<span class="hint">${e(rule.enum.join(' / '))}</span>` : ''}${rule.format === 'date-time' ? '<span class="hint">日本時間（UTC+09:00）で入力・保存します。端末のタイムゾーンには依存しません。</span>' : ''}${path.endsWith('.id') ? '<span class="hint">新規追加時は自動入力。既存IDは変更しないでください。半角英数字・ハイフン・アンダースコアが使用できます。</span>' : ''}</label>`;
  }
  const legend = '<p class="notice">未確認の情報は公開記事の根拠に使えません。「照合済み」は資料を人間が確認した記録です。公開用・制約用・内部管理専用を分けて登録してください。空の条件欄は「条件なし」ではありません。</p>';
  function list(offers) {
    return `<section class="card"><h1>案件管理</h1><a href="/offers/new">新しい案件を登録</a><p><a href="/offer-extractions/new">資料から登録候補を作る</a></p>${legend}
      ${offers.length ? `<ul class="plan-list">${offers.map(o => `<li><a href="/offers/${o.id}">${e(o.name)}</a><p>広告主：${e(o.advertiserName || '未入力')} ／ ASP：${e(o.asp.code)}<br>revision：${o.revision} ／ ${e(options[o.status])}<br>最終更新：${e(o.updatedAt)}</p></li>`).join('')}</ul>` : '<p>登録済み案件はありません。</p>'}</section>`;
  }
  function form(offer = null) {
    const value = offer || newOfferInput();
    sources = value.sources;
    const basic = ['name', 'advertiserName', 'asp', 'status', 'validFrom', 'validUntil', 'reviewDueAt'];
    const sections = [['basic', '基本情報', basic], ...Object.keys(businessProperties).filter(key => !basic.includes(key)).map(key => [key, labels[key], [key]])];
    return `<a class="back" href="/offers${offer ? `/${offer.id}` : ''}">← ${offer ? '案件詳細' : '案件一覧'}</a><section class="card offer-editor"><h1>${offer ? '案件を編集' : '案件の新規登録'}</h1>${legend}
      <p>APIキー・Cookie・パスワード・管理画面の全文は入力しないでください。保存時に検査します。activeへの変更には、確認済みの条件・禁止表現・CTAとURLが必要です。</p>
      <details><summary>有効化に必要な項目</summary><ul><li>案件の禁止表現を登録し、出典確認済みにする（内部管理専用は不可）。</li><li>少なくとも1つの成果地点を有効にする。</li><li>有効な成果地点の対象条件・成果条件・否認条件を登録し、出典確認済みにする（内部管理専用は不可）。</li><li>有効な成果地点のCTAを登録し、出典確認済み・公開用にする。アフィリエイトURLも必須。</li><li>出典確認済みの情報には出典参照と資料の確認日時が必要。公開用を選んだだけでは確認済みにはなりません。</li></ul></details>
      <noscript><p class="notice">項目の追加・削除とID自動入力にはJavaScriptが必要です。基本情報での下書き登録、既存項目の編集、日時入力、折りたたみ、保存は利用できます。任意項目の入力欄は常に表示しますが「未登録」の場合は保存されません。</p></noscript>
      <form method="post" action="/offers${offer ? `/${offer.id}/edit` : ''}" data-offer-form autocomplete="off">
      <input type="hidden" name="timeZone" value="Asia/Tokyo">
      <label>案件ID（新規は空欄で自動発行）<input name="id" value="${e(offer?.id || '')}"${offer ? ' readonly' : ''}></label>
      ${offer ? `<p>現在revision：${offer.revision}（保存すると新しい版になります）</p><input type="hidden" name="revision" value="${offer.revision}">` : ''}
      <nav aria-label="入力セクション">${sections.map(([key, label]) => `<a href="#offer-section-${key}">${e(label)}</a>`).join(' ／ ')}</nav>
      ${sections.map(([key, label, keys]) => `<details id="offer-section-${key}"${key === 'basic' ? ' open' : ''}><summary>${e(label)}</summary>${keys.map(key => render(businessProperties[key], value[key], `offer.${key}`, labels[key] || key)).join('')}</details>`).join('')}
      <p role="status" data-offer-message>保存後も公開やAI生成は実行されません。</p><button>案件を保存する</button></form></section>`;
  }
  function detail(offer, history, historical = false) {
    return `<a class="back" href="/offers">← 案件一覧</a><article class="card"><h1>${e(offer.name)}</h1><p>案件ID：${e(offer.id)} ／ revision：${offer.revision} ／ ${e(options[offer.status])}</p>
      <p>作成：${e(offer.createdAt)} ／ 更新：${e(offer.updatedAt)}</p>
      ${historical ? `<p class="notice">過去revisionの閲覧です。<a href="/offers/${offer.id}">最新版へ</a></p>` : `<a href="/offers/${offer.id}/edit">編集・状態変更</a><p><a href="/offer-extractions/new?offerId=${offer.id}">資料から登録候補を作る</a></p>`}${legend}
      ${Object.entries(businessProperties).map(([key, rule]) => render(rule, offer[key], key, labels[key] || key, 0, true)).join('')}
      <h2>revision履歴</h2><ul>${history.map(o => `<li><a href="/offers/${offer.id}/revisions/${o.revision}">revision ${o.revision}</a> ／ ${e(options[o.status])} ／ ${e(o.updatedAt)}</li>`).join('')}</ul></article>`;
  }
  return { list, form, detail };
}
