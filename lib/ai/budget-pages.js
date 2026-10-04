import { safetyError } from './safety-storage.js';
export function parseBudgetActivation(form) {
  const keys = ['confirm', 'revision', 'simulationYen', 'realYen'];
  if (form.size !== keys.length || keys.some(k => form.getAll(k).length !== 1) || [...form.keys()].some(k => !keys.includes(k)) || form.get('confirm') !== 'yes' || form.get('revision') !== '0') throw safetyError('activation_confirmation', 400);
  const amount = text => {
    if (!/^\d{1,10}(?:\.\d{1,3})?$/.test(text)) throw safetyError('invalid_policy', 400);
    const [whole, part = ''] = text.split('.'); const n = BigInt(whole) * 1000n + BigInt(part.padEnd(3, '0'));
    if (n <= 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw safetyError('invalid_policy', 400);
    return Number(n);
  };
  return { schemaVersion: 1, version: 'human-policy-v1', simulationStopMilliYen: amount(form.get('simulationYen')), realStopMilliYen: form.get('realYen') === '' ? null : amount(form.get('realYen')) };
}
export function budgetPage(e, activation, executions = []) {
  return `<h1>共通AI予算・実行状態</h1><p>案件編集・資料入力とは別の管理画面です。記事生成と抽出の共通制御では自動公開、active化、出典照合を行いません。</p>
    <p>有効化記録がない場合、記事生成と抽出の新しいAI実行を停止します。旧経路へ戻りません。結果不明の実行がある場合も両経路を停止し、自動再送・自動修復しません。</p>
    ${activation ? `<h2>共通予算：明示有効化済み</h2><p>policy：${e(activation.policy.version)} / revision ${e(activation.revision)}</p><p>日時：${e(activation.activatedAt)}</p><p>実費枠（円）：${e(activation.policy.realStopMilliYen === null ? '無効' : activation.policy.realStopMilliYen / 1000)}／模擬費用枠（円）：${e(activation.policy.simulationStopMilliYen / 1000)}</p><p>既存記録の費用・予約を引き継いでいます。このStepではpolicy変更・再有効化は行いません。</p>` : `<h2>共通予算：未有効化または安全に確認できないため停止</h2>
    <p>以下は既存台帳を検査して共通予算を有効化する書込み操作です。既存費用をゼロにせず引き継ぎます。未知・未完了・破損・部分保存があれば停止します。既存記録は削除しません。</p>
    <form method="post" action="/maintenance/ai-budget/activate"><input type="hidden" name="revision" value="0">
      <label>模擬費用の月次停止額（円、必須）<input name="simulationYen" inputmode="decimal" required></label>
      <label>実費の月次停止額（円、空欄なら実API実行を許可しない）<input name="realYen" inputmode="decimal"></label>
      <p>模擬費用と実費は別集計です。ここでは実API単価・為替を設定しません。抽出はfake専用です。</p>
      <label><input type="checkbox" name="confirm" value="yes" required> 既存費用の引継ぎと共通予算の有効化を確認しました</label><button type="submit">確認した共通予算を有効にする</button></form>`}
    <h2>抽出execution状態</h2><p>sendingは送信した可能性がある状態です。再起動後も未送信とは扱いません。引用一致・保存完了は人間の出典確認とは別です。</p>
    <ul>${executions.map(r => `<li>execution ${e(r.id)}：${e(r.state)}／revision ${e(r.revision)}${['sending', 'response_received', 'validated', 'import_saving', 'unknown', 'recovery_required', 'import_save_failed'].includes(r.state) ? '（停止・人間確認必須）' : ''}</li>`).join('') || '<li>実行記録なし、または安全に取得できません。</li>'}</ul><a href="/maintenance/integrity">全データの整合性を確認する</a><p>復元dry-runは現在のデータを変更しません。実際の復元機能はありません。</p>`;
}
