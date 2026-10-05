import { maintenanceError } from './snapshot.js';
const labels = { normal: '正常', warning: 'warning（注意）', error: 'error（異常）', human_review_required: 'human review required（人間確認必須）' };
const recoveries = { normal: '正常', recoverable: '復旧可能性あり：既存監査画面で人間による確認が必要', human_required: '人間確認必須：判定不能な状態は停止' };
export function parseMaintenanceForm(form, operation) {
  const expected = operation === 'backup' ? ['confirm'] : ['backupId'];
  if (form.size !== expected.length || expected.some(k => form.getAll(k).length !== 1) || [...form.keys()].some(k => !expected.includes(k))
    || (operation === 'backup' && form.get('confirm') !== 'yes')) throw maintenanceError(400);
  return form.get('backupId');
}
export function maintenancePages(e) {
  const introduction = `<h1>データ保全管理</h1><p>案件編集とは別の管理画面です。自動公開・active化・履歴削除・自動修復は行いません。</p>
    <p><strong>復元dry-runは、復元可能性を検証するだけで、現在のデータは変更しません。</strong>実際に上書き・巻戻しする機能はありません。検証を「復元済み」と記録しません。</p>`;
  function report(r) {
    return `<section><p>${r.aiCoverage === 'complete' ? 'AI実行・共通予算情報を含むv2対象です。' : '旧範囲の検査です。新しいAI実行・共通予算の有効化を保証しません。'}</p><p>限定real承認記録：${e({ valid: '元activationと照合済み', absent: '含まれていません（追加承認なし）', invalid: '不整合・停止', not_covered: '旧範囲・保全対象外' }[r.realBudgetApprovalStatus] || '保全を確認していません')}</p><h2>検査結果：${e(labels[r.status] || '検証失敗')}</h2><p>${e(recoveries[r.recovery] || '')}</p>
      ${r.stopped ? '<p role="alert"><strong>停止：自動修復・上書き・再実行は行いません。人間が状態を確認してください。</strong></p>' : '<p>検査は読み取り専用です。公開許可・出典照合・案件のactive化を意味しません。</p>'}
      <ul>${(r.issues || []).map(i => `<li>${e(labels[i.status])}：${e(i.message)}${i.file ? `（${e(i.file)}）` : ''}</li>`).join('')}</ul>
      ${r.metrics ? `<dl>${Object.entries(r.metrics).map(([k, v]) => `<dt>${e({ files: 'ファイル件数', bytes: '概算容量（bytes）', offers: '案件件数', offerRevisions: '案件revision件数', imports: '取り込み件数', importRevisions: '取り込みrevision件数', commitEvents: '監査イベント件数', generationRuns: '記事生成実行件数', extractionExecutions: '抽出実行件数', executionRevisions: '抽出実行revision件数', artifacts: '固定artifact件数', inspectionMs: '検証時間（ms）' }[k] || k)}</dt><dd>${e(v)}</dd>`).join('')}</dl>` : ''}</section>`;
  }
  return {
    home(list) {
      return introduction + `<p><a href="/maintenance/ai-budget">共通AI予算・抽出実行状態を確認する</a></p><section><h2>整合性確認</h2><p>案件・取り込み・commit監査と、存在するAI台帳・固定artifact・予算有効化記録の全履歴と参照関係を読み取り専用で検査します。</p><a class="button" href="/maintenance/integrity">現在のデータを検査する</a></section>
      <section><h2>バックアップ作成</h2><p>案件本体・全履歴、取り込み本体・全履歴、intent/result監査と、存在するAI実行・固定artifact・予算有効化記録を一つのバックアップに保存します。既存のrevisionや履歴は変更しません。保存中は更新を停止し、競合・失敗時は完全なバックアップとして扱いません。</p>
      <form method="post" action="/maintenance/backups"><label><input type="checkbox" name="confirm" value="yes" required> 対象データ一式のバックアップを作成することを確認しました</label><button type="submit">バックアップを作成する</button></form></section>
      <section><h2>バックアップ検証（復元dry-run）</h2><p>保存先はこのアプリの専用領域だけです。任意のパスやファイルは指定できません。</p>
      ${list.incomplete ? `<p role="alert">未完了または確認が必要な項目：${e(list.incomplete)}件。完全なバックアップとして利用しません。自動削除は行いません。</p>` : ''}
      ${list.backups.map(b => `<form method="post" action="/maintenance/dry-run"><p>バックアップID：${e(b.id)}${b.invalid ? '（異常：人間確認必須）' : ''}</p><input type="hidden" name="backupId" value="${e(b.id)}"><button type="submit">復元dry-runを実行する（変更なし）</button></form>`).join('') || '<p>バックアップはまだありません。</p>'}</section>`;
    },
    integrity(r) { return introduction + report(r) + '<p><a href="/offer-imports">既存の候補レビュー・監査復旧画面を確認する</a></p><a href="/maintenance">管理画面へ戻る</a>'; },
    created(value) { return introduction + `<h2>バックアップ作成完了</h2><p>ID：${e(value.manifest.id)}</p><p>作成日時：${e(value.manifest.createdAt)}</p><p>manifest version：${e(value.manifest.schemaVersion)}</p><p>コピーの完了と元データの正常性は別概念です。異常がある場合は下記結果に従って停止してください。</p>` + report(value.report) + '<a href="/maintenance">管理画面から復元dry-runで検証する</a>'; },
    dryRun(value) { return introduction + `<h2>復元dry-run結果：${e(labels[value.status])}</h2><p>バックアップ検証：${value.backupValid ? 'manifest・hash検証済み' : '検証失敗'}</p><p>既存データへの書込み：なし。復元済み記録：なし。</p>
      ${value.stopped ? '<p role="alert"><strong>停止：異常または確認事項があります。復元・自動修復は行いません。</strong></p>' : ''}
      <ul>${value.warnings.map(w => `<li>${e(w.message)}</li>`).join('')}</ul><h2>バックアップ内の検査</h2>` + report(value.report)
      + (value.current?.stopped ? '<h2>現在のデータの確認事項</h2>' + report(value.current) : '') + '<a href="/maintenance">管理画面へ戻る</a>'; },
    failure() { return introduction + '<h2>管理操作を停止しました</h2><p role="alert">入力・競合・保存失敗・読み取り失敗を安全に扱うため停止しました。未完了の保存は完全なバックアップとして扱いません。元データを変更せず、再読込して状態を人間が確認してください。自動再試行は行いません。</p><a href="/maintenance">管理画面を再読込する</a>'; },
  };
}
