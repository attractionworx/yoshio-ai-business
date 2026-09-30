import { humanChecks, publicationData } from './publish.js';
import { affiliateHumanChecks, findingDescriptions, validationFingerprint, savedAffiliateConfirmation, affiliatePublicationIsCurrent } from './affiliate-publication.js';
import { affiliateValidationState } from './affiliate-validation-lifecycle.js';
import { contentFields } from './content.js';

function affiliateChecks(draft, e) {
  if (!draft.affiliateContext) return '';
  const summary = affiliateValidationState(draft);
  const fingerprint = validationFingerprint(draft);
  const saved = savedAffiliateConfirmation(draft);
  const labels = { current: '検査済み（機械検査のみ）', stale: '再検査が必要', invalid: '検査結果が不正', failed: '検査失敗', unvalidated: '未検査' };
  if (!fingerprint) return `<section data-affiliate-publish data-validation-state="${e(summary.state)}"><h2>案件の公開前確認</h2><p>${labels[summary.state] || '検査を確認できません'}</p><p>有効な件数は未確定です。公開準備OKにはできません。<a href="/drafts/${draft.id}">下書きで再検査してください。</a></p></section>`;
  const blocks = draft.affiliateValidation.findings.filter(f => f.severity === 'block');
  const warnings = draft.affiliateValidation.findings.filter(f => f.severity === 'warning');
  const location = f => `${Object.fromEntries(contentFields)[f.field] || '7項目全体'}${f.titleIndex === undefined ? '' : `（候補${f.titleIndex + 1}）`}${f.location ? `／文字位置${f.location.start + 1}〜${f.location.end}` : ''}`;
  return `<section data-affiliate-publish data-validation-state="current"><h2>案件の公開前確認</h2>
<p>${labels.current} ／ block：${summary.counts.block} ／ warning：${summary.counts.warning} ／ info：${summary.counts.info}</p>
<p class="hint">機械検査の通過やinfoは真実性を保証しません。下書きの固定案件根拠と7項目を照合してください。疑義があれば本文を修正して再検査してください。</p>
<input type="hidden" name="validationFingerprint" value="${fingerprint}">
${blocks.length ? `<p class="error" data-affiliate-block>blockがあるため公開準備OKにできません。チェックでは解除できません。</p><ul>${blocks.map(f => `<li>${e(location(f))}：${e(findingDescriptions[f.code])}</li>`).join('')}</ul>` : ''}
<fieldset data-affiliate-required><legend>案件に関する必須確認（検出ゼロでも必要）</legend>${affiliateHumanChecks.map(([key, label]) => `<label class="choice"><input type="checkbox" name="${key}" value="yes"${saved?.requiredChecks[key] ? ' checked' : ''}>${label}</label>`).join('')}</fieldset>
<fieldset data-affiliate-warnings><legend>warningの個別確認（${warnings.length}件）</legend>${warnings.map(f => `<label class="choice"><input type="checkbox" name="warning.${f.id}" value="yes"${saved?.warningResolutions.some(r => r.findingId === f.id) ? ' checked' : ''}><span>${e(location(f))}：${e(findingDescriptions[f.code])}<br>この検出について人間が確認した</span></label>`).join('') || '<p>個別確認が必要なwarningはありません。</p>'}</fieldset>
<p><a href="/drafts/${draft.id}">下書き・固定案件根拠を確認する</a></p></section>`;
}

export function publishPage(draft, e, error = '') {
  const back = `<a class="back" href="/drafts/${draft.id}">← 下書きの確認・編集へ</a>`;
  if (draft.status !== '確認済み') return `${back}<section class="card detail"><h1>公開準備</h1><p>公開準備をするには、先に下書きを確認済みにしてください。</p></section>`;
  const prep = affiliatePublicationIsCurrent(draft) ? draft.publication : undefined;
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
${affiliateChecks(draft, e)}
<button name="action" value="check">タイトル・確認項目を保存して公開前チェック</button>
<button name="action" value="ready">公開準備OKにする</button><p id="publish-change" role="status"></p></form>
<h2>公開前チェック</h2><p id="preflight-result">${prep ? prep.findings.length ? '要確認' : '問題なし（機械的な検査のみ）' : '未チェック'}</p>
${prep?.findings.length ? `<ul>${prep.findings.map(f => `<li>${e(f.label)}：${e(f.reason)}</li>`).join('')}</ul>` : ''}
${prep?.missing.length ? `<ul>${prep.missing.map(message => `<li>${e(message)}</li>`).join('')}</ul>` : ''}
<p class="hint">タイトル・確認項目を変更したら保存してください。本文・CTA・SNS告知文などを編集保存すると、公開準備は未チェックに戻ります。</p>
<h2>公開用プレビュー（保存済み）</h2><p>選択したタイトル・本文・CTA・SNS告知文を確認できます。コピーは公開準備OKのときに利用できます。</p>
<div data-publish-preview>${fields.map(([key, label]) => `<div class="field"><label for="publish-${key}">${label}</label><textarea id="publish-${key}" readonly rows="${key === 'body' || key === 'bodyWithCta' ? 12 : 3}">${e(data[key])}</textarea>${key !== 'cta' ? `<button type="button" data-publication-copy="publish-${key}"${!error && prep?.status === '公開準備OK' ? '' : ' disabled'}>${label}をコピー</button><p id="publish-${key}-message" role="status"></p>` : ''}</div>`).join('')}</div></section>`;
}
