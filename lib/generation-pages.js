export function affiliateEvidence(value, e, generated = true) {
  return `<section data-affiliate-context><h2>${generated ? '生成に使用した案件の根拠' : 'AIへ送信する案件情報'}</h2><dl>
<div><dt>案件名</dt><dd>${e(value.offerName)}</dd></div><div><dt>成果地点名</dt><dd>${e(value.conversionName)}</dd></div>
<div><dt>offer revision</dt><dd>${e(value.offerRevision)}</dd></div><div><dt>選択理由（AIには送信しません）</dt><dd>${e(value.selectionReason || '未入力')}</dd></div>
<div><dt>案件コンテキストhash</dt><dd>${e(value.contextHash)}</dd></div></dl>
<details><summary>${generated ? '生成時に送信した案件情報の全項目' : '送信する案件情報の全項目'}</summary><pre>${e(JSON.stringify(value.snapshot, null, 2))}</pre></details></section>`;
}

export function generationPages(e) {
  const yen = value => `¥${Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 3 })}`;
  const live = config => config.provider === 'openai';
  function usage(summary, config) {
    const actual = live(config);
    return `<section class="notice" id="ai-usage"><h2>${actual ? '今月の概算API利用' : '今月の模擬AI利用'}</h2><p>${actual ? '円換算の概算です。実請求額ではありません。OpenAI側の利用状況・予算制限も併用してください。' : 'Fake Providerのみ。実API実行0回・実料金0円です。'}</p>
<p>${e(summary.month)}（UTC月） ${actual ? '概算' : '模擬概算'} ${yen(summary.spentYen)} / 予算 ${yen(config.monthlyBudgetYen)}<br>予約中 ${yen(summary.reservedYen)}（過去月の未解決予約も含む）<br>API実行 ${summary.executionCount}回 / 下書き保存 ${summary.savedCount}件 / 失敗 ${summary.failedCount}件 / 処理中・結果不明 ${summary.unknownCount}件<br>入力 ${summary.inputTokens} / 出力 ${summary.outputTokens}トークン</p>
<p>警告 ${yen(config.warningYen)}・次の予約で${yen(config.stopYen)}超なら停止。1回予約上限 ${yen(config.perRunYen)}。同時生成1件・自動再試行なし。</p>${summary.warning ? `<p role="alert">${actual ? '概算予算' : '模擬予算'}が警告額に達しています。</p>` : ''}</section>`;
  }
  function confirmation(plan, token, summary, config, runs = [], error = '', ready = true, affiliate = null) {
    const actual = live(config);
    const submitted = actual ? `<dl><div><dt>テーマ</dt><dd>${e(plan.theme || '')}</dd></div><div><dt>読者</dt><dd>${e(plan.audience || '未入力')}</dd></div><div><dt>媒体</dt><dd>${e(plan.medium || '')}</dd></div><div><dt>目的</dt><dd>${e(plan.purpose || '未入力')}</dd></div><div><dt>メモ</dt><dd>${e(plan.notes || '未入力')}</dd></div></dl>` : '';
    return `<a class="back" href="/plans/${plan.id}">← 企画へ</a><section class="card detail workflow"><h1>生成前確認</h1>
<p class="notice">${actual ? 'OpenAI APIへ企画情報を送信して下書きを生成します。利用料金が発生します。' : 'Fake AIによる動作確認です。外部送信・課金なし（実料金0円）。対象企画とは無関係の固定の架空文章を返します。'}</p>
${error ? `<p class="error" role="alert">${e(error)}</p>` : ''}<h2>対象企画</h2><p>${e(plan.theme)} / ${e(plan.medium)}</p>
<h2>AIへ渡す情報${actual ? '' : 'の概要'}</h2><p>${actual ? '以下の企画情報と事実を創作しないための指示を送信します。企画IDや既存ドラフトは送信しません。' : '架空の紙工作資料と共通の創作禁止ルールだけを使います。'}</p>${submitted}
${affiliate ? `${affiliateEvidence(affiliate.affiliateContext, e, false)}<p data-current-offer-status>現在の案件status：${e(affiliate.currentStatus)} ／ 現在の案件 revision ${e(affiliate.currentRevision)}</p>
<p class="notice">固定したrevisionの情報を使用します。公開用の確認済み本文・対象読者・訴求・選択成果地点の公開条件・CTA・広告明示と、生成を制限する禁止表現を送信します。案件から抽出する情報には報酬・内部情報・未確認情報・URLを含めません。公開できない条件の省略は「条件なし」を意味しません。</p>
${affiliate.blockedReason ? `<p class="error" role="alert">${e(affiliate.blockedReason)}</p>` : ''}` : ''}
<p>使用設定：${e(config.profile)} / モデル：${e(config.model)}<br>最大予約額：${yen(config.reservationYen)}<br>検査通過は事実確認ではありません。新規下書きは必ず未確認です。</p>${usage(summary, config)}
${!ready ? '<p class="error" role="alert">OpenAI APIキーがサーバーに設定されていません。ターミナルで設定を確認してください。</p>' : ''}
${affiliate?.blockedReason ? '' : `<form method="post" action="/plans/${plan.id}/generate" data-generate><input type="hidden" name="token" value="${e(token)}"><input type="hidden" name="confirm" value="yes"><button type="submit"${ready ? '' : ' disabled'}>${actual ? '確認してOpenAI APIで生成する' : '確認してFake AIで生成する（実料金0円）'}</button><p data-generation-message role="status"></p></form>`}
<h2>この企画の直近の実行</h2>${runs.length ? `<ul>${runs.map(r => `<li><a href="/generations/${r.id}">${e(r.createdAt)} — ${e(stateLabel(r.state))}</a></li>`).join('')}</ul>` : '<p>まだ実行していません。</p>'}</section>`;
  }
  function stateLabel(state) { return ({ running: '処理中／中断時は結果不明', unknown: '結果不明', failed: '失敗', 'save-failed': '保存失敗', validated: '保存待ち', succeeded: '成功' })[state] || '要確認'; }
  function result(run, summary, config, token) {
    const actual = run.provider === 'openai';
    return `<a class="back" href="/plans/${run.planId}">← 企画へ</a><section class="card detail workflow"><h1>${actual ? 'OpenAI API' : 'Fake AI'}生成結果</h1><p id="generation-state">${e(stateLabel(run.state))}</p><p>${e(run.message)}</p>${run.validationCode ? `<p id="validation-diagnostic">検証項目：${e(run.validationCode)}</p>` : ''}
<p>実行ID：${e(run.id)}<br>モデル：${e(run.model)} / 設定：${e(run.profile)}<br>今回の${actual ? '概算' : '模擬概算'}：${run.usage ? yen(run.estimatedYen) : '未確定'} / 保持予約：${yen(run.reservedYen)}<br>入力：${run.usage?.inputTokens ?? '不明'} / 出力：${run.usage?.outputTokens ?? '不明'}トークン<br>${actual ? '実請求額はOpenAIの利用明細で確認してください。' : '外部送信なし・実料金0円'}</p>
${run.draftId ? `<a data-generated-draft href="/drafts/${run.draftId}">生成した下書きを開く</a>` : ''}
${['save-failed', 'validated'].includes(run.state) ? `<form method="post" action="/generations/${run.id}/save"><input type="hidden" name="token" value="${e(token)}"><button>保存だけ再試行する（AI生成は再実行しません）</button></form>` : ''}
${run.state === 'running' ? `<p>実行が終わったら再読み込みしてください。アプリ再起動で中断した記録は再実行せず、予約を保持します。</p><a href="/generations/${run.id}">実行状況を再読み込み</a>` : ''}
${usage(summary, config)}<p><a href="/plans/${run.planId}/generate">生成前確認へ</a></p><p>手動Codex生成は企画画面から引き続き利用できます。</p></section>`;
  }
  return { confirmation, result };
}
