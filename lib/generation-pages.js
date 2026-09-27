export function generationPages(e) {
  const yen = value => `¥${Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 3 })}`;
  function usage(summary, config) {
    return `<section class="notice" id="ai-usage"><h2>今月の模擬AI利用</h2><p>実API実行0回・実料金0円。以下はすべてFakeのテスト用計算です。</p>
<p>${e(summary.month)}（UTC月） 模擬概算 ${yen(summary.spentYen)} / 予算 ${yen(config.monthlyBudgetYen)}<br>予約中 ${yen(summary.reservedYen)}（過去月の未解決予約も含む）<br>模擬API実行 ${summary.executionCount}回 / 下書き保存 ${summary.savedCount}件 / 失敗 ${summary.failedCount}件 / 処理中・結果不明 ${summary.unknownCount}件<br>入力 ${summary.inputTokens} / 出力 ${summary.outputTokens}トークン</p>
<p>警告 ${yen(config.warningYen)}・次の予約で${yen(config.stopYen)}超なら停止。1回予約上限 ${yen(config.perRunYen)}。同時生成1件・自動再試行なし。</p>${summary.warning ? '<p role="alert">模擬予算が警告額に達しています。</p>' : ''}</section>`;
  }
  function confirmation(plan, token, summary, config, runs = [], error = '') {
    return `<a class="back" href="/plans/${plan.id}">← 企画へ</a><section class="card detail workflow"><h1>生成前確認</h1>
<p class="notice">Fake AIによる動作確認です。外部送信・課金なし（実料金0円）。対象企画とは無関係の固定の架空文章を返します。</p>
${error ? `<p class="error" role="alert">${e(error)}</p>` : ''}
<h2>対象企画</h2><p>${e(plan.theme)} / ${e(plan.medium)}</p>
<h2>AIへ渡す情報の概要</h2><p>今回は架空の紙工作資料と共通の創作禁止ルールだけをFakeへ渡します。対象企画の内容・ID・既存ドラフトはProviderへ渡しません。保存時にサーバー側でこの企画へ紐付けます。</p>
<p>使用設定：${e(config.profile)} / モデル：${e(config.model)}<br>最大予約額（模擬）：${yen(config.reservationYen)}<br>検査通過は事実確認ではありません。新規下書きは必ず未確認です。</p>
${usage(summary, config)}
<form method="post" action="/plans/${plan.id}/generate" data-generate><input type="hidden" name="token" value="${e(token)}"><input type="hidden" name="confirm" value="yes"><button type="submit">確認してFake AIで生成する（実料金0円）</button><p data-generation-message role="status"></p></form>
<h2>この企画の直近の実行</h2>${runs.length ? `<ul>${runs.map(r => `<li><a href="/generations/${r.id}">${e(r.createdAt)} — ${e(stateLabel(r.state))}</a></li>`).join('')}</ul>` : '<p>まだ実行していません。</p>'}</section>`;
  }
  function stateLabel(state) { return ({ running: '処理中／中断時は結果不明', unknown: '結果不明', failed: '失敗', 'save-failed': '保存失敗', validated: '保存待ち', succeeded: '成功' })[state] || '要確認'; }
  function result(run, summary, config, token) {
    return `<a class="back" href="/plans/${run.planId}">← 企画へ</a><section class="card detail workflow"><h1>Fake AI生成結果</h1><p id="generation-state">${e(stateLabel(run.state))}</p><p>${e(run.message)}</p>
<p>実行ID：${e(run.id)}<br>モデル：${e(run.model)} / 設定：${e(run.profile)}<br>今回の模擬概算：${run.usage ? yen(run.estimatedYen) : '未確定'} / 保持予約：${yen(run.reservedYen)}<br>入力：${run.usage?.inputTokens ?? '不明'} / 出力：${run.usage?.outputTokens ?? '不明'}トークン<br>外部送信なし・実料金0円</p>
${run.draftId ? `<a data-generated-draft href="/drafts/${run.draftId}">生成した下書きを開く</a>` : ''}
${['save-failed', 'validated'].includes(run.state) ? `<form method="post" action="/generations/${run.id}/save"><input type="hidden" name="token" value="${e(token)}"><button>保存だけ再試行する（AI生成は再実行しません）</button></form>` : ''}
${run.state === 'running' ? `<p>実行が終わったら再読み込みしてください。アプリ再起動で中断した記録は再実行せず、予約を保持します。</p><a href="/generations/${run.id}">実行状況を再読み込み</a>` : ''}
${usage(summary, config)}<p><a href="/plans/${run.planId}/generate">生成前確認へ</a></p><p>手動Codex生成は企画画面から引き続き利用できます。</p></section>`;
  }
  return { confirmation, result };
}
