// APIキー・環境変数は一切参照しません。実Provider・実モデルの登録口は未実装。
export const fakeConfig = Object.freeze({
  profile: 'economy', provider: 'fake', model: 'fake-paper-v1', pricingVersion: 'simulation-v1',
  monthlyBudgetYen: 1000, warningYen: 800, stopYen: 900, perRunYen: 20,
  reservationYen: 10, maxInputTokens: 4000, maxOutputTokens: 6000,
  inputYenPerMillion: 1000, outputYenPerMillion: 1000,
  timeoutMs: 5000, maxConcurrent: 1, retries: 0,
});
export function resolveConfig(overrides = {}) {
  const value = { ...fakeConfig, ...overrides };
  if (value.profile !== 'economy' || value.provider !== 'fake' || value.model !== 'fake-paper-v1' || value.maxConcurrent !== 1 || value.retries !== 0) throw new Error('Fake設定以外は利用できません。');
  for (const key of ['monthlyBudgetYen', 'warningYen', 'stopYen', 'perRunYen', 'reservationYen', 'maxInputTokens', 'maxOutputTokens', 'inputYenPerMillion', 'outputYenPerMillion', 'timeoutMs']) {
    if (!Number.isFinite(value[key]) || value[key] <= 0) throw new Error('生成制限の設定が不正です。');
  }
  if (value.warningYen > value.stopYen || value.stopYen > value.monthlyBudgetYen) throw new Error('予算設定が不正です。');
  return Object.freeze(value);
}
