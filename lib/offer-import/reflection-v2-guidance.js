// Presentation only; server policy remains authoritative. Never rewrites a choice.
export function reflectionV2ChoiceGuidance(choice) {
  const count = choice.conversionIds.length;
  if (choice.commonConfirmed && (count < 2 || ['none', 'offer'].includes(choice.mode))) return {
    status: 'invalid', message: '共通適用確認と反映判断・選択数が一致しません。単一地点では共通確認は不要です。チェックを人間が解除するまで停止します。' };
  if (!choice.mode) return { status: 'incomplete', message: count ? `反映判断（mode）未選択：地点${count}件は選択済みですが、未完了です。反映判断を人間が選択してください。` : '反映判断（mode）未選択：未完了です。' };
  if (choice.mode === 'conversions') {
    if (!count) return { status: 'incomplete', message: '成果地点未選択：反映先を人間が選択してください。' };
    if (count > 1 && !choice.commonConfirmed) return { status: 'incomplete', message: `地点${count}件を選択済み：複数地点への共通適用確認が未完了です。` };
    return { status: 'complete', message: count === 1 ? '地点1件を選択済み：単一地点では共通確認は不要です。入力完了（正式反映・承認ではありません）。' : `地点${count}件への共通適用を確認済み。入力完了（正式反映・承認ではありません）。` };
  }
  if (choice.mode === 'none' && !choice.reason.trim()) return { status: 'incomplete', message: '反映なし理由が未入力：未完了です。' };
  if (choice.conversionIds.length) return { status: 'invalid', message: '反映判断と地点選択が一致しません。選択を人間が見直すまで停止します。' };
  return { status: 'complete', message: '対応判断の入力完了（正式反映・承認ではありません）。' };
}
