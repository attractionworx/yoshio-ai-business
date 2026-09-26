import { improvementOptions, defaultImprovements, improvementSummary, factRule } from './improvements.js';
import { buildPrompt, contentFields, PROMPT_VERSION } from './content.js';
export function draftPages({ escapeHtml: e, formatDate: date }) {
  function workflow(plan, drafts, raw = '', error = '') {
    return `<section class="card detail workflow"><h2>1. Codexへの依頼文</h2>
<p>依頼文をコピーしてCodexに貼り付けてください。生成後、回答のJSONを下の欄へ貼り付けます。</p>
<p class="hint">このアプリから外部AIへ送信しません。Codexへ渡す前に秘密情報がないか確認してください。</p>
<label for="prompt">生成依頼文（${PROMPT_VERSION}）</label><textarea id="prompt" readonly rows="10">${e(buildPrompt(plan))}</textarea>
<button type="button" data-copy="prompt">依頼文をコピー</button><p id="copy-message" role="status"></p>
<h2>2. 生成結果を取り込む</h2><p>取り込むたびに新しい下書きを作成します。以前の下書きは残ります。前後の説明文やコードブロックが付いた回答も貼り付けられます。折り返しの補正が必要な場合は保存前に確認画面が表示されます。</p>
${error ? `<p class="error" role="alert">${e(error)}</p>` : ''}
<form method="post" action="/plans/${plan.id}/drafts"><label for="result">Codexの回答（JSON）</label>
<textarea id="result" name="result" rows="12" required maxlength="400000">${e(raw)}</textarea><button type="submit">新しい下書きとして取り込む</button></form>
<h2>過去の下書き（${drafts.length}件）</h2>${drafts.length ? `<ul>${drafts.map(d => `<li><a href="/drafts/${d.id}">v${d.versionNumber} · ${date(d.importedAt)} — ${e(d.status)}${d.id === drafts[0].id ? "（最新）" : ""}</a><p class="hint">${e(d.edited.titles[0])}</p></li>`).join('')}</ul>` : '<p>まだ下書きはありません。</p>'}</section>`;
  }
  function importPreview(plan, parsed, raw, request = null) {
    return `<a class="back" href="/plans/${plan.id}">← 企画へ（取り込まずに戻る）</a>
<section class="card detail"><h1>折り返しを整えた内容の確認</h1>
<p class="notice">まだ保存していません。文字列の途中に入った実際の改行と、その直後の字下げを${parsed.normalization.count}か所取り除きました。JSONの\\nで指定された段落は残しています。単語の間の空白や段落が意図どおりか確認してください。</p>
<dl>${contentFields.map(([key, label]) => `<div><dt>${label}</dt><dd>${e(Array.isArray(parsed.content[key]) ? parsed.content[key].join('\n') : parsed.content[key])}</dd></div>`).join('')}</dl>
<form method="post" action="${request ? `/improvements/${request.id}` : `/plans/${plan.id}/drafts`}"><textarea name="result" hidden>${e(raw)}</textarea>
<button type="submit" name="confirmWrap" value="yes">内容を確認して新しい下書きとして取り込む</button></form>
<details><summary>貼り付けた文章を確認する</summary><pre>${e(raw)}</pre></details></section>`;
  }
  function editor(draft, values = draft.edited, error = '', revision = draft.revision, history = [], plan = draft.inputSnapshot) {
    return `<a class="back" href="/plans/${draft.planId}">← 企画・過去の下書きへ</a><article class="card detail">
<h1>下書きの確認・編集</h1><h2>記事情報</h2><p>${e(plan.theme)} · ${e(plan.medium)} · v${history.find(d => d.id === draft.id)?.versionNumber || draft.versionNumber || 1}</p><p class="hint">対象読者：${e(plan.audience || "未入力")}<br>目的：${e(plan.purpose || "未入力")}</p>${draft.parentDraftId ? `<p>元の下書き：<a href="/drafts/${draft.parentDraftId}">親ドラフトを開く</a></p>` : ""}<p>状態：<strong id="draft-status">${e(draft.status)}</strong></p>
<p class="hint">生成日時：${draft.generatedAt ? date(draft.generatedAt) + '（生成結果の申告値）' : '不明（Codexから日時の指定なし）'}<br>
取り込み日時：${date(draft.importedAt)}<br>生成方法：Codex手動取り込み（${e(draft.generationMethod)}）<br>プロンプト：${e(draft.promptVersion)}<br>最終保存：${date(draft.updatedAt)}</p>
<p class="notice">事実・表現・リンクを確認してください。変更した文章は先に保存し、読み直してから「確認済みにする」を押してください。編集すると確認済みは解除されます。</p>
${error ? `<p class="error" role="alert">${e(error)}</p>` : ''}
<h2>下書き確認／編集</h2><form method="post" action="/drafts/${draft.id}" data-editor>
<input type="hidden" name="revision" value="${e(revision)}">
${contentFields.map(([key, label]) => `<div class="field"><label for="${key}">${label}${key === 'titles' ? '（1行に1個、5行）' : ''}</label><textarea id="${key}" name="${key}" rows="${key === 'body' ? 16 : 5}" required maxlength="${key === 'titles' ? 2504 : 50000}">${e(Array.isArray(values[key]) ? values[key].join('\n') : values[key])}</textarea></div>`).join('')}
<h2>保存／確認済み</h2><p id="edit-message" role="status"></p><button name="action" value="save">編集内容を保存</button>
<button name="action" value="review" data-review>確認済みにする</button></form>
${draft.importNormalization ? '<p class="notice">この下書きはコピー時の折り返しを整え、確認後に取り込んだものです。</p>' : ''}
<details><summary>貼り付け時の回答全文を見る</summary><pre>${e(draft.originalRaw)}</pre></details>
<details><summary>AIが生成した原文を見る（編集されません）</summary>
<dl>${contentFields.map(([key, label]) => `<div><dt>${label}</dt><dd>${e(Array.isArray(draft.original[key]) ? draft.original[key].join('\n') : draft.original[key])}</dd></div>`).join('')}</dl></details>
<details><summary>生成時の依頼文を見る</summary><pre>${e(draft.prompt)}</pre></details></article>${improveForm(draft)}${versionHistory(history, draft.id)}`;
  }
  function versionHistory(drafts, currentId) {
    return `<section class="card detail workflow" id="version-history"><h2>バージョン履歴</h2><ul class="plan-list">${drafts.map((d, i) => `<li><a href="/drafts/${d.id}" ${d.id === currentId ? 'aria-current="page"' : ''}>v${d.versionNumber} · ${e(d.status)}${i === 0 ? '（最新バージョン）' : ''}${d.id === currentId ? '（表示中）' : ''}</a><p>${date(d.importedAt)}</p><p class="hint">${e(d.improvement ? improvementSummary(d.improvement.settings) : '初回生成・再生成（改善情報なし）')}</p></li>`).join('')}</ul></section>`;
  }
  function improveForm(draft) {
    return `<section class="card detail workflow"><h2>AIで下書きを改善</h2>
<p>保存済みの下書きから、読みやすさ・初心者への分かりやすさ・具体性を高める依頼文を作ります。編集中の場合は先に保存してください。</p>
<form method="post" action="/drafts/${draft.id}/improve" data-improve>
<input type="hidden" name="revision" value="${draft.revision}">
<details><summary>詳細設定</summary><fieldset><legend>改善方針</legend>${improvementOptions.map(([key, label]) => `<label class="choice"><input type="checkbox" name="options" value="${key}" ${defaultImprovements.includes(key) ? 'checked' : ''}>${label}</label>`).join('')}</fieldset>
<fieldset><legend>改善方法</legend><label class="choice"><input type="radio" name="mode" value="rewrite" checked>完成稿を作る</label><label class="choice"><input type="radio" name="mode" value="analysis">まず分析だけする</label></fieldset>
<label for="instructions">その他の改善指示</label><textarea id="instructions" name="instructions" maxlength="5000" rows="4"></textarea></details>
<p class="hint">実体験・収益・経歴・成功実績などの創作禁止ルールは常に適用されます。</p>
<button type="submit">改善依頼文を作る</button></form></section>`;
  }
  function improvementPage(request, raw = '', error = '') {
    return `<a class="back" href="/drafts/${request.parentDraftId}">← 元の下書きへ</a><section class="card detail workflow"><h1>AIで下書きを改善</h1><p>${e(request.planSnapshot.theme)}</p><p>${e(improvementSummary(request.settings))}</p><p class="hint">依頼作成：${date(request.createdAt)} · 元の下書きの保存リビジョン：${request.parentRevision}</p>
<label for="prompt">Codex用改善依頼文</label><textarea id="prompt" readonly rows="14">${e(request.prompt)}</textarea><button type="button" data-copy="prompt">Codex用依頼文をコピー</button><p id="copy-message" role="status"></p>
<details><summary>固定ルール（解除不可）</summary><p>${e(factRule)}</p></details>
${request.settings.mode === 'analysis' ? '<p class="notice">分析結果は取り込みません。検討後、元の下書きの詳細設定で「完成稿を作る」を選び、分析を「その他の改善指示」に反映して依頼文を作ってください。</p>' : `<h2>改稿を取り込む</h2><p>この依頼に対するCodexの回答（JSON）を貼り付けてください。改稿は未確認の新しいバージョンとして保存します。元の下書きは保持されます。</p>${error ? `<p class="error" role="alert">${e(error)}</p>` : ''}<form method="post" action="/improvements/${request.id}"><label for="result">改善後の記事（JSON）</label><textarea id="result" name="result" rows="12" required maxlength="400000">${e(raw)}</textarea><button type="submit">改稿を取り込む</button></form>`}</section>`;
  }
  return { workflow, editor, importPreview, improvementPage };
}
