import { humanChecks, publicationData } from './publish.js';

export function publishPage(draft, e, error = '') {
  const back = `<a class="back" href="/drafts/${draft.id}">← 下書きの確認・編集へ</a>`;
  if (draft.status !== '確認済み') return `${back}<section class="card detail"><h1>公開準備</h1><p>公開準備をするには、先に下書きを確認済みにしてください。</p></section>`;
  const prep = draft.publication;
  const data = publicationData(draft, prep?.titleIndex ?? null);
  const fields = [['title', 'タイトル'], ['body', 'note本文'], ['cta', 'CTA'], ['bodyWithCta', 'CTA込み本文'], ['social', 'SNS告知文']];
  return `${back}<section class="card detail workflow"><h1>公開準備</h1>
<p>下書き：確認済み ／ 公開準備：<strong id="publish-status">${e(error ? '未チェック（保存エラー）' : prep?.status || '未チェック')}</strong></p>
<p>公開前チェックは明らかな仮記述を探します。内容の正しさやリンク先は、人間が確認してください。投稿は行いません。</p>
${error ? `<p class="error" role="alert">操作は保存されていません。${e(error)}</p>` : ''}
<form method="post" action="/drafts/${draft.id}/publish" data-publish>
<input type="hidden" name="revision" value="${draft.revision}">
<label for="titleIndex">公開するタイトル</label><select name="titleIndex" id="titleIndex"><option value="">選択してください</option>${draft.edited.titles.map((title, i) => `<option value="${i}"${prep?.titleIndex === i ? ' selected' : ''}>${e(title)}</option>`).join('')}</select>
<fieldset><legend>人間による最終確認</legend>${humanChecks.map(([key, label]) => `<label class="choice"><input type="checkbox" name="${key}" value="yes"${prep?.confirmations[key] ? ' checked' : ''}>${e(label)}</label>`).join('')}</fieldset>
<button name="action" value="check">タイトル・確認項目を保存して公開前チェック</button>
<button name="action" value="ready">公開準備OKにする</button><p id="publish-change" role="status"></p></form>
<h2>公開前チェック</h2><p id="preflight-result">${prep ? prep.findings.length ? '要確認' : '問題なし（機械的な検査のみ）' : '未チェック'}</p>
${prep?.findings.length ? `<ul>${prep.findings.map(f => `<li>${e(f.label)}：${e(f.reason)}</li>`).join('')}</ul>` : ''}
${prep?.missing.length ? `<ul>${prep.missing.map(message => `<li>${e(message)}</li>`).join('')}</ul>` : ''}
<p class="hint">タイトル・確認項目を変更したら保存してください。本文・CTA・SNS告知文などを編集保存すると、公開準備は未チェックに戻ります。</p>
<h2>公開用プレビュー（保存済み）</h2><p>選択したタイトル・本文・CTA・SNS告知文を確認できます。コピーは公開準備OKのときに利用できます。</p>
<div data-publish-preview>${fields.map(([key, label]) => `<div class="field"><label for="publish-${key}">${label}</label><textarea id="publish-${key}" readonly rows="${key === 'body' || key === 'bodyWithCta' ? 12 : 3}">${e(data[key])}</textarea>${key !== 'cta' ? `<button type="button" data-publication-copy="publish-${key}"${!error && prep?.status === '公開準備OK' ? '' : ' disabled'}>${label}をコピー</button><p id="publish-${key}-message" role="status"></p>` : ''}</div>`).join('')}</div></section>`;
}
