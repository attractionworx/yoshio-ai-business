const targets = ['name', 'conversion_name', 'disclosure_text', 'facts', 'targetAudience', 'sellingPoints', 'prohibitedExpressions', 'eligibility', 'approvalConditions', 'rejectionConditions', 'ctaLabel', 'reward_evidence', 'unmapped'];
const categories = ['price', 'track_record', 'effect', 'feature', 'audience', 'selling_point', 'eligibility', 'approval', 'rejection', 'prohibition', 'reward', 'other'];
const usages = ['publishable', 'constraint_only', 'internal_only'];
const purposes = ['fact', 'restriction', 'marketing_goal', 'conversion_condition', 'unmapped'];
const labels = { name: '案件名候補', conversion_name: '成果地点名候補', disclosure_text: '広告明示文候補', facts: '事実・情報', targetAudience: '対象読者', sellingPoints: '訴求ポイント', prohibitedExpressions: '禁止・制約', eligibility: '対象条件', approvalConditions: '成果条件', rejectionConditions: '否認条件', ctaLabel: 'CTA候補', reward_evidence: '報酬根拠（内部専用）', unmapped: '未分類', publishable: '公開用の提案', constraint_only: '制約用', internal_only: '内部専用', pending: '保留', accepted: '採用', rejected: '却下', unverified: '未確認', source_checked: '人間が出典照合済み' };
Object.assign(labels, { fact: '資料記載の事実候補', restriction: '禁止・制約', marketing_goal: '記事・CRの訴求ゴール', conversion_condition: 'ASPの成果条件', price: '価格', track_record: '実績', effect: '効果', feature: '特徴', audience: '対象読者', selling_point: '訴求点', approval: '成果条件', rejection: '否認条件', prohibition: '禁止事項', reward: '報酬', other: 'その他' });
const bad = () => { throw Object.assign(new Error('レビュー入力が不正です。'), { status: 400 }); };
function fields(form, names) {
  if ([...form.keys()].some(k => !names.includes(k)) || names.some(k => form.getAll(k).length !== 1)) bad();
  if (!/^[1-9]\d*$/.test(form.get('revision')) || !Number.isSafeInteger(Number(form.get('revision')))) bad();
}

// Evidence and AI originals come only from the stored draft, never from browser fields.
export function parseReviewForm(form, candidate, verifying = false) {
  if (verifying) {
    fields(form, ['revision', 'confirm']);
    if (form.get('confirm') !== 'yes' || candidate.review.decision !== 'accepted') bad();
    return { revision: Number(form.get('revision')), action: { decision: 'accepted', edited: candidate.review.edited,
      sourceChecked: true, reason: candidate.review.reason } };
  }
  fields(form, ['revision', 'decision', 'text', 'target', 'category', 'usage', 'purpose', 'conversionKey', 'reason']);
  if (!['pending', 'accepted', 'rejected'].includes(form.get('decision'))) bad();
  const base = candidate.review.edited || candidate.original;
  const edited = { ...structuredClone(base), text: form.get('text'), target: form.get('target'), category: form.get('category'),
    usage: form.get('usage'), purpose: form.get('purpose'), conversionKey: form.get('conversionKey') || null };
  return { revision: Number(form.get('revision')), action: { decision: form.get('decision'),
    edited: JSON.stringify(edited) === JSON.stringify(candidate.original) ? null : edited,
    sourceChecked: false, reason: form.get('reason') } };
}

// Presentation derived exclusively from the stored review snapshot.
function reviewDisplay(candidate) {
  const r = candidate.review;
  if (r.decision === 'rejected') return { key: 'rejected', symbol: '×', label: 'レビュー完了・却下', summary: '却下' };
  if (r.decision === 'accepted' && r.verification === 'source_checked') return { key: 'checked', symbol: '✓', label: 'レビュー完了・採用', summary: '採用 / 人間が出典照合済み' };
  if (r.decision === 'accepted') return { key: 'waiting', symbol: '○', label: '要対応：採用・出典照合待ち', summary: '採用 / 出典照合待ち' };
  return { key: 'pending', symbol: '△', label: '要対応：未着手・保留', summary: '未着手・保留' };
}

export const isActionableCandidate = c => ['pending', 'waiting'].includes(reviewDisplay(c).key);
const navigationError = status => { throw Object.assign(new Error('候補の表示指定が不正です。'), { status }); };

// GET-only presentation parameters. Never passed to review/verify/store.
export function parseReviewNavigation(query, draft) {
  if ([...query.keys()].some(k => !['candidate', 'view'].includes(k))
      || ['candidate', 'view'].some(k => query.getAll(k).length > 1)) navigationError(400);
  const view = query.get('view') ?? 'actionable';
  if (!['actionable', 'all'].includes(view)) navigationError(400);
  const id = query.get('candidate');
  if (id !== null && !/^candidate-[1-9]\d*$/.test(id)) navigationError(400);
  const explicit = id !== null;
  const selected = explicit ? draft.candidates.find(c => c.id === id) : draft.candidates.find(isActionableCandidate);
  if (explicit && !selected) navigationError(404);
  return { selected, explicit, view };
}

export function reviewCandidateLocation(draft, candidateId, view = 'actionable', section = candidateId) {
  return `/offer-imports/${draft.id}?candidate=${candidateId}&view=${view}#${section}`;
}

// Use the snapshot returned by the successful locked save, never browser-supplied next IDs.
export function reviewSuccessLocation(saved, candidateId, operation) {
  const current = saved.candidates.find(c => c.id === candidateId);
  if (operation === 'review' && current.review.decision === 'accepted') {
    return reviewCandidateLocation(saved, candidateId, 'actionable', `${candidateId}-verification`);
  }
  const index = saved.candidates.findIndex(c => c.id === candidateId);
  const ordered = [...saved.candidates.slice(index + 1), ...saved.candidates.slice(0, index)];
  const next = ordered.find(isActionableCandidate);
  if (next) return reviewCandidateLocation(saved, next.id);
  // A lone pending candidate remains visible with an explicit explanation, without a redirect loop.
  if (isActionableCandidate(current)) return reviewCandidateLocation(saved, candidateId);
  return `/offer-imports/${saved.id}?view=all#review-candidate-list`;
}

export function offerImportPages(e) {
  const option = (name, values, current) => `<label>${e({ target: '登録先候補', category: '情報の分類', usage: '利用区分の提案', purpose: '意味区分' }[name])}<select name="${e(name)}">${values.map(v => `<option value="${e(v)}"${v === current ? ' selected' : ''}>${e(labels[v] || v)}</option>`).join('')}</select></label>`;
  const notice = '<p class="notice">AIの登録候補をレビューします。採用は正式案件への反映・公開許可・出典照合済みを意味しません。採用・修正・却下の保存では確認状態を未確認に戻します。出典照合は採用後の別操作です。</p>';
  function list(drafts) {
    return `<section class="card"><h1>取り込み候補レビュー</h1>${notice}${drafts.length ? `<ul>${drafts.map(d => `<li><a href="/offer-imports/${d.id}">${e(d.documents[0].label)}</a> ／ revision ${d.revision} ／ 候補${d.candidates.length}件</li>`).join('')}</ul>` : '<p>取り込み記録はありません。このStepではAI解析・資料入力・正式案件への反映は利用できません。</p>'}</section>`;
  }
  function detail(draft, history, historical = false, navigation = parseReviewNavigation(new URLSearchParams(), draft)) {
    const { selected, explicit, view } = navigation;
    const base = `/offer-imports/${draft.id}${historical ? `/revisions/${draft.revision}` : ''}`;
    const candidateLink = c => `${base}?candidate=${c.id}&view=${view}#${c.id}`;
    const counts = { pending: 0, waiting: 0, checked: 0, rejected: 0 };
    for (const c of draft.candidates) counts[reviewDisplay(c).key]++;
    const completed = counts.checked + counts.rejected;
    const actionable = counts.pending + counts.waiting;
    return `<section class="card import-review"><a href="/offer-imports">← 取り込み一覧</a><h1>登録候補のレビュー</h1>${notice}<p>取り込みID：${e(draft.id)} ／ revision ${draft.revision}</p>
      ${historical ? '<p class="notice">過去版の閲覧です。操作はできません。</p>' : ''}
      <section class="import-progress" aria-labelledby="review-progress-title"><h2 id="review-progress-title">${historical ? 'この過去版のレビュー進捗' : '保存済みレビュー進捗'}</h2>
        <dl><div><dt>全候補数</dt><dd data-review-count="total">${draft.candidates.length}</dd></div><div><dt>レビュー完了数</dt><dd data-review-count="completed">${completed}</dd></div><div><dt>要対応数</dt><dd data-review-count="actionable">${actionable}</dd></div>
        <div><dt>未着手・保留数</dt><dd data-review-count="pending">${counts.pending}</dd></div><div><dt>採用・出典照合待ち数</dt><dd data-review-count="waiting">${counts.waiting}</dd></div><div><dt>採用・出典照合済み数</dt><dd data-review-count="checked">${counts.checked}</dd></div><div><dt>却下数</dt><dd data-review-count="rejected">${counts.rejected}</dd></div></dl>
        <p>レビュー完了は「採用して人間が出典照合済み」または「却下」です。正式案件への反映・公開許可・公開済みを意味しません。未着手と保留はまとめて表示します。</p></section>
      <p>対象：${draft.targetOffer ? `既存案件 ${e(draft.targetOffer.id)} ／ 基準revision ${draft.targetOffer.revision}（現在の存在・状態は未検証）` : '新規案件候補'}</p>
      <details><summary>入力資料の必要部分を確認</summary>${draft.documents.map(d => `<h2>${e(d.label)}</h2><p>提供資料種別：${e(d.kind)} ／ 版：${e(d.versionLabel || '未指定')}</p><pre>${e(d.text)}</pre>`).join('')}</details>

      ${(selected ? [selected] : []).map(c => {
        const p = c.review.edited || c.original;
        const state = reviewDisplay(c);
        const url = `/offer-imports/${draft.id}/candidates/${c.id}`;
        return `<article id="${e(c.id)}" class="import-candidate"><h2 tabindex="-1" data-review-focus>${e(labels[p.target])}：${e(c.id)}</h2><p>${explicit ? '指定候補を表示中' : '最初の要対応候補を表示中'}：${e(c.id)} ／ 全${draft.candidates.length}候補中 ${draft.candidates.indexOf(c) + 1}番目</p><p class="import-saved-state import-state-${state.key}"><span aria-hidden="true">${state.symbol}</span> 保存済み状態：${e(state.label)}</p><p>判断：${e(labels[c.review.decision])} ／ 確認状態：${e(labels[c.review.verification])} ／ 利用区分：${e(labels[p.usage])}</p>
          <p>次の操作：${historical ? '過去版の閲覧のみです。' : state.key === 'waiting' ? '保存済み内容と全根拠を照合し、下の別フォームで記録してください。' : state.key === 'pending' ? '本文と根拠を確認し、採用・保留・却下を保存してください。' : 'レビュー完了です。必要な場合のみ修正を保存してください。'}</p>
          ${!historical && actionable === 1 && state.key === 'pending' ? '<p class="notice">要対応はこの候補だけです。保留保存後もこの候補を表示します。自動で再送や判断は行いません。</p>' : ''}
          <p>AI整理グループ：${e(c.original.conversionKey || 'なし')} ／ 現在の有効グループ：${e(p.conversionKey || 'なし')}（正式成果地点IDではありません）</p><div class="import-columns"><div><h3>有効な候補本文</h3><p class="import-text">${e(p.text)}</p><details><summary>AIの抽出原文（変更しません）</summary><pre>${e(JSON.stringify(c.original, null, 2))}</pre></details></div>
          <div><h3>根拠引用</h3>${p.evidence.map(ref => { const doc = draft.documents.find(d => d.id === ref.documentId); return `<p>${e(doc.label)} ／ ${e(ref.blockId)} ／ 原文位置 ${ref.start}–${ref.end}</p><blockquote class="import-text">${e(ref.quote)}</blockquote>`; }).join('')}<p>引用一致は本文の正しさの保証ではありません。数値・否定・条件・提供元を資料と照合してください。</p></div></div>
          ${historical ? '' : `<form data-candidate-review method="post" action="${url}/review" autocomplete="off"><input type="hidden" name="revision" value="${draft.revision}"><label>修正版本文<textarea name="text" maxlength="5000" rows="3" required>${e(p.text)}</textarea></label>
            <details><summary>分類・利用区分を修正</summary>${option('target', targets, p.target)}${option('category', categories, p.category)}${option('usage', usages, p.usage)}${option('purpose', purposes, p.purpose)}<label>成果地点グループ（正式IDではありません）<input name="conversionKey" maxlength="80" value="${e(p.conversionKey || '')}"></label><p>制約はprohibitedExpressions、訴求ゴールはmarketing_goal、成果条件はconversion_conditionとして区別します。根拠参照はこの画面から変更できません。</p></details>
            <label>レビュー理由（任意）<textarea name="reason" maxlength="1000">${e(c.review.reason)}</textarea></label><p class="import-edit-notice">編集・再保存すると、出典照合状態は未確認に戻ります。上の保存済み状態は保存成功後に更新されます。</p><p data-review-message role="status"></p>
            <button name="decision" value="accepted">採用候補として保存（未確認）</button> <button name="decision" value="pending" class="secondary">修正して保留</button> <button name="decision" value="rejected" class="secondary">却下を保存</button></form>
            ${state.key === 'checked' ? '<p class="import-checked-notice">人間が出典照合済みです。修正する場合は上のフォームで保存し、その後に別操作で出典照合してください。</p>' : c.review.decision === 'accepted' ? `<form method="post" action="${url}/verify" class="import-verification" id="${c.id}-verification" tabindex="-1"><h3>保存済み内容の出典照合</h3><input type="hidden" name="revision" value="${draft.revision}"><p>保存済みの採用候補だけを照合対象にします。上の未保存の修正は含みません。</p><label><input type="checkbox" name="confirm" value="yes" required>保存済み本文・分類・利用区分と全根拠を人間が照合しました</label><button>保存済み採用候補の出典照合を記録</button></form>` : '<p>出典照合を記録するには、先に候補を採用してください。</p>'}`}
          ${c.review.checkedAt ? `<p>個別照合日時：${e(c.review.checkedAt)}</p>` : ''}</article>`;
      }).join('') || (draft.candidates.length ? '<p class="notice" tabindex="-1" data-review-focus>レビュー対象はすべて完了しています。</p>' : '<p tabindex="-1" data-review-focus>候補はありません。</p>')}
      <section id="review-candidate-list" tabindex="-1"><h2>候補一覧</h2><p><a href="${base}?view=actionable#review-candidate-list">要対応を見る</a> ／ <a href="${base}?view=all#review-candidate-list">完了を含むすべてを見る</a></p><nav class="import-candidate-nav" aria-label="候補一覧"><ul>${draft.candidates.filter(c => view === 'all' || actionable === 0 || isActionableCandidate(c)).map(c => {
        const state = reviewDisplay(c);
        return `<li class="import-state-${state.key}"><a href="${e(candidateLink(c))}"${selected?.id === c.id ? ' aria-current="true"' : ''}><span aria-hidden="true">${state.symbol}</span> ${e(c.id)}：${e(labels[(c.review.edited || c.original).target])}<span class="import-nav-state">${e(state.summary)}</span></a></li>`;
      }).join('')}</ul></nav></section>
      <h2>レビュー履歴</h2><ul>${history.map(d => `<li><a href="/offer-imports/${draft.id}/revisions/${d.revision}">revision ${d.revision}</a> ／ ${e(d.updatedAt)}</li>`).join('')}</ul><a href="/offer-imports/${draft.id}">最新版を再読込</a>${historical ? '' : `<p><a href="/offer-imports/${draft.id}/reflection-v2">確認済みの採用候補を正式案件へ反映する内容を確認</a></p><p><a href="/offer-imports/${draft.id}/commits">反映記録・復旧確認</a></p>`}</section>`;
  }
  function failure(status, id = null) {
    const messages = { 400: '入力を検証できません。秘密情報・分類・確認操作を確認してください。', 403: 'このアプリのレビュー画面から操作してください。', 404: '取り込み記録または候補が見つかりません。', 409: '競合・古いrevision・保存ロックを検出しました。自動上書きは行いません。', 413: 'レビュー入力が大きすぎます。', 415: 'フォーム形式の入力が必要です。', 503: '保存状態または履歴を安全に確認できません。保存済みかどうかを再読込で確認してください。' };
    return `<section class="card"><h1>レビューを停止しました</h1><p role="alert">${e(messages[status] || messages[503])}</p><p>送信内容は再表示しません。再送せず、最新版を再読込して保存状態を確認してください。破損履歴や残存ロックは自動修復しません。</p>${id ? `<a href="/offer-imports/${id}">最新版を再読込</a>` : ''}<p><a href="/offer-imports">取り込み一覧へ</a></p></section>`;
  }
  return { list, detail, failure };
}
