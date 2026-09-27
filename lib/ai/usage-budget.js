import { invalid } from '../content.js';
export const monthKey = date => date.toISOString().slice(0, 7); // UTC月。表示も明示。
export function summarizeUsage(runs, now, config) {
  const month = monthKey(now);
  const current = runs.filter(r => r.month === month);
  const total = key => current.reduce((sum, r) => sum + Math.round((r[key] || 0) * 1000), 0) / 1000;
  const result = { month, spentYen: total('estimatedYen'), reservedYen: runs.reduce((sum, r) => sum + Math.round(r.reservedYen * 1000), 0) / 1000,
    executionCount: current.filter(r => r.attempted).length, savedCount: current.filter(r => r.state === 'succeeded').length,
    inputTokens: current.reduce((n, r) => n + (r.usage?.inputTokens || 0), 0), outputTokens: current.reduce((n, r) => n + (r.usage?.outputTokens || 0), 0),
    unknownCount: runs.filter(r => ['unknown', 'running'].includes(r.state)).length,
    failedCount: current.filter(r => r.state === 'failed' || r.state === 'save-failed').length };
  result.warning = result.spentYen + result.reservedYen >= config.warningYen;
  return result;
}
export function checkBudget(summary, config) {
  const expectedMax = (config.maxInputTokens * config.inputYenPerMillion + config.maxOutputTokens * config.outputYenPerMillion) / 1_000_000;
  if (config.reservationYen < expectedMax) throw invalid('最大使用量を予約額で保護できない設定のため生成できません。');
  if (config.reservationYen > config.perRunYen) throw invalid('1回の予約上限を超えるため生成できません。');
  if (Math.round(summary.spentYen * 1000) + Math.round(summary.reservedYen * 1000) + Math.round(config.reservationYen * 1000) > Math.round(config.stopYen * 1000)) throw invalid('今月の安全停止額を超えるため生成できません。');
}
export function readUsage(value, config) {
  if (!value || !Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens)
      || value.inputTokens < 0 || value.outputTokens < 0 || value.inputTokens > config.maxInputTokens || value.outputTokens > config.maxOutputTokens) return null;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
}
export function estimateYen(usage, config) {
  // 100万分の1円単位の整数で計算し、表示前に丸めて過少計上しない。
  return Math.ceil((usage.inputTokens * config.inputYenPerMillion + usage.outputTokens * config.outputYenPerMillion) / 1000) / 1000;
}
